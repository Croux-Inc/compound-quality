#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");

const REQUIRED_COMMAND_NAMES = ["typecheck", "lint", "test", "build"];
const DEFAULT_VERIFY_CONFIG = {
  enabled: false,
  policyPacks: [],
  requiredTaskEvidence: false,
  taskIdPattern: "\\b[A-Z][A-Z0-9]+-\\d+\\b",
  taskIdSources: ["cli", "env", "branch"],
  envTaskIdVar: "CQ_TASK_ID",
  doneEvidenceDir: ".quality/done-evidence",
  evidenceSchemaFile: "docs/engineering/schemas/autonomy-done-evidence.schema.json",
  waiversFile: ".quality/waivers.json",
  gates: [],
};
const BUILTIN_POLICY_PACKS = {
  "autonomy-core": join(PACKAGE_ROOT, "policy-packs", "autonomy-core.json"),
};
const DEFAULT_WEIGHTS = {
  typeSafety: 0.25,
  testHealth: 0.3,
  lintCompliance: 0.15,
  coverageLevel: 0.2,
  buildStability: 0.1,
};

const DEFAULT_PATTERN_RULES = [
  { key: "cannot_find_module", pattern: "Cannot find module", flags: "gi" },
  { key: "type_mismatch", pattern: "is not assignable to type", flags: "gi" },
  { key: "unused_symbol", pattern: "unused (import|variable|parameter|private class member)", flags: "gi" },
  { key: "formatting_violation", pattern: "Formatter would have printed", flags: "gi" },
  { key: "missing_test_coverage", pattern: "coverage.*below|No test files found", flags: "gi" },
];
const DEFAULT_COMMANDS = {
  typecheck: "pnpm run typecheck",
  lint: "pnpm run lint",
  test: "pnpm run test -- --coverage",
  build: "pnpm run build",
};

function printUsage() {
  console.log("Usage:");
  console.log("  compound-quality init --config <path>");
  console.log("  compound-quality reflect --config <path>");
  console.log("  compound-quality verify --config <path> [--task-id <KEY>] [--json]");
  console.log("  compound-quality dispatch --config <path>");
  console.log("  compound-quality ralph-loop <start|pause|status|step> --config <path> [--json]");
  console.log("  compound-quality rw <start|pause|status|step> --config <path> [--json]");
}

function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift() ?? "reflect";
  let configPath = ".compound-quality.json";
  let json = false;
  let taskId = "";
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === "--task-id" && args[i + 1]) {
      taskId = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === "--json") {
      json = true;
      continue;
    }
    positionals.push(args[i]);
  }

  return { mode, configPath, action: positionals[0], json, taskId };
}

function countMatches(input, expression) {
  const matches = input.match(expression);
  return matches ? matches.length : 0;
}

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(input) {
  return input.replace(ANSI_PATTERN, "");
}

function parseTypeErrors(output) {
  return countMatches(stripAnsi(output), /error TS\d+:/g);
}

function parseLintViolations(output, exitCode) {
  const normalized = stripAnsi(output);
  const exact = normalized.match(/Found\s+(\d+)\s+errors?/i);
  if (exact) return Number(exact[1]);

  if (exitCode === 0) return 0;

  return normalized
    .split("\n")
    .filter((line) => /\berror\b/i.test(line) && !/\bno errors?\b/i.test(line)).length;
}

function parseTests(output) {
  const normalized = stripAnsi(output);
  const lines = normalized.split("\n");
  let passed = 0;
  let failed = 0;

  for (const line of lines) {
    const vitest = line.match(/Tests\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+failed)?/i);
    if (vitest) {
      passed += Number(vitest[1] ?? 0);
      failed += Number(vitest[2] ?? 0);
      continue;
    }

    const jest = line.match(/Tests?:\s*(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i);
    if (jest) {
      passed += Number(jest[1] ?? 0);
      failed += Number(jest[2] ?? 0);
    }
  }

  return { passed, failed };
}

function toScore(raw) {
  return Number(Math.max(0, Math.min(100, raw)).toFixed(2));
}

function computeComponentScores(metrics, weights) {
  const typeSafety = toScore(metrics.typeErrors === 0 ? 100 : 100 - metrics.typeErrors * 8);
  const testTotal = metrics.testsPassed + metrics.testsFailed;
  const testHealth = testTotal === 0 ? toScore(metrics.testsFailed === 0 ? 70 : 20) : toScore((metrics.testsPassed / testTotal) * 100);
  const lintCompliance = toScore(metrics.lintViolations === 0 ? 100 : 100 - metrics.lintViolations * 4);
  const coverageLevel = toScore(metrics.coveragePct);
  const buildStability = metrics.buildExitCode === 0 ? 100 : 0;

  const overall = toScore(
    typeSafety * weights.typeSafety +
      testHealth * weights.testHealth +
      lintCompliance * weights.lintCompliance +
      coverageLevel * weights.coverageLevel +
      buildStability * weights.buildStability,
  );

  return {
    overall,
    components: {
      typeSafety,
      testHealth,
      lintCompliance,
      coverageLevel,
      buildStability,
    },
  };
}

function recommendationForCount(count, thresholds) {
  if (count >= thresholds.lintRule) return "lint_rule";
  if (count >= thresholds.claudeRule) return "claude_rule";
  return "none";
}

function detectPatterns(output, patternRules) {
  const counts = {};
  for (const rule of patternRules) {
    try {
      const regex = new RegExp(rule.pattern, rule.flags ?? "gi");
      const count = countMatches(output, regex);
      if (count > 0) counts[rule.key] = count;
    } catch {
      // ignore malformed regex in config
    }
  }
  return counts;
}

function buildActionItems(metrics) {
  const actions = [];

  if (metrics.typeErrors > 0) {
    actions.push(`Fix ${metrics.typeErrors} TypeScript errors before merge.`);
  }
  if (metrics.lintViolations > 0) {
    actions.push(`Resolve ${metrics.lintViolations} lint violations.`);
  }
  if (metrics.testsFailed > 0) {
    actions.push(`Address ${metrics.testsFailed} failing tests.`);
  }
  if (!metrics.coverageQualified) {
    actions.push("Coverage was not fully collected across all packages; rerun full test coverage.");
  } else if (metrics.coveragePct < metrics.coverageFloor) {
    actions.push(
      `Coverage ${metrics.coveragePct.toFixed(2)}% is below floor ${metrics.coverageFloor.toFixed(2)}%; add tests before shipping.`,
    );
  }
  if (metrics.buildExitCode !== 0) {
    actions.push("Build is unstable; fix build failures before enabling automation.");
  }

  if (actions.length === 0) {
    actions.push("Quality gates passed. Promote one repeated issue pattern into prevention rules this session.");
  }

  return actions;
}

