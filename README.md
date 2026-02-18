# @croux-inc/compound-quality

Config-driven CLI for a compound engineering quality loop.

It runs your quality commands, computes a score, ratchets coverage floors, detects repeated patterns, and writes artifacts to `.quality/`.

## Install

```bash
pnpm add -D @croux-inc/compound-quality
```

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

MIT
