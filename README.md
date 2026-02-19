# @croux-inc/compound-quality

Config-driven CLI for a compound engineering quality loop.

It runs your quality commands, computes a score, ratchets coverage floors, detects repeated patterns, and writes artifacts to `.quality/`.

## Quickstart (Recommended)

For internal teams, the lowest-friction path is install from a tagged GitHub release:

```bash
pnpm add -D git+ssh://git@github.com/Croux-Inc/compound-quality.git#v0.1.4
npx compound-quality init
pnpm reflect
```

What this does:
- installs a pinned version from the private repo,
- creates `.compound-quality.json` if missing,
- adds `"reflect"` script to your `package.json` if missing.

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
