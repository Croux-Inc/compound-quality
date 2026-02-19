#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const REQUIRED_COMMAND_NAMES = ["typecheck", "lint", "test", "build"];
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
  console.log("Usage: compound-quality reflect --config <path>");
}

function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift() ?? "reflect";
  let configPath = ".compound-quality.json";

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[i + 1];
      i += 1;
    }
  }

  return { mode, configPath };
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

async function createDefaultConfig(configPath, root) {
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
  };

  await writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  console.log(`Created default config at ${configPath}`);
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

async function runReflect(configPathArg) {
  const root = resolve(process.cwd());
  const configPath = resolve(root, configPathArg);
  if (!existsSync(configPath)) {
    await createDefaultConfig(configPath, root);
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

  console.log(`Quality score: ${scorecard.score.overall}`);
  console.log(`Coverage floor: ${scorecard.thresholds.coverageFloor}`);
  console.log(`Action items: ${scorecard.actionItems.length}`);

  const failedCommands = commandResults.filter((result) => result.exitCode !== 0);
  if (failedCommands.length > 0) {
    process.exitCode = 1;
  }
}

async function main() {
  const { mode, configPath } = parseArgs(process.argv.slice(2));
  if (mode !== "reflect") {
    printUsage();
    process.exit(1);
  }
  await runReflect(configPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