function normalizeConfig(userConfig) {
  const qualityDir = userConfig.qualityDir ?? ".quality";
  const coverage = userConfig.coverage ?? {};

  const commandObject = userConfig.commands ?? {};
  const commandEntries = REQUIRED_COMMAND_NAMES.map((name) => ({
    name,
    command: commandObject[name],
  }));

  for (const entry of commandEntries) {
    if (!entry.command || typeof entry.command !== "string") {
      throw new Error(`Missing required command config for "${entry.name}"`);
    }
  }

  const packageDirs = Array.isArray(coverage.packageDirs) ? coverage.packageDirs : [];
  if (packageDirs.length === 0) {
    throw new Error("coverage.packageDirs must contain at least one package directory");
  }

  return {
    qualityDir,
    commands: commandEntries,
    coverage: {
      packageDirs,
      summaryFile: coverage.summaryFile ?? "coverage/coverage-summary.json",
      expectedPackages: coverage.expectedPackages ?? packageDirs.length,
    },
    patterns: {
      rules: Array.isArray(userConfig.patterns?.rules) ? userConfig.patterns.rules : DEFAULT_PATTERN_RULES,
      claudeRuleThreshold: userConfig.patterns?.claudeRuleThreshold ?? 3,
      lintRuleThreshold: userConfig.patterns?.lintRuleThreshold ?? 5,
    },
    weights: {
      ...DEFAULT_WEIGHTS,
      ...(userConfig.weights ?? {}),
    },
    maxSuggestedUpdateFiles: userConfig.maxSuggestedUpdateFiles ?? 25,
  };
}

async function discoverPackageDirs(root) {
  const ignoredDirs = new Set([
    "node_modules",
    ".git",
    ".quality",
    "dist",
    "build",
    "coverage",
    ".turbo",
    ".next",
  ]);

  const packageDirs = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (ignoredDirs.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    if (existsSync(join(root, entry.name, "package.json"))) {
      packageDirs.push(entry.name);
    }
  }

  if (packageDirs.length > 0) return packageDirs;
  if (existsSync(join(root, "package.json"))) return ["."];
  return ["shared", "daemon", "web"];
}

async function createDefaultConfig(configPath, root, options = {}) {
  const rootPackageJson = await loadJson(join(root, "package.json"));
  const scripts = rootPackageJson?.scripts ?? {};

  const commands = {
    typecheck: scripts.typecheck ? "pnpm run typecheck" : DEFAULT_COMMANDS.typecheck,
    lint: scripts.lint ? "pnpm run lint" : DEFAULT_COMMANDS.lint,
    test: scripts.test ? "pnpm run test -- --coverage" : DEFAULT_COMMANDS.test,
    build: scripts.build ? "pnpm run build" : DEFAULT_COMMANDS.build,
  };

  const packageDirs = await discoverPackageDirs(root);
  const defaultConfig = {
    version: 1,
    qualityDir: ".quality",
    commands,
    coverage: {
      packageDirs,
      summaryFile: "coverage/coverage-summary.json",
      expectedPackages: packageDirs.length,
    },
    patterns: {
      claudeRuleThreshold: 3,
      lintRuleThreshold: 5,
      rules: DEFAULT_PATTERN_RULES,
    },
    weights: DEFAULT_WEIGHTS,
    maxSuggestedUpdateFiles: 25,
    verify: {
      enabled: false,
      policyPacks: ["builtin:autonomy-core"],
      requiredTaskEvidence: true,
      taskIdSources: ["cli", "env", "branch"],
      envTaskIdVar: "CQ_TASK_ID",
      doneEvidenceDir: ".quality/done-evidence",
      evidenceSchemaFile: "docs/engineering/schemas/autonomy-done-evidence.schema.json",
      waiversFile: ".quality/waivers.json",
      gates: [],
    },
  };

  await writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  if (!options.silent) {
    console.log(`Created default config at ${configPath}`);
  }
}

async function readCoveragePct(root, coverageConfig) {
  const values = [];

  for (const packageDir of coverageConfig.packageDirs) {
    const summaryPath = join(root, packageDir, coverageConfig.summaryFile);
    if (!existsSync(summaryPath)) continue;

    try {
      const raw = await readFile(summaryPath, "utf8");
      const parsed = JSON.parse(raw);
      const pct = parsed?.total?.lines?.pct;
      if (typeof pct === "number") values.push(pct);
    } catch {
      // ignore malformed coverage file
    }
  }

  if (values.length === 0) {
    return { pct: 0, packageCount: 0 };
  }

  return {
    pct: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    packageCount: values.length,
  };
}

