#!/usr/bin/env bash
# Reconciles the reviewed no-bypass repository ruleset for main and develop.
# The default mode is a read-only semantic drift check; mutation requires the
# explicit --apply flag and repository Administration permission.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANIFEST="$REPO_ROOT/.github/rulesets/required-branches.json"
REPO="${GITHUB_REPOSITORY:-elizaOS/eliza}"
MODE="check"

usage() {
  cat <<EOF_USAGE
Usage: $0 [--repo OWNER/NAME] [--manifest PATH] [--check|--dry-run|--apply]

Checks the canonical repository ruleset by default. --dry-run prints the exact
reviewed payload without contacting GitHub. --apply creates or updates only the
named ruleset and then performs the same semantic readback.
EOF_USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --check) MODE="check"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "error: --repo must be OWNER/NAME" >&2
  exit 2
fi
if [[ ! -f "$MANIFEST" ]]; then
  echo "error: ruleset manifest not found: $MANIFEST" >&2
  exit 1
fi

manifest_json="$(node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.target !== "branch" || !value.name) throw new Error("manifest must name a branch ruleset");
  process.stdout.write(JSON.stringify(value));
' "$MANIFEST")"
ruleset_name="$(printf '%s' "$manifest_json" | node -e '
  let source = "";
  process.stdin.on("data", (chunk) => (source += chunk));
  process.stdin.on("end", () => process.stdout.write(JSON.parse(source).name));
')"

if [[ "$MODE" == "dry-run" ]]; then
  printf '%s\n' "$manifest_json"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI is required for ruleset readback" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated; set GH_TOKEN or run gh auth login" >&2
  exit 1
fi

list_json="$(gh api "repos/$REPO/rulesets?includes_parents=false")"
ruleset_ids="$(printf '%s' "$list_json" | node -e '
  let source = "";
  const name = process.argv[1];
  process.stdin.on("data", (chunk) => (source += chunk));
  process.stdin.on("end", () => {
    const ids = JSON.parse(source).filter((item) => item.name === name).map((item) => item.id);
    process.stdout.write(ids.join("\n"));
  });
' "$ruleset_name")"
ruleset_count="$(printf '%s\n' "$ruleset_ids" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$ruleset_count" -gt 1 ]]; then
  echo "error: multiple repository rulesets are named '$ruleset_name'; refusing ambiguous reconciliation" >&2
  exit 1
fi
ruleset_id="$(printf '%s\n' "$ruleset_ids" | sed -n '1p')"

if [[ "$MODE" == "apply" ]]; then
  if [[ -n "$ruleset_id" ]]; then
    gh api -X PUT "repos/$REPO/rulesets/$ruleset_id" --input "$MANIFEST" >/dev/null
    echo "updated ruleset $ruleset_name ($ruleset_id)"
  else
    created_json="$(gh api -X POST "repos/$REPO/rulesets" --input "$MANIFEST")"
    ruleset_id="$(printf '%s' "$created_json" | node -e '
      let source = "";
      process.stdin.on("data", (chunk) => (source += chunk));
      process.stdin.on("end", () => process.stdout.write(String(JSON.parse(source).id)));
    ')"
    echo "created ruleset $ruleset_name ($ruleset_id)"
  fi
fi

if [[ -z "$ruleset_id" ]]; then
  echo "error: required repository ruleset '$ruleset_name' is absent" >&2
  exit 1
fi

actual_json="$(gh api "repos/$REPO/rulesets/$ruleset_id")"
printf '%s' "$actual_json" | node -e '
  const fs = require("node:fs");
  const expected = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  let source = "";
  process.stdin.on("data", (chunk) => (source += chunk));
  process.stdin.on("end", () => {
    const actual = JSON.parse(source);
    const pick = (template, value) => {
      if (Array.isArray(template)) {
        if (!Array.isArray(value)) return value;
        return template.map((entry, index) => pick(entry, value[index]));
      }
      if (template && typeof template === "object") {
        return Object.fromEntries(Object.keys(template).map((key) => [key, pick(template[key], value?.[key])]));
      }
      return value;
    };
    const expectedTypes = expected.rules.map((rule) => rule.type).sort();
    const actualTypes = actual.rules.map((rule) => rule.type).sort();
    const projected = {
      ...pick({
        name: expected.name,
        target: expected.target,
        enforcement: expected.enforcement,
        bypass_actors: expected.bypass_actors,
        conditions: expected.conditions,
      }, actual),
      rules: expected.rules.map((rule) => {
        const matches = actual.rules.filter((candidate) => candidate.type === rule.type);
        if (matches.length !== 1) return { type: rule.type, count: matches.length };
        return pick(rule, matches[0]);
      }),
    };
    if (JSON.stringify(expectedTypes) !== JSON.stringify(actualTypes) || JSON.stringify(projected) !== JSON.stringify(expected)) {
      console.error(`error: repository ruleset drift detected for ${expected.name}`);
      console.error(JSON.stringify({ expected, actual: projected }, null, 2));
      process.exit(1);
    }
    console.log(`ruleset readback passed: ${expected.name}`);
  });
' "$MANIFEST"
