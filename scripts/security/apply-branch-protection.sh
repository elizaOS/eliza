#!/usr/bin/env bash
# Reconciles one reviewed exact-ref repository ruleset manifest. Every mode
# requires the manifest explicitly; mutation additionally requires --apply and
# refuses foreign active rules effective on the target before and after it.

set -euo pipefail

MANIFEST=""
REPO="${GITHUB_REPOSITORY:-elizaOS/eliza}"
MODE="check"

usage() {
  cat <<EOF_USAGE
Usage: $0 --manifest PATH [--repo OWNER/NAME] [--check|--dry-run|--apply]

Checks one reviewed exact-ref repository ruleset. --dry-run prints that payload
without contacting GitHub. --apply creates or updates only the named ruleset,
then repeats overlap detection and semantic readback. Every mode requires an
explicit --manifest so main and develop can never be selected implicitly.
EOF_USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || { echo "error: --repo requires OWNER/NAME" >&2; exit 2; }
      REPO="$2"
      shift 2
      ;;
    --manifest)
      [[ $# -ge 2 ]] || { echo "error: --manifest requires PATH" >&2; exit 2; }
      MANIFEST="$2"
      shift 2
      ;;
    --check) MODE="check"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --apply) MODE="apply"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$MANIFEST" ]]; then
  echo "error: --manifest is required in every mode" >&2
  usage >&2
  exit 2
fi
if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "error: --repo must be OWNER/NAME" >&2
  exit 2
fi
if [[ ! -f "$MANIFEST" ]]; then
  echo "error: ruleset manifest not found: $MANIFEST" >&2
  exit 1
fi

if [[ "$MODE" != "dry-run" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "error: gh CLI is required for ruleset readback" >&2
    exit 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "error: gh is not authenticated; set GH_TOKEN or run gh auth login" >&2
    exit 1
  fi
fi

node - "$REPO" "$MANIFEST" "$MODE" <<'EOF_NODE'
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const [repo, manifestPath, mode] = process.argv.slice(2);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readManifest() {
  let value;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`invalid ruleset manifest: ${error.message}`);
  }
  if (
    value.target !== "branch" ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    fail("manifest must name a branch ruleset");
  }
  const refs = value.conditions?.ref_name?.include;
  const excludes = value.conditions?.ref_name?.exclude;
  if (
    !Array.isArray(refs) ||
    refs.length === 0 ||
    new Set(refs).size !== refs.length ||
    refs.some(
      (ref) =>
        typeof ref !== "string" ||
        !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref),
    ) ||
    !Array.isArray(excludes) ||
    excludes.length !== 0
  ) {
    fail(
      "manifest ref_name conditions must contain unique exact refs/heads/* includes and no excludes",
    );
  }
  return value;
}

const expected = readManifest();
const targetRefs = expected.conditions.ref_name.include;
const expectedPayload = `${JSON.stringify(expected)}\n`;

if (mode === "dry-run") {
  process.stdout.write(expectedPayload);
  process.exit(0);
}

function runGh(args, input) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) fail(`gh invocation failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    fail(
      `gh ${args.slice(0, 3).join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function ghJson(args, input) {
  const source = runGh(["api", ...args], input);
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`GitHub returned invalid JSON: ${error.message}`);
  }
}

function paginatedArray(endpoint, label) {
  const pages = ghJson(["--paginate", "--slurp", endpoint]);
  if (
    !Array.isArray(pages) ||
    pages.some((page) => !Array.isArray(page))
  ) {
    fail(`${label} did not return paginated arrays`);
  }
  return pages.flat();
}

function listRulesets() {
  return paginatedArray(
    `repos/${repo}/rulesets?includes_parents=true&per_page=100`,
    "repository ruleset listing",
  );
}

function rulesetDetail(id) {
  return ghJson([`repos/${repo}/rulesets/${id}`]);
}