async function loadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function runCommand(root, name, command) {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
  });

  return {
    name,
    command,
    exitCode: result.status ?? 1,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function resolvePathFromRoot(root, pathLike) {
  if (!pathLike || typeof pathLike !== "string") return "";
  return isAbsolute(pathLike) ? pathLike : resolve(root, pathLike);
}

function truncateText(input, maxLength = 20000) {
  if (typeof input !== "string") return "";
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}\n...[truncated ${input.length - maxLength} chars]`;
}

function getPathValue(input, pathExpr) {
  if (!pathExpr) return undefined;
  const parts = pathExpr.split(".");
  let current = input;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function interpolateTemplate(input, context) {
  if (typeof input !== "string") return input;
  return input.replace(/\$\{([a-zA-Z0-9_.-]+)\}/g, (match, key) => {
    const value = getPathValue(context, key);
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

function parseTaskIdPattern(value) {
  const fallback = /\b[A-Z][A-Z0-9]+-\d+\b/g;
  if (!value || typeof value !== "string") return fallback;
  try {
    return new RegExp(value, "g");
  } catch {
    return fallback;
  }
}

function collectTaskIdsFromText(input, regex) {
  if (!input || typeof input !== "string") return [];
  const matches = input.match(regex) ?? [];
  return [...new Set(matches)];
}

function getBranchName(root) {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  const result = spawnSync("git rev-parse --abbrev-ref HEAD", {
    cwd: root,
    shell: true,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) return "";
  return String(result.stdout ?? "").trim();
}

function mergeGates(baseGates, patchGates) {
  const byId = new Map();
  for (const gate of baseGates) {
    if (!gate?.id) continue;
    byId.set(gate.id, gate);
  }
  for (const gate of patchGates) {
    if (!gate?.id) continue;
    const existing = byId.get(gate.id) ?? {};
    byId.set(gate.id, { ...existing, ...gate });
  }
  return [...byId.values()];
}

function applyVerifyPatch(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key === "gates") continue;
    if (value !== undefined) next[key] = value;
  }
  if (Array.isArray(patch?.gates)) {
    next.gates = mergeGates(Array.isArray(next.gates) ? next.gates : [], patch.gates);
  }
  return next;
}

function resolvePolicyPackPath(root, reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new Error("Policy pack reference must be a non-empty string");
  }
  if (reference.startsWith("builtin:")) {
    const key = reference.slice("builtin:".length);
    const builtInPath = BUILTIN_POLICY_PACKS[key];
    if (!builtInPath) throw new Error(`Unknown builtin policy pack: ${reference}`);
    return builtInPath;
  }
  return resolvePathFromRoot(root, reference);
}

async function loadPolicyPack(root, reference) {
  const packPath = resolvePolicyPackPath(root, reference);
  if (!existsSync(packPath)) {
    throw new Error(`Policy pack not found: ${reference} -> ${packPath}`);
  }
  const raw = await readFile(packPath, "utf8");
  const parsed = JSON.parse(raw);
  const verifyConfig = parsed?.verify ?? parsed;
  if (!verifyConfig || typeof verifyConfig !== "object") {
    throw new Error(`Policy pack does not contain a verify config object: ${reference}`);
  }
  return {
    reference,
    path: packPath,
    verify: verifyConfig,
  };
}

async function normalizeVerifyConfig(root, userConfig, normalizedConfig) {
  const repoVerify = userConfig?.verify ?? {};
  const packRefs = Array.isArray(repoVerify.policyPacks) ? repoVerify.policyPacks : [];
  let merged = { ...DEFAULT_VERIFY_CONFIG };
  const loadedPolicyPacks = [];
  for (const packRef of packRefs) {
    const pack = await loadPolicyPack(root, packRef);
    loadedPolicyPacks.push({ reference: pack.reference, path: relative(root, pack.path) });
    merged = applyVerifyPatch(merged, pack.verify);
  }
  merged = applyVerifyPatch(merged, repoVerify);
  merged.policyPacks = packRefs;
  merged.loadedPolicyPacks = loadedPolicyPacks;
  if (!Array.isArray(merged.gates)) {
    merged.gates = [];
  }
  if (!Array.isArray(merged.taskIdSources) || merged.taskIdSources.length === 0) {
    merged.taskIdSources = DEFAULT_VERIFY_CONFIG.taskIdSources;
  }
  merged.commands = Object.fromEntries(normalizedConfig.commands.map((entry) => [entry.name, entry.command]));
  return merged;
}

function resolveTaskIds(root, verifyConfig, options) {
  const taskIdRegex = parseTaskIdPattern(verifyConfig.taskIdPattern);
  const taskIds = new Set();
  const sources = new Set(verifyConfig.taskIdSources ?? []);
  if (sources.has("cli") && options.taskId) {
    for (const value of collectTaskIdsFromText(options.taskId, taskIdRegex)) {
      taskIds.add(value);
    }
  }
  if (sources.has("env")) {
    const envVar = verifyConfig.envTaskIdVar || "CQ_TASK_ID";
    for (const value of collectTaskIdsFromText(process.env[envVar], taskIdRegex)) {
      taskIds.add(value);
    }
  }
  if (sources.has("branch")) {
    for (const value of collectTaskIdsFromText(getBranchName(root), taskIdRegex)) {
      taskIds.add(value);
    }
  }
  return [...taskIds];
}

async function loadWaivers(root, waiversFile) {
  const fullPath = resolvePathFromRoot(root, waiversFile);
  if (!fullPath || !existsSync(fullPath)) return [];
  const raw = await readFile(fullPath, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.waivers)) return parsed.waivers;
  throw new Error(`Waivers file must be an array or object with "waivers" array: ${waiversFile}`);
}

function findMatchingWaiver(waivers, gateResult, taskIds) {
  for (const waiver of waivers) {
    if (!waiver || typeof waiver !== "object") continue;
    const gateMatch = waiver.gateId === gateResult.id || waiver.gateId === "*";
    if (!gateMatch) continue;
    const taskIdMatch =
      !waiver.taskId || waiver.taskId === "*" || taskIds.length === 0 || taskIds.includes(String(waiver.taskId));
    if (!taskIdMatch) continue;
    if (waiver.expiresAt) {
      const expiry = new Date(waiver.expiresAt);
      if (!Number.isNaN(expiry.getTime()) && Date.now() > expiry.getTime()) {
        continue;
      }
    }
    return waiver;
  }
  return null;
}

function createValidationError(path, message) {
  return `${path}: ${message}`;
}

function resolveSchemaRef(rootSchema, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let current = rootSchema;
  for (const rawPart of parts) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || current === undefined || typeof current !== "object") return null;
    current = current[part];
  }
  return current;
}

function matchesSchema(schema, data, rootSchema) {
  const errors = [];
  validateSchemaNode(schema, data, "$", rootSchema, errors);
  return errors.length === 0;
}

function validateSchemaNode(schema, data, path, rootSchema, errors) {
  if (!schema || typeof schema !== "object") return;

  if (schema.$ref) {
    const resolved = resolveSchemaRef(rootSchema, schema.$ref);
    if (!resolved) {
      errors.push(createValidationError(path, `unresolved $ref ${schema.$ref}`));
      return;
    }
    validateSchemaNode(resolved, data, path, rootSchema, errors);
    return;
  }

  if (Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      validateSchemaNode(subSchema, data, path, rootSchema, errors);
    }
  }

  if (schema.if && schema.then && matchesSchema(schema.if, data, rootSchema)) {
    validateSchemaNode(schema.then, data, path, rootSchema, errors);
  }

  if (schema.const !== undefined) {
    if (JSON.stringify(data) !== JSON.stringify(schema.const)) {
      errors.push(createValidationError(path, "does not match const value"));
    }
  }

  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(data))) {
    errors.push(createValidationError(path, `must be one of: ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`));
  }

  const expectedType = schema.type;
  if (expectedType) {
    const actualType = Array.isArray(data) ? "array" : data === null ? "null" : typeof data;
    const typeMatches =
      expectedType === actualType ||
      (expectedType === "number" && actualType === "number") ||
      (expectedType === "integer" && Number.isInteger(data));
    if (!typeMatches) {
      errors.push(createValidationError(path, `expected type ${expectedType}, got ${actualType}`));
      return;
    }
  }

  if (typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push(createValidationError(path, `must have minLength ${schema.minLength}`));
    }
    if (schema.pattern) {
      try {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(data)) {
          errors.push(createValidationError(path, `does not match pattern ${schema.pattern}`));
        }
      } catch {
        errors.push(createValidationError(path, `invalid pattern ${schema.pattern}`));
      }
    }
  }

  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push(createValidationError(path, `must have minItems ${schema.minItems}`));
    }
    if (schema.items) {
      data.forEach((item, index) => {
        validateSchemaNode(schema.items, item, `${path}[${index}]`, rootSchema, errors);
      });
    }
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        errors.push(createValidationError(path, `missing required property "${key}"`));
      }
    }

    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        validateSchemaNode(propertySchema, data[key], `${path}.${key}`, rootSchema, errors);
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) {
          errors.push(createValidationError(path, `unexpected property "${key}"`));
        }
      }
    }
  }
}

function validateJsonAgainstSchema(schema, data) {
  const errors = [];
  validateSchemaNode(schema, data, "$", schema, errors);
  return errors;
}

async function evaluateVerifyGate(root, gate, context) {
  const startedAt = Date.now();
  const required = gate.required !== false;
  const targetTaskIds = gate.forEachTaskId ? context.taskIds : [context.taskId ?? ""];

  try {
    if (gate.type === "command" || gate.type === "custom_script") {
      const command = interpolateTemplate(gate.command, context);
      const result = runCommand(root, gate.id, command);
      return {
        id: gate.id,
        type: gate.type,
        required,
        status: result.exitCode === 0 ? "pass" : "fail",
        durationMs: Date.now() - startedAt,
        command,
        exitCode: result.exitCode,
        message: result.exitCode === 0 ? "command passed" : "command failed",
        stdout: truncateText(result.stdout),
        stderr: truncateText(result.stderr),
      };
    }

    if (gate.type === "file_exists") {
      const paths = [];
      const configured = Array.isArray(gate.paths) ? gate.paths : gate.path ? [gate.path] : [];
      for (const taskId of targetTaskIds.length > 0 ? targetTaskIds : [""]) {
        for (const entry of configured) {
          const resolved = resolvePathFromRoot(root, interpolateTemplate(entry, { ...context, taskId }));
          paths.push({ taskId, path: resolved });
        }
      }
      const missing = paths.filter((entry) => !existsSync(entry.path));
      return {
        id: gate.id,
        type: gate.type,
        required,
        status: missing.length === 0 ? "pass" : "fail",
        durationMs: Date.now() - startedAt,
        message:
          missing.length === 0
            ? `all files exist (${paths.length})`
            : `missing files: ${missing.map((entry) => relative(root, entry.path)).join(", ")}`,
        checks: paths.map((entry) => ({
          taskId: entry.taskId || null,
          path: relative(root, entry.path),
          exists: existsSync(entry.path),
        })),
      };
    }

    if (gate.type === "regex") {
      const filePath = resolvePathFromRoot(root, interpolateTemplate(gate.file, context));
      if (!existsSync(filePath)) {
        return {
          id: gate.id,
          type: gate.type,
          required,
          status: "fail",
          durationMs: Date.now() - startedAt,
          message: `file not found: ${relative(root, filePath)}`,
        };
      }
      const content = await readFile(filePath, "utf8");
      const flags = typeof gate.flags === "string" ? gate.flags : "g";
      const regex = new RegExp(gate.pattern, flags);
      const matchCount = (content.match(regex) ?? []).length;
      const minMatches = typeof gate.minMatches === "number" ? gate.minMatches : 1;
      const passed = matchCount >= minMatches;
      return {
        id: gate.id,
        type: gate.type,
        required,
        status: passed ? "pass" : "fail",
        durationMs: Date.now() - startedAt,
        message: passed
          ? `pattern matched ${matchCount} time(s)`
          : `pattern matched ${matchCount} time(s), expected >= ${minMatches}`,
        file: relative(root, filePath),
      };
    }

    if (gate.type === "json_schema") {
      const schemaPath = resolvePathFromRoot(root, interpolateTemplate(gate.schemaFile, context));
      if (!existsSync(schemaPath)) {
        return {
          id: gate.id,
          type: gate.type,
          required,
          status: "fail",
          durationMs: Date.now() - startedAt,
          message: `schema file not found: ${relative(root, schemaPath)}`,
        };
      }
      const schemaRaw = await readFile(schemaPath, "utf8");
      const schema = JSON.parse(schemaRaw);
      const taskIds = targetTaskIds.length > 0 ? targetTaskIds : [""];
      const checks = [];
      for (const taskId of taskIds) {
        const dataPath = resolvePathFromRoot(root, interpolateTemplate(gate.dataFile, { ...context, taskId }));
        if (!existsSync(dataPath)) {
          checks.push({
            taskId: taskId || null,
            file: relative(root, dataPath),
            valid: false,
            errors: ["file not found"],
          });
          continue;
        }
        const dataRaw = await readFile(dataPath, "utf8");
        let parsed;
        try {
          parsed = JSON.parse(dataRaw);
        } catch (error) {
          checks.push({
            taskId: taskId || null,
            file: relative(root, dataPath),
            valid: false,
            errors: [`invalid JSON: ${String(error)}`],
          });
          continue;
        }
        const errors = validateJsonAgainstSchema(schema, parsed);
        checks.push({
          taskId: taskId || null,
          file: relative(root, dataPath),
          valid: errors.length === 0,
          errors,
        });
      }
      const failed = checks.filter((entry) => !entry.valid);
      return {
        id: gate.id,
        type: gate.type,
        required,
        status: failed.length === 0 ? "pass" : "fail",
        durationMs: Date.now() - startedAt,
        message:
          failed.length === 0
            ? `schema validation passed (${checks.length} file(s))`
            : `schema validation failed (${failed.length}/${checks.length} file(s))`,
        schemaFile: relative(root, schemaPath),
        checks,
      };
    }

    return {
      id: gate.id,
      type: gate.type,
      required,
      status: "fail",
      durationMs: Date.now() - startedAt,
      message: `unsupported gate type "${gate.type}"`,
    };
  } catch (error) {
    return {
      id: gate.id,
      type: gate.type,
      required,
      status: "fail",
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function buildDispatchTasks(scorecard, patternsFile) {
  const tasks = [];
  const metrics = scorecard.metrics ?? {};
  const thresholds = scorecard.thresholds ?? {};
  const commandResults = Array.isArray(scorecard.commandResults) ? scorecard.commandResults : [];
  const buildResult = commandResults.find((result) => result.name === "build");

  if ((buildResult?.exitCode ?? 0) !== 0) {
    tasks.push({
      id: "build-stability",
      priority: 100,
      ownerProfile: "build-fix-agent",
      category: "stability",
      title: "Stabilize build pipeline",
      reason: "Build command failed in latest reflect run.",
      successCriteria: [
        "Build command exits with code 0.",
        "No regressions in quality commands.",
      ],
      verificationCommand: "pnpm run build",
    });
  }

  if ((metrics.typeErrors ?? 0) > 0) {
    tasks.push({
      id: "type-errors",
      priority: 90,
      ownerProfile: "typescript-fix-agent",
      category: "correctness",
      title: `Fix ${metrics.typeErrors} TypeScript errors`,
      reason: "Type errors reduce type safety and block reliable releases.",
      successCriteria: [
        "Typecheck command exits with code 0.",
        "No new lint or test failures introduced.",
      ],
      verificationCommand: "pnpm run typecheck",
    });
  }

  if ((metrics.testsFailed ?? 0) > 0) {
    tasks.push({
      id: "test-failures",
      priority: 80,
      ownerProfile: "test-fix-agent",
      category: "quality-gates",
      title: `Fix ${metrics.testsFailed} failing tests`,
      reason: "Failing tests indicate functional regressions or unstable test harness.",
      successCriteria: [
        "Test command exits with code 0.",
        "Failures are fixed without reducing test coverage intent.",
      ],
      verificationCommand: "pnpm run test",
    });
  }

  if ((metrics.lintViolations ?? 0) > 0) {
    tasks.push({
      id: "lint-violations",
      priority: 70,
      ownerProfile: "lint-fix-agent",
      category: "hygiene",
      title: `Resolve ${metrics.lintViolations} lint violations`,
      reason: "Lint violations create noise and hide real defects.",
      successCriteria: [
        "Lint command exits with code 0.",
        "Code style remains consistent with existing rules.",
      ],
      verificationCommand: "pnpm run lint",
    });
  }

  const coverageQualified = Boolean(thresholds.coverageQualified);
  const coveragePct = Number(metrics.coveragePct ?? 0);
  const coverageFloor = Number(thresholds.coverageFloor ?? 0);
  if (!coverageQualified || coveragePct < coverageFloor) {
    const reason = !coverageQualified
      ? "Coverage data was incomplete for expected packages."
      : `Coverage ${coveragePct.toFixed(2)}% is below floor ${coverageFloor.toFixed(2)}%.`;
    tasks.push({
      id: "coverage-health",
      priority: 60,
      ownerProfile: "test-authoring-agent",
      category: "coverage",
      title: "Restore coverage health",
      reason,
      successCriteria: [
        "Coverage is collected for all expected packages.",
        "Coverage meets or exceeds current floor.",
      ],
      verificationCommand: "pnpm run test -- --coverage",
    });
  }

  const patternEntries = Object.entries(patternsFile?.patterns ?? {});
  patternEntries
    .filter(([, data]) => data?.recommendation === "claude_rule" || data?.recommendation === "lint_rule")
    .sort((a, b) => (b[1]?.count ?? 0) - (a[1]?.count ?? 0))
    .forEach(([key, data]) => {
      const recommendation = data?.recommendation;
      tasks.push({
        id: `pattern-${slugify(key)}`,
        priority: recommendation === "lint_rule" ? 50 : 40,
        ownerProfile: recommendation === "lint_rule" ? "lint-rule-agent" : "policy-agent",
        category: "prevention",
        title: `Promote prevention for pattern: ${key}`,
        reason: `Pattern seen ${data?.count ?? 0} times; recommendation: ${recommendation}.`,
        successCriteria:
          recommendation === "lint_rule"
            ? ["Add or update lint rule to prevent recurrence.", "Document autofix or migration guidance."]
            : ["Add a CLAUDE.md / agent policy rule.", "Reference concrete example and prevention check."],
        verificationCommand: recommendation === "lint_rule" ? "pnpm run lint" : "pnpm run typecheck",
      });
    });

  if (tasks.length === 0) {
    tasks.push({
      id: "maintain-quality",
      priority: 10,
      ownerProfile: "maintenance-agent",
      category: "maintenance",
      title: "Maintain quality baseline",
      reason: "No active regressions detected in latest run.",
      successCriteria: [
        "Review top recurring pattern and decide if new prevention rule is needed.",
        "Keep quality loop running on each PR.",
      ],
      verificationCommand: "pnpm run build",
    });
  }

  return tasks.sort((a, b) => b.priority - a.priority);
}

function renderDispatchPrompt(task, planPath, scorecardPath, patternsPath, configPath) {
  return [
    `# ${task.title}`,
    "",
    "## Objective",
    `${task.reason}`,
    "",
    "## Inputs",
    `- Config: ${configPath}`,
    `- Scorecard: ${scorecardPath}`,
    `- Patterns: ${patternsPath}`,
    `- Plan: ${planPath}`,
    "",
    "## Constraints",
    "- Make minimal, targeted changes.",
    "- Do not broaden scope beyond this task.",
    "- Preserve existing behavior outside the defect area.",
    "",
    "## Success Criteria",
    ...task.successCriteria.map((item) => `- ${item}`),
    "",
    "## Verification",
    `- Run: ${task.verificationCommand}`,
    "",
    "## Deliverables",
    "- Summary of root cause.",
    "- Files changed and why.",
    "- Residual risks or follow-ups.",
    "",
  ].join("\n");
}

