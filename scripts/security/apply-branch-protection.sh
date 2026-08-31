#!/usr/bin/env bash
# Reconciles one reviewed exact-ref repository ruleset manifest. Every mode
# requires the manifest explicitly; mutation additionally requires --apply, an
# active source manifest, and no foreign active rules on the target.

set -euo pipefail

MANIFEST=""
REPO="${GITHUB_REPOSITORY:-elizaOS/eliza}"
MODE="check"

usage() {
  cat <<EOF_USAGE
Usage: $0 --manifest PATH [--repo OWNER/NAME] [--check|--dry-run|--apply]

Checks one reviewed exact-ref repository ruleset. --dry-run prints that payload
without contacting GitHub. --apply creates or updates only the named ruleset,
then repeats overlap detection and semantic readback. Apply rejects disabled or
evaluate manifests: activation requires a reviewed source change to active.
Every mode requires an explicit --manifest so refs are never selected implicitly.
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
  if (!["active", "disabled", "evaluate"].includes(value.enforcement)) {
    fail("manifest enforcement must be active, disabled, or evaluate");
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
if (mode === "apply" && expected.enforcement !== "active") {
  fail(
    `manifest '${expected.name}' cannot be applied while enforcement is '${expected.enforcement}'; a reviewed source change to active is required first`,
  );
}
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
const sortObjectKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObjectKeys(value[key])]),
  );
};
const sortSetLikeArray = (values) =>
  values.map(sortObjectKeys).sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
const normalizeForComparison = (ruleset, expectedSide) => {
  const normalized = structuredClone(ruleset);
  if (Array.isArray(normalized?.bypass_actors)) {
    normalized.bypass_actors = sortSetLikeArray(normalized.bypass_actors);
  }
  const refNames = normalized?.conditions?.ref_name;
  if (refNames && typeof refNames === "object" && !Array.isArray(refNames)) {
    for (const key of ["include", "exclude"]) {
      if (Array.isArray(refNames[key])) {
        refNames[key] = sortSetLikeArray(refNames[key]);
      }
    }
  }
  if (!Array.isArray(normalized?.rules)) return normalized;
  for (const rule of normalized.rules) {
    if (rule?.type === "required_status_checks") {
      const checks = rule.parameters?.required_status_checks;
      if (Array.isArray(checks)) {
        rule.parameters.required_status_checks = sortSetLikeArray(
          checks.map((check) => {
            if (!check || typeof check !== "object" || Array.isArray(check)) {
              return check;
            }
            return {
              ...check,
              integration_id: Object.hasOwn(check, "integration_id")
                ? check.integration_id
                : null,
            };
          }),
        );
      }
    }
    if (
      rule?.type === "pull_request" &&
      rule.parameters &&
      typeof rule.parameters === "object" &&
      !Array.isArray(rule.parameters)
    ) {
      const parameters = rule.parameters;
      // These are symmetric absence-equivalences observed from the versioned
      // REST API. Non-default values remain intact and therefore drift.
      const materializedDefaults = {
        dismissal_restriction: { allowed_actors: [], enabled: false },
        ignore_approvals_from_contributors: false,
        required_reviewers: [],
      };
      for (const [key, defaultValue] of Object.entries(materializedDefaults)) {
        if (!Object.hasOwn(parameters, key)) {
          parameters[key] = structuredClone(defaultValue);
        }
      }
      if (Array.isArray(parameters.allowed_merge_methods)) {
        parameters.allowed_merge_methods = sortSetLikeArray(
          parameters.allowed_merge_methods,
        );
      }
      if (Array.isArray(parameters.required_reviewers)) {
        parameters.required_reviewers = sortSetLikeArray(
          parameters.required_reviewers.map((reviewer) => {
            if (
              !reviewer ||
              typeof reviewer !== "object" ||
              Array.isArray(reviewer)
            ) {
              return reviewer;
            }
            const normalizedReviewer = { ...reviewer };
            if (Array.isArray(normalizedReviewer.file_patterns)) {
              normalizedReviewer.file_patterns = sortSetLikeArray(
                normalizedReviewer.file_patterns,
              );
            }
            return normalizedReviewer;
          }),
        );
      }
      const restriction = parameters.dismissal_restriction;
      if (
        restriction &&
        typeof restriction === "object" &&
        !Array.isArray(restriction) &&
        restriction.enabled === false &&
        !Object.hasOwn(restriction, "allowed_actors")
      ) {
        restriction.allowed_actors = [];
      }
      if (
        restriction &&
        typeof restriction === "object" &&
        !Array.isArray(restriction) &&
        Array.isArray(restriction.allowed_actors)
      ) {
        restriction.allowed_actors = sortSetLikeArray(
          restriction.allowed_actors,
        );
      }
      // This response-only field is absent from the OpenAPI schema but is
      // materialized as true in current REST readback. Require that explicit
      // live evidence rather than treating an absent actual field as equal.
      if (
        expectedSide &&
        !Object.hasOwn(
          parameters,
          "require_extra_approval_for_unattributed_changes",
        )
      ) {
        parameters.require_extra_approval_for_unattributed_changes = true;
      }
    }
  }
  return sortObjectKeys(normalized);
};
// GitHub materializes several optional defaults in ruleset responses. Normalize
// only comparison copies, preserve every non-default or unknown nested policy
// field, and leave the reviewed mutation payload unchanged.
const expectedComparable = normalizeForComparison(expected, true);
const actualComparable = normalizeForComparison(actual, false);
const expectedTypes = expectedComparable.rules
  .map((rule) => rule.type)
  .sort();
