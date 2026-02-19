#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${GITHUB_PACKAGES_TOKEN:-}" ]]; then
  echo "GITHUB_PACKAGES_TOKEN is not set."
  echo "Create a token with read:packages and set it first:"
  echo "  export GITHUB_PACKAGES_TOKEN=ghp_xxx"
  exit 1
fi

NPMRC_PATH="${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
mkdir -p "$(dirname "$NPMRC_PATH")"
touch "$NPMRC_PATH"

tmp_file="$(mktemp)"
grep -vE '^@croux-inc:registry=https://npm\.pkg\.github\.com$|^//npm\.pkg\.github\.com/:_authToken=|^always-auth=true$' "$NPMRC_PATH" > "$tmp_file" || true
mv "$tmp_file" "$NPMRC_PATH"

cat >> "$NPMRC_PATH" <<EOF
@croux-inc:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
always-auth=true
EOF

echo "Updated npm auth config at $NPMRC_PATH"
echo "You can now install with:"
echo "  pnpm add -D @croux-inc/compound-quality"