async function writeDispatchBundle({ root, qualityDir, scorecard, patternsFile, configPathArg }) {
  const dispatchDir = join(qualityDir, "dispatch");
  const promptsDir = join(dispatchDir, "prompts");
  const scorecardPath = join(qualityDir, "scorecard.json");
  const patternsPath = join(qualityDir, "patterns.json");
  const planPath = join(dispatchDir, "plan.json");
  const toProjectPath = (absPath) => {
    const relPath = relative(root, absPath);
    return relPath === "" ? "." : relPath;
  };
  const scorecardProjectPath = toProjectPath(scorecardPath);
  const patternsProjectPath = toProjectPath(patternsPath);
  const planProjectPath = toProjectPath(planPath);

  await mkdir(dispatchDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });

  const tasks = buildDispatchTasks(scorecard, patternsFile).map((task, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const promptFile = `${ordinal}-${task.id}.md`;
    const promptAbsPath = join(promptsDir, promptFile);
    return {
      ...task,
      ordinal: index + 1,
      promptPath: toProjectPath(promptAbsPath),
      promptFile,
    };
  });

  for (const task of tasks) {
    const promptBody = renderDispatchPrompt(
      task,
      planProjectPath,
      scorecardProjectPath,
      patternsProjectPath,
      configPathArg,
    );
    await writeFile(join(promptsDir, task.promptFile), promptBody, "utf8");
  }

  const plan = {
    version: 1,
    generatedAt: new Date().toISOString(),
    score: scorecard?.score?.overall ?? 0,
    summary: {
      actionItems: Array.isArray(scorecard?.actionItems) ? scorecard.actionItems.length : 0,
      dispatchTasks: tasks.length,
    },
    inputs: {
      configPath: configPathArg,
      scorecardPath: scorecardProjectPath,
      patternsPath: patternsProjectPath,
    },
    tasks,
  };

  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const queuePath = join(dispatchDir, "QUEUE.md");
  const queueLines = [
    "# Dispatch Queue",
    "",
    `Generated: ${plan.generatedAt}`,
    `Quality Score: ${plan.score}`,
    "",
    "## Task Order",
    ...tasks.map((task) => `${task.ordinal}. ${task.title} (${task.ownerProfile}) -> ${task.promptPath}`),
    "",
    "## How To Use",
    "1. Assign top task to an agent and provide its prompt file.",
    "2. Merge result, rerun `compound-quality reflect`, and use refreshed queue.",
    "3. Repeat until queue has only maintenance/prevention tasks.",
    "",
  ];
  await writeFile(queuePath, queueLines.join("\n"), "utf8");

  return {
    taskCount: tasks.length,
    planPath: planProjectPath,
    queuePath: toProjectPath(queuePath),
  };
}

