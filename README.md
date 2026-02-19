# @croux-inc/compound-quality

Config-driven CLI for a compound engineering quality loop.

It runs your quality commands, computes a score, ratchets coverage floors, detects repeated patterns, and writes artifacts to `.quality/`.

## Install (Private)

This package is intentionally **not** published to the public npm registry.

### Option 1: GitHub Packages (recommended)

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

### Option 2: Install directly from private GitHub repo

```bash
pnpm add -D git+ssh://git@github.com/Croux-Inc/compound-quality.git#v0.1.2
```

Pin to a tag (`#vX.Y.Z`) so all team members use the same version.

## Publish (Maintainers)

1. Bump the package version:

```bash
npm version patch
```

2. Push commit + tag:

```bash
git push origin main --follow-tags
```

3. GitHub Actions publishes automatically from tag `v*` via:

`/.github/workflows/publish-private-package.yml`

4. Verify:

```bash
npm view @croux-inc/compound-quality version --registry=https://npm.pkg.github.com
```

`publishConfig.registry` is preconfigured in `package.json` for GitHub Packages.

## Usage

Create `.compound-quality.json` in your repo, then run:

```bash
compound-quality reflect --config .compound-quality.json
```

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
  }
}
```

A full ShellSwarm example is in `examples/shellswarm/.compound-quality.json`.

## Output

- `.quality/scorecard.json`
- `.quality/patterns.json`
- `.quality/reflections/*.md`
- `.quality/suggested-updates/*.md`

## Behavior

- Coverage floor ratchets only on qualified full coverage runs.
- Pattern promotions:
  - `>= 3` sightings: suggest CLAUDE rule
  - `>= 5` sightings: suggest lint rule

## License

Proprietary and confidential. Copyright (c) Croux Inc. All rights reserved.