const actualTypes = Array.isArray(actualComparable.rules)
  ? actualComparable.rules.map((rule) => rule.type).sort()
  : [];
const expectedPolicy = sortObjectKeys({
  name: expectedComparable.name,
  target: expectedComparable.target,
  enforcement: expectedComparable.enforcement,
  bypass_actors: expectedComparable.bypass_actors,
  conditions: expectedComparable.conditions,
  rules: expectedComparable.rules,
});
const projected = sortObjectKeys({
  name: actualComparable.name,
  target: actualComparable.target,
  enforcement: actualComparable.enforcement,
  bypass_actors: actualComparable.bypass_actors,
  conditions: actualComparable.conditions,
  rules: expectedComparable.rules.map((rule) => {
    const matches = Array.isArray(actualComparable.rules)
      ? actualComparable.rules.filter(
          (candidate) => candidate.type === rule.type,
        )
      : [];
    if (matches.length !== 1) {
      return { type: rule.type, count: matches.length };
    }
    return matches[0];
  }),
});

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
    const keys = new Set([...Object.keys(template), ...Object.keys(value)]);
    for (const key of keys) {
      if (!Object.hasOwn(template, key) || !Object.hasOwn(value, key)) {
        differingPaths.add(`${path}.${key}`);
        continue;
      }
      recordDifferences(template[key], value[key], `${path}.${key}`);
    }
    return;
  }
  if (JSON.stringify(template) !== JSON.stringify(value)) {
    differingPaths.add(path);
  }
};
recordDifferences(expectedPolicy, projected, "ruleset");
if (JSON.stringify(expectedTypes) !== JSON.stringify(actualTypes)) {
  differingPaths.add("ruleset.rules.type-set");
}

if (
  JSON.stringify(expectedTypes) !== JSON.stringify(actualTypes) ||
  JSON.stringify(projected) !== JSON.stringify(expectedPolicy)
) {
  console.error(`error: repository ruleset drift detected for ${expected.name}`);
  console.error(
    `error: redacted drift fields: ${[...differingPaths].sort().join(", ") || "unknown"}`,
  );
  process.exit(1);
}
console.log(`ruleset readback passed: ${expected.name}`);
EOF_NODE
