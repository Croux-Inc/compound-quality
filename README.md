# @croux-inc/compound-quality

Config-driven CLI for a compound engineering quality loop.

It runs your quality commands, computes a score, ratchets coverage floors, detects repeated patterns, and writes artifacts to `.quality/`.
It can also run policy-driven autonomy verification gates (including per-task done-evidence schema checks).

## Quickstart (Recommended)

For internal teams, the lowest-friction path is install from a tagged GitHub release:

```bash
pnpm add -D git+ssh://git@github.com/Croux-Inc/compound-quality.git#v0.1.9
npx compound-quality init
pnpm reflect
```

What this does:
- installs a pinned version from the private repo,
- creates `.compound-quality.json` if missing,
- adds `"reflect"` script to your `package.json` if missing.
- generates a prioritized dispatch queue for agents under `.quality/dispatch/`.
- adds `"reflect:rw"` script for Ralph Wiggum loop integration.

## Install (GitHub Packages)

This package is intentionally **not** published to the public npm registry.

1. Create a GitHub token with `read:packages` (and SSO enabled for your org if required).
2. Configure npm auth:

```ini
@croux-inc:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
always-auth=true
```

Or run:

```bash
export GITHUB_PACKAGES_TOKEN=ghp_xxx
./scripts/configure-github-packages.sh
```

3. Install in your project:

```bash
pnpm add -D @croux-inc/compound-quality
```

## Publish (Maintainers)

1. Ensure `main` contains the release changes.
2. Bump the package version:

```bash
npm version patch
```

3. Push commit + tag:

```bash
git push origin main --follow-tags
```

4. GitHub Actions publishes automatically from tag `v*` via:

`/.github/workflows/publish-private-package.yml`

5. Verify publish succeeded:

- In GitHub: Actions -> `Publish Private Package` run for the tag.
- In terminal (with auth token):

```bash
npm view @croux-inc/compound-quality version --registry=https://npm.pkg.github.com
```

If Actions are disabled or package publish fails, publish manually:

```bash
export NODE_AUTH_TOKEN=ghp_xxx   # token with write:packages
npm publish --registry=https://npm.pkg.github.com
```

Note:
- GitHub "Release" entries and GitHub Packages versions are separate.
- Creating a Release/tag alone does not publish a package.

`publishConfig.registry` is preconfigured in `package.json` for GitHub Packages.

## Usage

Run the CLI from your repo root:

```bash
compound-quality reflect --config .compound-quality.json
```

If the config file does not exist yet, the CLI auto-creates `.compound-quality.json` with prefilled defaults and continues.
`reflect` also generates dispatch artifacts to drive agent work automatically.

To regenerate dispatch tasks from existing artifacts without rerunning checks:

```bash
compound-quality dispatch --config .compound-quality.json
```

Run autonomy verification gates:

```bash
compound-quality verify --config .compound-quality.json --task-id CRO-123
```

Or rely on `CQ_TASK_ID` / branch naming conventions:

```bash
CQ_TASK_ID=CRO-123 compound-quality verify --config .compound-quality.json
```

## Systematic Agent Loop

1. Run `pnpm reflect`.
2. Open `.quality/dispatch/QUEUE.md`.
3. Assign the top prompt from `.quality/dispatch/prompts/*.md` to an agent.
4. Merge the fix, then rerun `pnpm reflect`.
5. Repeat until only prevention/maintenance tasks remain.

## Ralph Wiggum Loop

Use the built-in Ralph loop mode:

```bash
pnpm reflect:rw               # equivalent to: compound-quality rw step --config .compound-quality.json --json
compound-quality rw status
compound-quality rw pause
compound-quality rw start
```

Behavior:
- `rw start` resumes the loop only.
- `rw step` runs one full loop cycle (`reflect` + dispatch regeneration).

Outputs:
- `.quality/dispatch/ralph-loop.json` (machine-readable current loop state)
- `.quality/dispatch/ralph-control.json` (pause/resume control)

`rw` and `ralph` are aliases for `ralph-loop`.

Or via package scripts:

```json
{
  "scripts": {
    "reflect": "compound-quality reflect --config .compound-quality.json"
  }
}
```

## Config

Schema: `schemas/compound-quality.schema.json`

Minimal example:

```json
{
  "version": 1,
  "qualityDir": ".quality",
  "commands": {
    "typecheck": "pnpm turbo typecheck",
    "lint": "pnpm lint",
    "test": "pnpm turbo test -- --coverage",
    "build": "pnpm build"
  },
  "coverage": {
    "packageDirs": ["shared", "daemon", "web"],
    "summaryFile": "coverage/coverage-summary.json",
    "expectedPackages": 3
  },
  "verify": {
    "enabled": true,
    "policyPacks": ["builtin:autonomy-core"],
    "requiredTaskEvidence": true,
    "taskIdSources": ["cli", "env", "branch"],
    "envTaskIdVar": "CQ_TASK_ID",
    "doneEvidenceDir": ".quality/done-evidence",
    "evidenceSchemaFile": "docs/engineering/schemas/autonomy-done-evidence.schema.json",
    "waiversFile": ".quality/waivers.json",
    "gates": []
  }
}
```

A full ShellSwarm example is in `examples/shellswarm/.compound-quality.json`.

## Output

- `.quality/scorecard.json`
- `.quality/verification.json` (when running `verify`)
- `.quality/patterns.json`
- `.quality/reflections/*.md`
- `.quality/suggested-updates/*.md`
- `.quality/dispatch/plan.json`
- `.quality/dispatch/QUEUE.md`
- `.quality/dispatch/prompts/*.md`

## Behavior

- Coverage floor ratchets only on qualified full coverage runs.
- `verify` runs configurable gates (`command`, `file_exists`, `json_schema`, `regex`, `custom_script`) and fails closed on required-gate failures.
- `json_schema` gates support the common object/array/required/pattern/$ref/allOf/if+then subset used by autonomy evidence schemas; use `custom_script` for stricter or nonstandard validators.
- Built-in policy packs can define org-wide standards; repo-level config can override/extend gates.
- Task-linked done evidence can be enforced via `requiredTaskEvidence` + schema gates.
- Pattern promotions:
  - `>= 3` sightings: suggest CLAUDE rule
  - `>= 5` sightings: suggest lint rule

## License

Proprietary and confidential. Copyright (c) Croux Inc. All rights reserved.