async function runReflect(configPathArg, options = {}) {
  const quiet = options.quiet === true;
  const root = resolve(process.cwd());
  const configPath = resolve(root, configPathArg);
  if (!existsSync(configPath)) {
    await createDefaultConfig(configPath, root, { silent: quiet });
  }

  const userConfig = JSON.parse(await readFile(configPath, "utf8"));
  const config = normalizeConfig(userConfig);

  const qualityDir = join(root, config.qualityDir);
  const scorecardPath = join(qualityDir, "scorecard.json");
  const patternsPath = join(qualityDir, "patterns.json");
  const reflectionsDir = join(qualityDir, "reflections");
  const templatesDir = join(qualityDir, "templates");
  const suggestedDir = join(qualityDir, "suggested-updates");

  await mkdir(qualityDir, { recursive: true });
  await mkdir(reflectionsDir, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await mkdir(suggestedDir, { recursive: true });

  const previous = await loadJson(scorecardPath);
  const commandResults = config.commands.map(({ name, command }) => runCommand(root, name, command));
  const allOutput = commandResults.map((result) => `${result.stdout}\n${result.stderr}`).join("\n");

  const coverage = await readCoveragePct(root, config.coverage);
  const typeErrors = parseTypeErrors(allOutput);
  const lintResult = commandResults.find((result) => result.name === "lint");
  const lintOutput = `${lintResult?.stdout ?? ""}\n${lintResult?.stderr ?? ""}`;
  const lintViolations = parseLintViolations(lintOutput, lintResult?.exitCode ?? 1);
  const tests = parseTests(allOutput);

  const testExitCode = commandResults.find((result) => result.name === "test")?.exitCode ?? 1;
  const buildExitCode = commandResults.find((result) => result.name === "build")?.exitCode ?? 1;
  const coverageQualified = testExitCode === 0 && coverage.packageCount === config.coverage.expectedPackages;
  const previousCoverageQualified = previous?.thresholds?.coverageQualified ?? false;
  const previousCoverageFloor = previous?.thresholds?.coverageFloor ?? 0;
  const candidateFloor = Math.max(0, Number((coverage.pct - 2).toFixed(2)));
  let coverageFloor = previousCoverageFloor;
  if (coverageQualified) {
    coverageFloor = previousCoverageQualified ? Math.max(previousCoverageFloor, candidateFloor) : candidateFloor;
  }

  const score = computeComponentScores(
    {
      typeErrors,
      lintViolations,
      testsPassed: tests.passed,
      testsFailed: tests.failed,
      coveragePct: coverage.pct,
      buildExitCode,
    },
    config.weights,
  );

  const history = [
    ...(Array.isArray(previous?.history) ? previous.history : []),
    {
      at: new Date().toISOString(),
      score: score.overall,
      coveragePct: coverage.pct,
      typeErrors,
      lintViolations,
    },
  ].slice(-50);

  const scorecard = {
    version: 1,
    updatedAt: new Date().toISOString(),
    score,
    metrics: {
      typeErrors,
      lintViolations,
      testsPassed: tests.passed,
      testsFailed: tests.failed,
      coveragePct: coverage.pct,
      buildTimeMs: commandResults.find((result) => result.name === "build")?.durationMs ?? 0,
    },
    thresholds: {
      coverageFloor,
      coverageQualified,
      coveragePackageCount: coverage.packageCount,
    },
    actionItems: buildActionItems({
      typeErrors,
      lintViolations,
      testsFailed: tests.failed,
      coveragePct: coverage.pct,
      coverageFloor,
      coverageQualified,
      buildExitCode,
    }),
    commandResults: commandResults.map(({ name, exitCode, durationMs }) => ({ name, exitCode, durationMs })),
    history,
  };

  const patternsFile = (await loadJson(patternsPath)) ?? { version: 1, updatedAt: new Date().toISOString(), patterns: {} };
  const detected = detectPatterns(allOutput, config.patterns.rules);
  const promotions = [];
  for (const [pattern, seenCount] of Object.entries(detected)) {
    const existing = patternsFile.patterns[pattern] ?? {
      count: 0,
      lastSeenAt: new Date().toISOString(),
      recommendation: "none",
    };
    const updatedCount = existing.count + seenCount;
    const recommendation = recommendationForCount(updatedCount, {
      claudeRule: config.patterns.claudeRuleThreshold,
      lintRule: config.patterns.lintRuleThreshold,
    });

    patternsFile.patterns[pattern] = {
      count: updatedCount,
      lastSeenAt: new Date().toISOString(),
      recommendation,
    };

    if (recommendation !== "none" && recommendation !== existing.recommendation) {
      promotions.push({ pattern, recommendation });
    }
  }
  patternsFile.updatedAt = new Date().toISOString();

  const reflectionTimestamp = new Date().toISOString();
  const reflectionFilename = `${reflectionTimestamp.replace(/[:]/g, "-")}.md`;
  const reflectionPath = join(reflectionsDir, reflectionFilename);
  const reflectionLines = [
    `# Reflection ${reflectionTimestamp}`,
    "",
    `- Quality score: **${scorecard.score.overall}**`,
    `- Type errors: **${scorecard.metrics.typeErrors}**`,
    `- Lint violations: **${scorecard.metrics.lintViolations}**`,
    `- Tests: **${scorecard.metrics.testsPassed} passed / ${scorecard.metrics.testsFailed} failed**`,
    `- Coverage: **${scorecard.metrics.coveragePct}%**`,
    "",
    "## Command Results",
    ...commandResults.map((result) => `- ${result.name}: exit ${result.exitCode}, ${(result.durationMs / 1000).toFixed(1)}s`),
    "",
    "## Action Items",
    ...scorecard.actionItems.map((item) => `- ${item}`),
    "",
    "## Promotions",
    ...(promotions.length > 0
      ? promotions.map((promotion) => `- ${promotion.pattern}: ${promotion.recommendation}`)
      : ["- No pattern promotions this run."]),
    "",
  ];

  await writeFile(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  await writeFile(patternsPath, `${JSON.stringify(patternsFile, null, 2)}\n`, "utf8");
  await writeFile(reflectionPath, reflectionLines.join("\n"), "utf8");

  if (promotions.length > 0) {
    const suggestedPath = join(suggestedDir, `${reflectionTimestamp.replace(/[:]/g, "-")}.md`);
    const suggestedLines = [
      "# Suggested Structural Updates",
      "",
      ...promotions.map((promotion) =>
        `- ${promotion.pattern}: ${promotion.recommendation === "lint_rule" ? "Convert to lint rule" : "Add CLAUDE.md prevention rule"}`,
      ),
      "",
    ];
    await writeFile(suggestedPath, suggestedLines.join("\n"), "utf8");
  }

  const suggestedFiles = (await readdir(suggestedDir)).sort();
  if (suggestedFiles.length > config.maxSuggestedUpdateFiles) {
    const removeCount = suggestedFiles.length - config.maxSuggestedUpdateFiles;
    for (const filename of suggestedFiles.slice(0, removeCount)) {
      await rm(join(suggestedDir, filename), { force: true });
    }
  }

  if (!quiet) {
    console.log(`Quality score: ${scorecard.score.overall}`);
    console.log(`Coverage floor: ${scorecard.thresholds.coverageFloor}`);
    console.log(`Action items: ${scorecard.actionItems.length}`);
  }
  const dispatch = await writeDispatchBundle({
    root,
    qualityDir,
    scorecard,
    patternsFile,
    configPathArg,
  });
  if (!quiet) {
    console.log(`Dispatch tasks: ${dispatch.taskCount}`);
    console.log(`Dispatch plan: ${dispatch.planPath}`);
  }

  const failedCommands = commandResults.filter((result) => result.exitCode !== 0);
  if (failedCommands.length > 0) {
    process.exitCode = 1;
  }
}

async function runVerify(configPathArg, options = {}) {
  const asJson = options.json === true;
  const root = resolve(process.cwd());
  const configPath = resolve(root, configPathArg);
  if (!existsSync(configPath)) {
    await createDefaultConfig(configPath, root, { silent: asJson });
  }

  const userConfig = JSON.parse(await readFile(configPath, "utf8"));
  const config = normalizeConfig(userConfig);
  const verifyConfig = await normalizeVerifyConfig(root, userConfig, config);
  const qualityDir = join(root, config.qualityDir);
  await mkdir(qualityDir, { recursive: true });

  if (!verifyConfig.enabled) {
    const disabledResult = {
      action: "verify",
      enabled: false,
      message: "Verify mode is disabled in config (verify.enabled=false).",
    };
    if (asJson) {
      console.log(JSON.stringify(disabledResult, null, 2));
    } else {
      console.log(disabledResult.message);
    }
    return;
  }

  const taskIds = resolveTaskIds(root, verifyConfig, options);
  const taskIdFailure = verifyConfig.requiredTaskEvidence && taskIds.length === 0;
  const waivers = await loadWaivers(root, verifyConfig.waiversFile);

  const context = {
    qualityDir: config.qualityDir,
    commands: verifyConfig.commands,
    taskId: taskIds[0] ?? "",
    taskIds,
    verify: verifyConfig,
  };

  const gateResults = [];
  for (const gate of verifyConfig.gates) {
    if (!gate || typeof gate !== "object") continue;
    if (!gate.id || !gate.type) continue;
    if (gate.enabled === false) continue;
    const result = await evaluateVerifyGate(root, gate, context);
    if (result.status === "fail") {
      const waiver = findMatchingWaiver(waivers, result, taskIds);
      if (waiver) {
        gateResults.push({
          ...result,
          status: "waived",
          waiver: {
            gateId: waiver.gateId ?? result.id,
            taskId: waiver.taskId ?? null,
            reason: waiver.reason ?? "",
            approvedBy: waiver.approvedBy ?? "",
            expiresAt: waiver.expiresAt ?? null,
          },
        });
        continue;
      }
    }
    gateResults.push(result);
  }

  const failedRequiredGates = gateResults.filter((result) => result.required && result.status === "fail");
  const verification = {
    version: 1,
    verifiedAt: new Date().toISOString(),
    configPath: relative(root, configPath),
    enabled: true,
    taskIds,
    policyPacks: verifyConfig.loadedPolicyPacks,
    missingTaskId: taskIdFailure,
    gateCounts: {
      total: gateResults.length,
      passed: gateResults.filter((result) => result.status === "pass").length,
      failed: gateResults.filter((result) => result.status === "fail").length,
      waived: gateResults.filter((result) => result.status === "waived").length,
    },
    failures: {
      missingTaskId: taskIdFailure,
      requiredGateFailures: failedRequiredGates.length,
    },
    waiversFile: verifyConfig.waiversFile,
    gates: gateResults,
  };

  const verificationPath = join(qualityDir, "verification.json");
  await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`, "utf8");

  const failed = taskIdFailure || failedRequiredGates.length > 0;
  if (asJson) {
    console.log(JSON.stringify(verification, null, 2));
  } else {
    console.log(`Verify gates: ${verification.gateCounts.total}`);
    console.log(`Passed: ${verification.gateCounts.passed}`);
    console.log(`Waived: ${verification.gateCounts.waived}`);
    console.log(`Failed: ${verification.gateCounts.failed}`);
    if (taskIdFailure) {
      console.log("Missing required task ID for evidence-linked verification.");
    }
    console.log(`Verification artifact: ${relative(root, verificationPath)}`);
  }

  if (failed) {
    process.exitCode = 1;
  }
}

async function runInit(configPathArg) {
  const root = resolve(process.cwd());
  const configPath = resolve(root, configPathArg);
  const configExists = existsSync(configPath);
  if (!configExists) {
    await createDefaultConfig(configPath, root);
  } else {
    console.log(`Config already exists at ${configPath}`);
  }

  const rootPackagePath = join(root, "package.json");
  if (!existsSync(rootPackagePath)) {
    return;
  }

  const rootPackageJson = await loadJson(rootPackagePath);
  if (!rootPackageJson || typeof rootPackageJson !== "object") {
    return;
  }

  const scripts = typeof rootPackageJson.scripts === "object" && rootPackageJson.scripts ? rootPackageJson.scripts : {};
  if (!scripts.reflect) {
    scripts.reflect = `compound-quality reflect --config ${configPathArg}`;
    rootPackageJson.scripts = scripts;
    await writeFile(rootPackagePath, `${JSON.stringify(rootPackageJson, null, 2)}\n`, "utf8");
    console.log('Added script "reflect" to package.json');
  }
  if (!scripts["reflect:rw"]) {
    scripts["reflect:rw"] = `compound-quality rw step --config ${configPathArg} --json`;
    rootPackageJson.scripts = scripts;
    await writeFile(rootPackagePath, `${JSON.stringify(rootPackageJson, null, 2)}\n`, "utf8");
    console.log('Added script "reflect:rw" to package.json');
  }
  if (!scripts["verify:quality"]) {
    scripts["verify:quality"] = `compound-quality verify --config ${configPathArg}`;
    rootPackageJson.scripts = scripts;
    await writeFile(rootPackagePath, `${JSON.stringify(rootPackageJson, null, 2)}\n`, "utf8");
    console.log('Added script "verify:quality" to package.json');
  }
}

async function runDispatch(configPathArg, options = {}) {
  const asJson = options.json === true;
  const root = resolve(process.cwd());
  const configPath = resolve(root, configPathArg);
  if (!existsSync(configPath)) {
    await createDefaultConfig(configPath, root, { silent: asJson });
  }

  const userConfig = JSON.parse(await readFile(configPath, "utf8"));
  const config = normalizeConfig(userConfig);
  const qualityDir = join(root, config.qualityDir);
  const scorecardPath = join(qualityDir, "scorecard.json");
  const patternsPath = join(qualityDir, "patterns.json");

  if (!existsSync(scorecardPath)) {
    throw new Error(`Missing scorecard at ${scorecardPath}. Run "compound-quality reflect" first.`);
  }
  if (!existsSync(patternsPath)) {
    throw new Error(`Missing patterns at ${patternsPath}. Run "compound-quality reflect" first.`);
  }

  const scorecard = JSON.parse(await readFile(scorecardPath, "utf8"));
  const patternsFile = JSON.parse(await readFile(patternsPath, "utf8"));
  const dispatch = await writeDispatchBundle({
    root,
    qualityDir,
    scorecard,
    patternsFile,
    configPathArg,
  });
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          action: "dispatch",
          taskCount: dispatch.taskCount,
          planPath: dispatch.planPath,
          queuePath: dispatch.queuePath,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Dispatch tasks: ${dispatch.taskCount}`);
    console.log(`Dispatch plan: ${dispatch.planPath}`);
  }
}