function effectiveRules(ref) {
  // Let GitHub evaluate its own fnmatch dialect. This endpoint returns every
  // active rule effective on the exact branch, including inherited rules.
  const branch = ref.slice("refs/heads/".length);
  return paginatedArray(
    `repos/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
    `effective rule listing for ${ref}`,
  );
}

function validRulesetId(value) {
  return (
    Number.isInteger(value) ||
    (typeof value === "string" && value.length > 0)
  );
}

function inspectLive(label) {
  const listed = listRulesets();
  const sameName = listed.filter((item) => item.name === expected.name);
  if (sameName.length > 1) {
    fail(
      `${label}: multiple rulesets are named '${expected.name}'; refusing ambiguous reconciliation`,
    );
  }
  if (sameName.length === 1 && sameName[0].source_type !== "Repository") {
    fail(
      `${label}: ruleset '${expected.name}' is inherited rather than repository-owned`,
    );
  }
  const ownId = sameName.length === 1 ? sameName[0].id : null;
  if (
    ownId !== null &&
    (typeof sameName[0].source !== "string" ||
      sameName[0].source.toLowerCase() !== repo.toLowerCase())
  ) {
    fail(
      `${label}: repository-owned ruleset '${expected.name}' has an unexpected source`,
    );
  }

  const ownEffectiveRefs = new Set();
  for (const ref of targetRefs) {
    for (const rule of effectiveRules(ref)) {
      const ruleId = rule?.ruleset_id;
      const sourceType = rule?.ruleset_source_type;
      const source = rule?.ruleset_source;
      if (
        !validRulesetId(ruleId) ||
        typeof sourceType !== "string" ||
        sourceType.length === 0 ||
        typeof source !== "string" ||
        source.length === 0
      ) {
        fail(
          `${label}: effective rule on ${ref} omitted ruleset attribution`,
        );
      }
      if (ownId !== null && String(ruleId) === String(ownId)) {
        if (
          sourceType !== "Repository" ||
          source.toLowerCase() !== repo.toLowerCase()
        ) {
          fail(
            `${label}: expected ruleset attribution is not repository-owned`,
          );
        }
        ownEffectiveRefs.add(ref);
        continue;
      }
      fail(
        `${label}: foreign effective rule '${rule.type || "unknown"}' from ruleset ${ruleId} (${sourceType}) overlaps ${ref}`,
      );
    }
  }
  return { ownEffectiveRefs, ownId };
}

function requireEffectiveTargets(snapshot, label) {
  if (expected.enforcement !== "active") return;
  for (const ref of targetRefs) {
    if (!snapshot.ownEffectiveRefs.has(ref)) {
      fail(`${label}: expected active ruleset has no effective rule on ${ref}`);
    }
  }
}

const before = inspectLive("preflight");
let rulesetId = before.ownId;

if (mode === "apply") {
  if (rulesetId !== null) {
    ghJson(
      ["-X", "PUT", `repos/${repo}/rulesets/${rulesetId}`, "--input", "-"],
      expectedPayload,
    );
    console.log(`updated ruleset ${expected.name} (${rulesetId})`);
  } else {
    const created = ghJson(
      ["-X", "POST", `repos/${repo}/rulesets`, "--input", "-"],
      expectedPayload,
    );
    if (!validRulesetId(created.id)) {
      fail("created ruleset response omitted id");
    }
    rulesetId = created.id;
    console.log(`created ruleset ${expected.name} (${rulesetId})`);
  }
  const postflight = inspectLive("postflight");
  if (String(postflight.ownId) !== String(rulesetId)) {
    fail("postflight ruleset identity differs from the mutation response");
  }
  requireEffectiveTargets(postflight, "postflight");
} else if (rulesetId !== null) {
  requireEffectiveTargets(before, "preflight");
}

if (rulesetId === null) {
  fail(`required repository ruleset '${expected.name}' is absent`);
}

const actual = rulesetDetail(rulesetId);
const pick = (template, value) => {
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) return value;
    if (template.length !== value.length) return value;
    return template.map((entry, index) => pick(entry, value[index]));
  }
  if (template && typeof template === "object") {
    return Object.fromEntries(
      Object.keys(template).map((key) => [
        key,
        pick(template[key], value?.[key]),
      ]),
    );
  }
  return value;
};
const expectedTypes = expected.rules.map((rule) => rule.type).sort();
const actualTypes = Array.isArray(actual.rules)
  ? actual.rules.map((rule) => rule.type).sort()
  : [];
const projected = {
  ...pick(
    {
      name: expected.name,
      target: expected.target,
      enforcement: expected.enforcement,
      bypass_actors: expected.bypass_actors,
      conditions: expected.conditions,
    },
    actual,
  ),
  rules: expected.rules.map((rule) => {
    const matches = Array.isArray(actual.rules)
      ? actual.rules.filter((candidate) => candidate.type === rule.type)
      : [];
    if (matches.length !== 1) {
      return { type: rule.type, count: matches.length };
    }
    return pick(rule, matches[0]);
  }),
};

const differingPaths = new Set();
const recordDifferences = (template, value, path) => {
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) {
      differingPaths.add(path);
      return;
    }
    if (template.length !== value.length) {
      differingPaths.add(`${path}.length`);
    }
    for (let index = 0; index < Math.min(template.length, value.length); index++) {
      recordDifferences(template[index], value[index], `${path}[${index}]`);
    }
    return;
  }
  if (template && typeof template === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      differingPaths.add(path);
      return;
    }
    for (const key of Object.keys(template)) {
      recordDifferences(template[key], value[key], `${path}.${key}`);
    }
    return;
  }
  if (JSON.stringify(template) !== JSON.stringify(value)) {
    differingPaths.add(path);
  }
};
recordDifferences(expected, projected, "ruleset");
if (JSON.stringify(expectedTypes) !== JSON.stringify(actualTypes)) {
  differingPaths.add("ruleset.rules.type-set");
}

if (
  JSON.stringify(expectedTypes) !== JSON.stringify(actualTypes) ||
  JSON.stringify(projected) !== JSON.stringify(expected)
) {
  console.error(`error: repository ruleset drift detected for ${expected.name}`);
  console.error(
    `error: redacted drift fields: ${[...differingPaths].sort().join(", ") || "unknown"}`,
  );
  process.exit(1);
}
console.log(`ruleset readback passed: ${expected.name}`);
EOF_NODE