async function runRalphLoop(configPathArg, actionArg, asJson = false) {
  const action = (actionArg ?? "step").toLowerCase();
  const validActions = new Set(["start", "pause", "status", "step"]);
  if (!validActions.has(action)) {
    throw new Error(`Unknown ralph-loop action "${action}". Use start, pause, status, or step.`);
  }

  const root = resolve(process.cwd());
  const configPath = resolve(root, configPathArg);
  if (!existsSync(configPath)) {
    await createDefaultConfig(configPath, root);
  }

  const userConfig = JSON.parse(await readFile(configPath, "utf8"));
  const config = normalizeConfig(userConfig);
  const qualityDir = join(root, config.qualityDir);
  const dispatchDir = join(qualityDir, "dispatch");
  const controlPath = join(dispatchDir, "ralph-control.json");
  const statePath = join(dispatchDir, "ralph-loop.json");
  const planPath = join(dispatchDir, "plan.json");
  const scorecardPath = join(qualityDir, "scorecard.json");

  await mkdir(dispatchDir, { recursive: true });
  const control = (await loadJson(controlPath)) ?? { version: 1, paused: false, updatedAt: null };

  if (action === "pause") {
    const nextControl = { version: 1, paused: true, updatedAt: new Date().toISOString() };
    await writeFile(controlPath, `${JSON.stringify(nextControl, null, 2)}\n`, "utf8");
    const result = {
      action: "pause",
      paused: true,
      controlPath: relative(root, controlPath),
    };
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("Ralph loop paused");
      console.log(`Control file: ${result.controlPath}`);
    }
    return;
  }

  if (action === "start") {
    const nextControl = { version: 1, paused: false, updatedAt: new Date().toISOString() };
    await writeFile(controlPath, `${JSON.stringify(nextControl, null, 2)}\n`, "utf8");
    const result = {
      action: "start",
      paused: false,
      message: "Ralph loop resumed. Run 'compound-quality rw step' to execute the next loop cycle.",
      controlPath: relative(root, controlPath),
    };
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
      console.log(`Control file: ${result.controlPath}`);
    }
    return;
  }

  if (action === "status") {
    const state = await loadJson(statePath);
    const result = {
      action: "status",
      paused: Boolean(control.paused),
      controlPath: relative(root, controlPath),
      statePath: relative(root, statePath),
      state: state ?? null,
    };
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Ralph loop paused: ${result.paused ? "yes" : "no"}`);
      if (state?.nextTask?.promptPath) {
        console.log(`Next task: ${state.nextTask.title}`);
        console.log(`Prompt: ${state.nextTask.promptPath}`);
      } else if (state) {
        console.log(`Status: ${state.status}`);
      } else {
        console.log("No loop state yet. Run: compound-quality ralph-loop step");
      }
    }
    return;
  }

  if (control.paused) {
    const pausedResult = {
      action: "step",
      paused: true,
      message: "Ralph loop is paused. Run 'compound-quality ralph-loop start' to resume.",
    };
    if (asJson) {
      console.log(JSON.stringify(pausedResult, null, 2));
    } else {
      console.log(pausedResult.message);
    }
    return;
  }

  await runReflect(configPathArg, { quiet: asJson });
  process.exitCode = 0;

  const scorecard = await loadJson(scorecardPath);
  const plan = await loadJson(planPath);
  if (!scorecard || !plan) {
    throw new Error("Missing dispatch artifacts after reflect. Expected scorecard and plan.");
  }

  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const topTask = tasks[0] ?? null;
  const status = !topTask || topTask.category === "maintenance" ? "green" : "needs_work";
  const loopState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    status,
    score: scorecard?.score?.overall ?? 0,
    paused: false,
    taskCount: tasks.length,
    nextTask: topTask
      ? {
          id: topTask.id,
          title: topTask.title,
          ownerProfile: topTask.ownerProfile,
          promptPath: topTask.promptPath,
          verificationCommand: topTask.verificationCommand,
        }
      : null,
    paths: {
      scorecard: relative(root, scorecardPath),
      plan: relative(root, planPath),
      queue: relative(root, join(dispatchDir, "QUEUE.md")),
    },
  };
  await writeFile(statePath, `${JSON.stringify(loopState, null, 2)}\n`, "utf8");

  if (asJson) {
    console.log(JSON.stringify(loopState, null, 2));
  } else {
    console.log(`Ralph loop status: ${loopState.status}`);
    console.log(`Quality score: ${loopState.score}`);
    console.log(`Task count: ${loopState.taskCount}`);
    if (loopState.nextTask) {
      console.log(`Next prompt: ${loopState.nextTask.promptPath}`);
    }
    console.log(`Loop state: ${relative(root, statePath)}`);
  }
}

async function main() {
  const { mode, configPath, action, json, taskId } = parseArgs(process.argv.slice(2));
  if (mode === "init") {
    await runInit(configPath);
    return;
  }
  if (mode === "reflect") {
    await runReflect(configPath);
    return;
  }
  if (mode === "verify") {
    await runVerify(configPath, { json, taskId });
    return;
  }
  if (mode === "dispatch") {
    await runDispatch(configPath, { json });
    return;
  }
  if (mode === "ralph-loop" || mode === "rw" || mode === "ralph") {
    await runRalphLoop(configPath, action, json);
    return;
  }
  printUsage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
