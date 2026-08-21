#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
/**
 * Contract for the pinned Bun runtime (#13402 item 2 + item 5, #17044). Keeps
 * every authoritative install path in the repository on ONE published concrete
 * Bun version so a stale bump, an unpublished version, or a regression back to
 * floating `canary`/`latest` cannot slip through unnoticed.
 *
 * Background: `bun install --frozen-lockfile` fails when Bun reserializes
 * bun.lock to lockfileVersion 2, which floating `canary`/`latest` do on their
 * own cadence (#11184/#9454), and an unpublished packageManager version 404s
 * during setup (#17044 — bare `setup-bun` resolving the repo declaration died
 * on `bun@1.4.0`). The canonical value lives in `.github/ci-bun-version.json`;
 * GitHub Actions cannot interpolate a file into `${{ }}` at parse time, so the
 * literal is repeated at each site and this contract is what guarantees the
 * copies never drift from the source of truth.
 *
 * Checked statically against the tracked tree (git ls-files when the root is a
 * git checkout, so populated submodules and untracked build output cannot
 * change the result; a plain directory walk only for synthetic fixture trees):
 *
 *   1. Every `bun-version:`/`BUN_VERSION:` value in workflows, composite
 *      actions, and workflow-shaped templates outside `.github` is the
 *      canonical pin, an expression that RESOLVES within its declaring scope,
 *      or an explicitly allowlisted floating cell. YAML is parsed
 *      structurally and expressions resolve per JOB, mirroring the Actions
 *      runtime: `env.BUN_VERSION` reads this step's env, then the job env,
 *      then the workflow env — a declaration in a sibling job proves nothing;
 *      `matrix.bun-version` requires cells declared by the SAME job's
 *      strategy; `inputs.bun-version` resolves against a composite action's
 *      declared input or a workflow_call input with a canonical default.
 *      Concrete divergence, floating values, expressions with no declaration
 *      in scope, and files that do not parse as YAML all fail.
 *   2. Every `oven-sh/setup-bun` use is pinned to a reviewed commit SHA and
 *      wires an explicit `bun-version` — the action's implicit default is
 *      `latest`, so an absent key is a floating runtime.
 *   3. Every `bun.sh/install` shell install and every oven-sh Bun release
 *      artifact URL in Dockerfiles, shell scripts, YAML runtime manifests,
 *      cloud-init templates, and .mjs installers pins the canonical version;
 *      `releases/latest` is always floating. A `${BUN_VERSION}` reference is
 *      accepted only when the file PROVES a canonical default before the use:
 *      a Dockerfile ARG/ENV chain that bottoms out in a concrete default
 *      (respecting Docker stage scoping — `FROM oven/bun:${BUN_VERSION}`
 *      interpolates only ARGs declared before the first FROM), a shell
 *      `BUN_VERSION="${BUN_VERSION:-<pin>}"`/`BUN_VERSION=<pin>` assignment
 *      earlier in the script, or (in workflow YAML) an env declaration
 *      visible to the enclosing job. An unproven expression is a floating
 *      runtime. A presence-only `command -v bun` guard may not preserve an
 *      arbitrary preinstalled runtime; it must compare `bun --version` with
 *      the canonical pin (a `${BUN_VERSION}` comparison needs the same proven
 *      default).
 *   4. Every `packageManager` declaring Bun equals `bun@<canonical>`, and the
 *      root `@types/bun`/`bun-types` anchors equal the canonical version
 *      exactly. Non-root workspace type declarations are classified in the
 *      inventory (exact-canonical / compatible-range / drift / unparseable)
 *      but stay advisory: they are compatibility signals, not runtime
 *      selectors (#17044 scope).
 *   5. A composite action declaring a `bun-version` input must default it to
 *      the canonical pin, since callers relying on the default otherwise
 *      float silently — the previous `canary` default covered 112 call sites.
 *      A workflow_call `bun-version` input carries the same obligation.
 *   6. A FLOATING_ALLOWLIST entry is additive-only and JOB-scoped: it names
 *      the file, the exact job allowed to float, the value, and a non-empty
 *      reason — and the same file must wire the canonical pin in a DIFFERENT
 *      job (a stable sibling lane), so a sanctioned canary cell can only ever
 *      run in addition to the pinned runtime, never as the default or sole
 *      one.
 *   7. Deterministic gate and deploy workflows (GATE_WORKFLOWS) additionally
 *      must wire the canonical literal directly, so required checks never
 *      depend on indirection to become reproducible.
 *
 * The full scan is returned (and writable via --inventory) as a
 * machine-readable inventory of every resolution site and its classification,
 * including the deliberately excluded surfaces. Embedded platform Bun builds
 * (the Android staging pipeline and the RISC-V custom build) are a separate,
 * device-proven shipping boundary: they are inventoried as excluded, never
 * version-checked here.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { spawnSync } from "./lib/spawn-sync-captured.mjs";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const VERSION_FILE = ".github/ci-bun-version.json";
const WORKFLOW_DIR = ".github/workflows";
const ACTIONS_DIR = ".github/actions";

// Every oven-sh/setup-bun ref must resolve to one of these reviewed commits.
// 0c5077e5 is the v2 tag (verified equal to the upstream tag object); adding a
// new SHA here is the review step for adopting a new action version.
const REVIEWED_SETUP_BUN_SHAS = new Set([
  "0c5077e51419868618aeaa5fe8019c62421857d6",
]);

// Non-authoritative floating cells, e.g. an upstream Bun compatibility matrix
// that runs IN ADDITION to the pinned lane. Each entry scopes one file, one
// JOB, and the exact floating value that job may wire, and must carry a
// non-empty reason; the same file must also wire the canonical pin in a
// different job (additive-only — a canary can never be a file's sole or
// default runtime). Empty by design: no surface currently has a sanctioned
// reason to float, and an entry added here is a reviewable diff rather than
// silent drift.
const FLOATING_ALLOWLIST = [];

// Deliberately excluded surfaces, inventoried so the exclusion is visible
// rather than silent. The embedded entries are the Android/RISC-V Bun binary
// shipping boundary #17044 scopes out (their versions are proven on-device,
// not by text equality); the advisory entry is developer-machine guidance,
// not a repository runtime selector.
const EXCLUDED_SURFACES = [
  {
    prefix: "packages/app-core/scripts/bun-riscv64/",
    classification: "embedded-boundary-excluded",
    reason: "custom RISC-V Bun build with its own device-proof record",
  },
  {
    prefix: "packages/app-core/scripts/lib/stage-android-agent.mjs",
    classification: "embedded-boundary-excluded",
    reason: "Android embedded Bun staging; channel-driven, device-proven",
  },
  {
    prefix: "packages/app-core/src/cli/doctor/checks.ts",
    classification: "advisory-excluded",
    reason: "doctor fix hint for the developer's machine, not a repo runtime",
  },
  {
    prefix: "packages/scripts/ci-bun-version-contract.mjs",
    classification: "contract-self-excluded",
    reason: "this contract's own policy text names the install idiom",
  },
];

// Required, scheduled, and deploy-critical install lanes that must wire the
// concrete pin directly (not merely resolve through indirection). The required
// `ci-ok` aggregate (test.yml), the develop PR gate, the canary deploy, and
// the canonical cloud release are the load-bearing paths. After #18996 split
// the canary deploy (`cloud-cf-deploy.yml`) from the canonical release
// (`cloud-cf-release.yml`), the release workflow is the one that actually
// publishes to production. The general workflow scan already rejects floating
// pins; gate membership additionally prevents the release file from
// disappearing or replacing its direct canonical literal with indirection
// (#19183).
const GATE_WORKFLOWS = [
  "test.yml",
  "develop-pr.yml",
  "cloud-cf-deploy.yml",
  "cloud-cf-release.yml",
];

// Both the post-merge suite and the required develop PR gate must execute the
// contract and publish its exact-head inventory. Keeping the PR lane here is
// what prevents a runtime drift from merging before test.yml runs on develop.
const CONTRACT_ENFORCEMENT_WORKFLOWS = new Set(["test.yml", "develop-pr.yml"]);

// A concrete pin: a plain semver, optionally with a prerelease/build suffix.
// Parse it deterministically because nested suffix quantifiers let a malformed
// version consume unbounded CI time before it is rejected.
function scanSemverIdentifiers(value, start, stopAtBuild) {
  let cursor = start;
  let identifierLength = 0;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (stopAtBuild && code === 43) {
      return identifierLength === 0 ? null : cursor;
    }
    if (code === 46) {
      if (identifierLength === 0) return null;
      identifierLength = 0;
      cursor += 1;
      continue;
    }
    const valid =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45;
    if (!valid) return null;
    identifierLength += 1;
    cursor += 1;
  }
  return identifierLength === 0 ? null : cursor;
}

export function isConcretePin(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  let cursor = 0;
  for (let component = 0; component < 3; component += 1) {
    const start = cursor;
    while (cursor < value.length) {
      const code = value.charCodeAt(cursor);
      if (code < 48 || code > 57) break;
      cursor += 1;
    }
    if (cursor === start) return false;
    if (component < 2) {
      if (value[cursor] !== ".") return false;
      cursor += 1;
    }
  }
  if (cursor === value.length) return true;
  if (value[cursor] === "-") {
    const prereleaseEnd = scanSemverIdentifiers(value, cursor + 1, true);
    if (prereleaseEnd === null) return false;
    cursor = prereleaseEnd;
  }
  if (cursor === value.length) return true;
  if (value[cursor] !== "+") return false;
  const buildEnd = scanSemverIdentifiers(value, cursor + 1, false);
  return buildEnd === value.length;
}
const FLOATING = new Set(["canary", "latest"]);

// Fixture-tree walk only (real repos are enumerated via git ls-files);
// skipping dependency/build dirs keeps synthetic trees cheap to scan.
const WALK_SKIP = new Set([
  "node_modules",
  ".git",
  ".turbo",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  "target",
]);

function isExpression(raw) {
  return typeof raw === "string" && raw.includes("${{");
}

const ENV_EXPRESSION = /^\$\{\{\s*env\.BUN_VERSION\s*\}\}$/;
const MATRIX_EXPRESSION = /^\$\{\{\s*matrix\.bun-version\s*\}\}$/;
const INPUTS_EXPRESSION = /^\$\{\{\s*inputs\.bun-version\s*\}\}$/;

// Minimal range check for the workspace type-anchor classification. Only the
// syntaxes that appear in this repo are modeled (`*`, exact, `^`, `~`);
// anything else classifies as unparseable so a new syntax surfaces in the
// inventory instead of being silently misfiled.
export function classifyTypeRange(range, canonical) {
  if (range === canonical) return "exact-canonical";
  if (range === "*") return "compatible-range";
  const caret = range.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  const tilde = range.match(/^~(\d+)\.(\d+)\.(\d+)$/);
  const exact = range.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const target = canonical.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!target) return "unparseable";
  const [tMaj, tMin, tPat] = target.slice(1).map(Number);
  const atLeast = (maj, min, pat) =>
    tMaj > maj ||
    (tMaj === maj && (tMin > min || (tMin === min && tPat >= pat)));
  if (caret) {
    const [maj, min, pat] = caret.slice(1).map(Number);
    return tMaj === maj && atLeast(maj, min, pat)
      ? "compatible-range"
      : "drift";
  }
  if (tilde) {
    const [maj, min, pat] = tilde.slice(1).map(Number);
    return tMaj === maj && tMin === min && tPat >= pat
      ? "compatible-range"
      : "drift";
  }
  if (exact) return "drift";
  return "unparseable";
}

// Tracked-file enumeration. A real checkout is read through git so the scan
// matches the checked-in tree exactly; the recursive walk exists only for the
// synthetic fixture trees the tests build (no `.git` there, by construction).
function trackedFiles(repoRoot) {
  if (existsSync(join(repoRoot, ".git"))) {
    // spawn-sync-captured routes child output through files: Bun's test runner
    // can hand back empty stdio pipes, which made 23k tracked files enumerate
    // as zero and the whole inventory silently vanish.
    const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) {
      throw new Error(
        `git ls-files failed for ${repoRoot}: status=${String(result.status)} ${result.stderr ?? ""}`,
        { cause: result.error },
      );
    }
    return result.stdout.split("\0").filter((entry) => entry.length > 0);
  }
  const found = [];
  const stack = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) stack.push(join(dir, entry.name));
      } else {
        found.push(
          join(dir, entry.name)
            .slice(repoRoot.length + 1)
            .split(sep)
            .join("/"),
        );
      }
    }
  }
  return found.sort();
}

function excludedSurface(rel) {
  return EXCLUDED_SURFACES.find((entry) => rel.startsWith(entry.prefix));
}

function makeLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const mapGet = (node, key) =>
  isMap(node)
    ? node.items.find((p) => isScalar(p.key) && String(p.key.value) === key)
        ?.value
    : undefined;

/**
 * Structured, job-scoped analysis of one YAML runtime surface (workflow,
 * composite action, or workflow-shaped template). Mirrors the GitHub Actions
 * scoping model so an expression is only "resolvable" when the declaration it
 * reads is actually visible to it at runtime — a BUN_VERSION env declared in
 * job B cannot back `${{ env.BUN_VERSION }}` in job A, and matrix cells only
 * exist inside the job whose strategy declares them. Returns null (plus a
 * violation) when the file does not parse: a runtime surface that cannot be
 * inspected must fail the contract, not vanish from the inventory.
 */
function analyzeYamlRuntime(text) {
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length > 0) {
    return { parseError: doc.errors[0].message.split("\n")[0] };
  }
  const lineOf = makeLineIndex(text);
  const values = []; // {key, raw, line, jobId, stepIndex, origin}
  const envDecls = { workflow: false, job: new Set(), step: new Set() };
  const matrixJobs = new Set();
  const setupBunSteps = []; // {ref, line, jobId, hasBunVersion}
  const jobRanges = new Map(); // jobId -> [startLine, endLine]
  let actionInput = null; // {default, line} for a composite bun-version input
  let workflowCallInput = null; // {default, line}

  const pushValue = (raw, node, scope) => {
    values.push({
      key: scope.key,
      raw,
      line: lineOf(node?.range?.[0] ?? 0),
      jobId: scope.jobId,
      stepIndex: scope.stepIndex,
      origin: scope.origin,
    });
  };

  const scalarRaw = (node) => {
    if (!isScalar(node)) return null;
    if (node.value === null || node.value === undefined) return "";
    return String(node.value).trim();
  };

  // segments: the key/index path from the document root down to (and
  // including) the matched bun-version/BUN_VERSION key.
  const handleVersionPair = (pair, segments) => {
    const key = segments[segments.length - 1];
    const jobId = segments[0] === "jobs" ? String(segments[1]) : null;
    const stepsAt = segments.indexOf("steps");
    const stepIndex =
      stepsAt !== -1 && typeof segments[stepsAt + 1] === "number"
        ? segments[stepsAt + 1]
        : null;
    const parent = segments[segments.length - 2];
    const inMatrix = segments.includes("matrix");
    const inInputs = parent === "inputs";
    const origin =
      parent === "env"
        ? stepIndex !== null
          ? "step-env"
          : jobId !== null
            ? "job-env"
            : "workflow-env"
        : inMatrix
          ? segments.includes("include")
            ? "matrix-include"
            : "matrix-cell"
          : parent === "with"
            ? "with"
            : inInputs
              ? "input-declaration"
              : "scalar";
    const scope = { key, jobId, stepIndex, origin };

    if (inInputs && key === "bun-version") {
      // Declaration site, not a value wiring. A bare `bun-version:` input
      // (no map, no default) still registers so the composite/workflow_call
      // default rule can fail it rather than this loop misfiling it.
      const defaultNode = isMap(pair.value)
        ? mapGet(pair.value, "default")
        : undefined;
      const declared = {
        default: defaultNode === undefined ? null : scalarRaw(defaultNode),
        line: lineOf(pair.key?.range?.[0] ?? 0),
      };
      if (segments.includes("workflow_call")) workflowCallInput = declared;
      else if (segments.length === 2) actionInput = declared;
      return;
    }

    if (isScalar(pair.value)) {
      const raw = scalarRaw(pair.value);
      pushValue(raw, pair.value, scope);
      if (
        key === "BUN_VERSION" &&
        parent === "env" &&
        raw !== null &&
        !isExpression(raw)
      ) {
        if (origin === "workflow-env") envDecls.workflow = true;
        else if (origin === "job-env") envDecls.job.add(jobId);
        else envDecls.step.add(`${jobId}\u0000${stepIndex}`);
      }
      return;
    }
    if (isSeq(pair.value)) {
      for (const item of pair.value.items) {
        if (isScalar(item)) {
          const raw = scalarRaw(item);
          pushValue(raw, item, { ...scope, origin: scope.origin });
          if (inMatrix && !isExpression(raw) && jobId !== null) {
            matrixJobs.add(jobId);
          }
        } else {
          pushValue(null, item, scope);
        }
      }
      return;
    }
    // A mapping (outside input declarations) or alias where a version value
    // belongs cannot be proven pinned — surface it instead of skipping.
    pushValue(null, pair.value ?? pair.key, scope);
  };

  const walk = (node, segments) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? String(pair.key.value) : "?";
        if (k === "bun-version" || k === "BUN_VERSION") {
          handleVersionPair(pair, segments.concat(k));
        }
        if (segments.length === 1 && segments[0] === "jobs") {
          const start = lineOf(pair.key?.range?.[0] ?? 0);
          const end = lineOf(
            (pair.value?.range?.[2] ?? pair.value?.range?.[1] ?? 0) - 1,
          );
          jobRanges.set(k, [start, Math.max(start, end)]);
        }
        walk(pair.value, segments.concat(k));
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => {
        walk(item, segments.concat(index));
      });
    }
  };
  walk(doc.contents, []);

  // Matrix include entries: a map inside strategy.matrix.include with a
  // bun-version key also declares cells for that job. handleVersionPair
  // already recorded the value; mark the job here.
  for (const v of values) {
    if (
      v.origin === "matrix-include" &&
      v.jobId !== null &&
      !isExpression(v.raw) &&
      v.raw !== null
    ) {
      matrixJobs.add(v.jobId);
    }
    if (
      v.origin === "matrix-cell" &&
      v.jobId !== null &&
      !isExpression(v.raw) &&
      v.raw !== null
    ) {
      matrixJobs.add(v.jobId);
    }
  }

  // setup-bun steps, from workflow jobs and composite `runs`.
  const collectSteps = (stepsNode, jobId) => {
    if (!isSeq(stepsNode)) return;
    stepsNode.items.forEach((step) => {
      if (!isMap(step)) return;
      const usesNode = mapGet(step, "uses");
      const uses = isScalar(usesNode) ? String(usesNode.value) : null;
      const match = uses?.match(/^oven-sh\/setup-bun@(.+)$/);
      if (!match) return;
      const withNode = mapGet(step, "with");
      setupBunSteps.push({
        ref: match[1],
        line: lineOf(usesNode.range?.[0] ?? 0),
        jobId,
        hasBunVersion: mapGet(withNode, "bun-version") !== undefined,
      });
    });
  };
  const jobsNode = mapGet(doc.contents, "jobs");
  if (isMap(jobsNode)) {
    for (const pair of jobsNode.items) {
      const jobId = isScalar(pair.key) ? String(pair.key.value) : "?";
      collectSteps(mapGet(pair.value, "steps"), jobId);
    }
  }
  const runsNode = mapGet(doc.contents, "runs");
  if (isMap(runsNode)) collectSteps(mapGet(runsNode, "steps"), null);

  const envVisible = (jobId, stepIndex) =>
    (jobId !== null &&
      stepIndex !== null &&
      envDecls.step.has(`${jobId}\u0000${stepIndex}`)) ||
    (jobId !== null && envDecls.job.has(jobId)) ||
    envDecls.workflow;

  const jobAtLine = (line) => {
    for (const [jobId, [start, end]] of jobRanges) {
      if (line >= start && line <= end) return jobId;
    }
    return null;
  };

  return {
    values,
    envVisible,
    matrixJobs,
    setupBunSteps,
    actionInput,
    workflowCallInput,
    jobAtLine,
  };
}

function isAllowlisted(allowlist, file, jobId, value) {
  return allowlist.some(
    (entry) =>
      entry.file === file &&
      entry.value === value &&
      (entry.job ?? null) === (jobId ?? null),
  );
}

// Validate every invariant against a repo layout rooted at `repoRoot`. Pure
// (no process exit / no console) so tests can drive it against fixture trees.
// Collects every violation before throwing one aggregate error, so a version
// bump sees the complete list of stale sites in a single run. Returns the
// canonical version and the full classified inventory on success. Read and
// parse failures on tracked files are deliberately NOT caught: a surface that
// cannot be inspected must fail the contract, not vanish from the inventory.
export function runContract(repoRoot = DEFAULT_REPO_ROOT, overrides = {}) {
  const allowlist = overrides.floatingAllowlist ?? FLOATING_ALLOWLIST;
  const reviewedShas =
    overrides.reviewedSetupBunShas ?? REVIEWED_SETUP_BUN_SHAS;
  // A tracked path that will not open is a contract failure with a name, not a
  // stack trace. `git ls-files` can list a file the working tree lacks — a
  // partial checkout, a sparse cone, a submodule left uninitialised — and the
  // raw ENOENT that produced named neither the contract nor the surface, so a
  // CI operator saw a crash where they should have seen which file broke the
  // inventory. The distinction matters because the two have opposite fixes.
  const read = (rel) => {
    try {
      return readFileSync(resolve(repoRoot, rel), "utf8");
    } catch (cause) {
      throw new Error(
        `${rel}: tracked by git but unreadable (${cause instanceof Error ? (cause.code ?? cause.message) : String(cause)}) — the Bun runtime contract cannot inspect it, so the inventory would be silently incomplete. Check for a sparse checkout or an uninitialised submodule.`,
        { cause },
      );
    }
  };

  const manifest = JSON.parse(read(VERSION_FILE));
  const canonical = manifest.version;
  if (!isConcretePin(canonical)) {
    throw new Error(
      `${VERSION_FILE}: "version" must be a concrete Bun pin (semver), got ${JSON.stringify(canonical)}`,
    );
  }
  if (FLOATING.has(canonical)) {
    throw new Error(`${VERSION_FILE}: "version" must not float (${canonical})`);
  }

  const violations = [];
  const inventory = [];
  const record = (site) => inventory.push(site);
  const violate = (message) => violations.push(message);

  for (const entry of allowlist) {
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      violate(
        `FLOATING_ALLOWLIST entry for ${entry.file ?? "<missing file>"} has no reason — a sanctioned floating cell must say why it exists.`,
      );
    }
    if (typeof entry.job !== "string" || entry.job.trim().length === 0) {
      violate(
        `FLOATING_ALLOWLIST entry for ${entry.file ?? "<missing file>"} names no job — a sanctioned floating cell is scoped to one job, not a whole file.`,
      );
    }
  }

  const tracked = trackedFiles(repoRoot);

  // --- YAML surfaces: workflows, composite actions, and workflow-shaped
  // templates outside .github (project/plugin CI templates are authoritative
  // runtime declarations for whoever instantiates them). ---
  const yamlFiles = [];
  for (const rel of tracked) {
    if (rel.startsWith(`${WORKFLOW_DIR}/`) && /\.ya?ml$/.test(rel)) {
      yamlFiles.push({ rel, kind: "workflow" });
    } else if (
      rel.startsWith(`${ACTIONS_DIR}/`) &&
      /\/action\.ya?ml$/.test(rel)
    ) {
      yamlFiles.push({ rel, kind: "action" });
    } else if (
      !rel.startsWith(".github/") &&
      /\.ya?ml$/.test(rel) &&
      !excludedSurface(rel)
    ) {
      const text = read(rel);
      // A `bun-version:` key is NOT the precondition for being a runtime
      // surface — it is one possible outcome of being one. Gating the scan on
      // it made every already-correct file visible and every defective file
      // invisible: a `oven-sh/setup-bun` step that wires no version is exactly
      // what invariant 2 exists to catch, and it has no `bun-version:` line to
      // match, so 16 plugin workflows on the action's floating "latest"
      // default never entered the scan at all. The gate reported a clean
      // sweep of a set chosen to exclude its own counterexamples.
      if (
        /^\s*(?:-\s+)?(bun-version|BUN_VERSION):/m.test(text) ||
        /oven-sh\/setup-bun/.test(text)
      ) {
        yamlFiles.push({ rel, kind: "workflow", text });
      }
    }
  }

  const scannedYamlFiles = new Set(yamlFiles.map(({ rel }) => rel));
  const fileValueSites = new Map(); // rel -> values (for the gate invariant)

  for (const { rel, kind, text: preread } of yamlFiles) {
    const text = preread ?? read(rel);
    const analysis = analyzeYamlRuntime(text);
    if (analysis.parseError) {
      record({
        surface: `${kind}-version`,
        file: rel,
        value: null,
        classification: "unparseable-file",
      });
      violate(
        `${rel}: does not parse as YAML (${analysis.parseError}) — a runtime surface that cannot be inspected fails the contract.`,
      );
      fileValueSites.set(rel, []);
      continue;
    }
    const {
      values,
      envVisible,
      matrixJobs,
      setupBunSteps,
      actionInput,
      workflowCallInput,
      jobAtLine,
    } = analysis;
    fileValueSites.set(rel, values);

    const canonicalJobs = new Set(
      values.filter((v) => v.raw === canonical).map((v) => v.jobId ?? null),
    );

    // Invariant 1: every wired value is canonical, resolvable in scope, or
    // allowlisted for exactly its job.
    for (const { key, raw, line, jobId, stepIndex, origin } of values) {
      const site = {
        surface: `${kind}-version`,
        file: rel,
        line,
        key,
        origin,
        job: jobId,
        value: raw,
      };
      const jobLabel = jobId === null ? "this file" : `job "${jobId}"`;
      if (raw === null) {
        record({ ...site, classification: "unparseable" });
        violate(
          `${rel}:${line}: ${key} carries a non-scalar value — pin the canonical ${canonical} (${VERSION_FILE}).`,
        );
        continue;
      }
      if (isExpression(raw)) {
        // An expression only counts as resolvable when the declaration it
        // reads is visible from THIS site's scope at runtime. env resolves
        // step env -> job env -> workflow env; matrix resolves against the
        // same job's strategy cells; inputs resolve against a composite
        // action's declared input (default checked by the composite rule) or
        // a workflow_call input with a canonical default. Anything else
        // (step outputs, unknown contexts, cross-job env) cannot be proven
        // pinned statically.
        let resolvable = false;
        let missing = "";
        if (ENV_EXPRESSION.test(raw)) {
          resolvable = envVisible(jobId, stepIndex);
          missing = `no BUN_VERSION declaration visible to ${jobLabel} (checked this step's env, the job env, then the workflow env)`;
        } else if (MATRIX_EXPRESSION.test(raw)) {
          resolvable = jobId !== null && matrixJobs.has(jobId);
          missing = `no bun-version matrix cells declared by ${jobLabel}'s strategy`;
        } else if (INPUTS_EXPRESSION.test(raw)) {
          if (kind === "action") {
            resolvable = actionInput !== null;
            missing = "no bun-version input declared in this action";
          } else {
            resolvable =
              workflowCallInput !== null &&
              workflowCallInput.default === canonical;
            missing =
              workflowCallInput === null
                ? "no workflow_call bun-version input declared in this workflow"
                : `the workflow_call bun-version input default is ${JSON.stringify(workflowCallInput.default)}, not the canonical ${canonical}`;
          }
        } else {
          missing =
            "only same-scope env.BUN_VERSION / matrix.bun-version / inputs.bun-version indirection is checkable";
        }
        record({
          ...site,
          classification: resolvable
            ? "resolvable-expression"
            : "unbound-expression",
        });
        if (!resolvable) {
          violate(
            `${rel}:${line}: wires Bun via unbound expression ${raw} — ${missing}, so this cannot be proven pinned.`,
          );
        }
        continue;
      }
      if (FLOATING.has(raw)) {
        const sanctioned = isAllowlisted(allowlist, rel, jobId, raw);
        record({
          ...site,
          classification: sanctioned ? "allowlisted-floating" : "floating",
        });
        if (!sanctioned) {
          violate(
            `${rel}:${line}: wires floating Bun "${raw}" in ${jobLabel}. Every authoritative lane must stay pinned to ${canonical} (${VERSION_FILE}); a deliberate extra compatibility cell needs a job-scoped FLOATING_ALLOWLIST entry.`,
          );
        } else {
          // Additive-only: the canonical pin must run in a DIFFERENT job of
          // the same file, so the sanctioned float rides beside a stable
          // sibling lane rather than replacing it.
          const sibling = [...canonicalJobs].some((job) => job !== jobId);
          if (!sibling) {
            violate(
              `${rel}:${line}: allowlisted floating "${raw}" has no canonical sibling lane — the same file must wire the canonical ${canonical} in a different job, so the float only ever runs in addition to the pinned runtime (#17044).`,
            );
          }
        }
        continue;
      }
      if (!isConcretePin(raw)) {
        record({ ...site, classification: "unparseable" });
        violate(
          `${rel}:${line}: unparseable Bun version value ${JSON.stringify(raw)} — pin the canonical ${canonical} (${VERSION_FILE}).`,
        );
        continue;
      }
      record({
        ...site,
        classification: raw === canonical ? "canonical" : "divergent",
      });
      if (raw !== canonical) {
        violate(
          `${rel}:${line}: pins Bun ${raw}, but the canonical CI Bun version is ${canonical} (${VERSION_FILE}). Update this site or bump the source of truth — keep them in lockstep.`,
        );
      }
    }

    // Invariant 2: setup-bun refs are reviewed SHAs and never implicit.
    for (const { ref, line, hasBunVersion } of setupBunSteps) {
      const refSite = {
        surface: "setup-bun-ref",
        file: rel,
        line,
        value: ref,
      };
      if (!reviewedShas.has(ref)) {
        record({ ...refSite, classification: "unreviewed-ref" });
        violate(
          `${rel}:${line}: oven-sh/setup-bun@${ref} is not pinned to a reviewed commit SHA — mutable tags can repoint. Pin one of: ${[...reviewedShas].join(", ")}.`,
        );
      } else {
        record({ ...refSite, classification: "reviewed-sha" });
      }
      if (!hasBunVersion) {
        record({
          surface: "setup-bun-version",
          file: rel,
          line,
          value: null,
          classification: "implicit",
        });
        violate(
          `${rel}:${line}: oven-sh/setup-bun use wires no bun-version — the action's implicit default is floating "latest". Pin ${canonical} (${VERSION_FILE}).`,
        );
      }
    }

    // Shell installer lines inside workflow YAML resolve ${BUN_VERSION} from
    // the Actions env, so the proof is an env declaration visible to the
    // enclosing job.
    scanInstallLines({
      rel,
      text,
      canonical,
      record,
      violate,
      shellVarProven: (lineNumber) => envVisible(jobAtLine(lineNumber), null),
    });

    // Invariant 5: a composite action's bun-version input defaults canonical,
    // and a workflow_call bun-version input carries the same obligation.
    if (kind === "action" && actionInput !== null) {
      record({
        surface: "composite-default",
        file: rel,
        value: actionInput.default,
        classification:
          actionInput.default === canonical ? "canonical" : "divergent",
      });
      if (actionInput.default !== canonical) {
        violate(
          `${rel}: composite bun-version input defaults to ${JSON.stringify(actionInput.default)} — callers relying on the default silently float. Default must be the canonical ${canonical} (${VERSION_FILE}).`,
        );
      }
    }
    if (kind === "workflow" && workflowCallInput !== null) {
      record({
        surface: "workflow-call-input-default",
        file: rel,
        value: workflowCallInput.default,
        classification:
          workflowCallInput.default === canonical ? "canonical" : "divergent",
      });
      if (workflowCallInput.default !== canonical) {
        violate(
          `${rel}: workflow_call bun-version input defaults to ${JSON.stringify(workflowCallInput.default)} — callers relying on the default silently float. Default must be the canonical ${canonical} (${VERSION_FILE}).`,
        );
      }
    }
  }

  // --- Invariant 3, non-Action installers: Dockerfiles, shell scripts,
  // standalone YAML runtime manifests, cloud-init templates, and .mjs
  // bootstrap installers. Workflow-shaped YAML was scanned above. ---
  for (const rel of tracked) {
    const name = basename(rel);
    const isDockerfile = name.startsWith("Dockerfile");
    const isShellLike = /\.(sh|tftpl|mjs)$/.test(rel);
    const isStandaloneYaml = /\.ya?ml$/.test(rel) && !scannedYamlFiles.has(rel);
    if (!isDockerfile && !isShellLike && !isStandaloneYaml) continue;
    const excluded = excludedSurface(rel);
    if (excluded) {
      record({
        surface: "installer",
        file: rel,
        value: null,
        classification: excluded.classification,
        reason: excluded.reason,
      });
      continue;
    }
    const text = read(rel);
    if (isDockerfile) {
      scanDockerfile({ rel, text, canonical, record, violate });
      continue;
    }
    // Shell scripts and .mjs installers must PROVE a canonical BUN_VERSION
    // default before any ${BUN_VERSION} use; a .tftpl's variables come from
    // the template context and are never provable here.
    const defaults = []; // {line (1-based), value}
    const lines = text.split("\n");

    // An `oven/bun:` reference is a runtime declaration wherever it appears,
    // including inside a heredoc that writes a Dockerfile at deploy time.
    // scanDockerfile only inspects files NAMED Dockerfile, so the
    // `FROM oven/bun:canary-alpine` emitted by deploy-railway.sh shipped a
    // floating canary straight past a contract whose headline promise is that
    // no floating tag survives — the surface was a shell script, so nothing
    // looked at its Docker content (#17599 review).
    for (const [i, line] of lines.entries()) {
      const img = line.match(/oven\/bun:([A-Za-z0-9._-]+)/);
      if (!img) continue;
      const tag = img[1];
      // A variant suffix (-alpine, -slim, -distroless) is a base-image choice,
      // not a version; only the version part must be canonical.
      const pinned = tag === canonical || tag.startsWith(`${canonical}-`);
      record({
        surface: "embedded-bun-image",
        file: rel,
        line: i + 1,
        value: tag,
        classification: pinned ? "canonical" : "divergent",
      });
      if (!pinned) {
        violate(
          `${rel}:${i + 1}: oven/bun:${tag} — an embedded Bun base image must be the canonical ${canonical}, optionally with a variant suffix such as -alpine (${VERSION_FILE}).`,
        );
      }
    }

    // YAML too, not only `.sh`: a packaging manifest carries its build steps as
    // an embedded shell script in a block scalar, so `BUN_VERSION="1.3.14"`
    // followed by `bun-v${BUN_VERSION}` is one proven declaration and one use —
    // the same pattern this scan already accepts in a standalone script. Reading
    // only `.sh` left the use unproven, and the way to satisfy the contract was
    // to inline the literal at the use site, which is how snapcraft.yaml ended
    // up with the pin written twice and two places to bump (#17599 review).
    if (/\.(sh|ya?ml)$/.test(rel)) {
      for (const [i, line] of lines.entries()) {
        const def = line.match(
          /^\s*(?:export\s+)?BUN_VERSION=["']?\$\{BUN_VERSION:-([^}"']+)\}["']?/,
        );
        const pin = def
          ? null
          : line.match(
              /^\s*(?:export\s+)?BUN_VERSION=(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/,
            );
        const pinValue = pin?.[1] ?? pin?.[2] ?? pin?.[3];
        const value =
          def?.[1] ??
          (pinValue !== undefined && isConcretePin(pinValue)
            ? pinValue
            : undefined);
        if (value === undefined) continue;
        defaults.push({ line: i + 1, value });
        record({
          surface: "shell-default",
          file: rel,
          line: i + 1,
          value,
          classification: value === canonical ? "canonical" : "divergent",
        });
        if (value !== canonical) {
          violate(
            `${rel}:${i + 1}: shell BUN_VERSION default ${value} must be the canonical ${canonical} (${VERSION_FILE}).`,
          );
        }
      }
    } else if (/\.mjs$/.test(rel)) {
      for (const [i, line] of lines.entries()) {
        const def =
          line.match(/\bBUN_VERSION\s*=\s*"([^"]+)"/) ??
          line.match(/\bBUN_VERSION\s*=\s*'([^']+)'/);
        if (!def || !isConcretePin(def[1])) continue;
        defaults.push({ line: i + 1, value: def[1] });
        record({
          surface: "script-default",
          file: rel,
          line: i + 1,
          value: def[1],
          classification: def[1] === canonical ? "canonical" : "divergent",
        });
        if (def[1] !== canonical) {
          violate(
            `${rel}:${i + 1}: script BUN_VERSION default ${def[1]} must be the canonical ${canonical} (${VERSION_FILE}).`,
          );
        }
      }
    } else if (isStandaloneYaml) {
      // A standalone runtime manifest proves the variable with a concrete
      // top-level BUN_VERSION declaration (validated above only for
      // workflow-shaped files, so validate the literal here).
      for (const [i, line] of lines.entries()) {
        const def = line.match(
          /^\s*BUN_VERSION:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/,
        );
        const value = def?.[1] ?? def?.[2] ?? def?.[3];
        if (value === undefined || !isConcretePin(value)) continue;
        defaults.push({ line: i + 1, value });
      }
    }
    scanInstallLines({
      rel,
      text,
      canonical,
      record,
      violate,
      shellVarProven: (lineNumber) => defaults.some((d) => d.line < lineNumber),
    });
  }

  // --- Invariant 7: gate lanes wire the canonical literal directly. Missing
  // gate files throw via the uncaught read — a required lane that vanished is
  // a contract failure, not a skip. Fixture trees create every gate. ---
  for (const name of GATE_WORKFLOWS) {
    const rel = join(WORKFLOW_DIR, name);
    const text = read(rel);
    const values =
      fileValueSites.get(`${WORKFLOW_DIR}/${name}`) ??
      analyzeYamlRuntime(text).values ??
      [];
    const floats = values.find(
      (v) => v.raw !== null && !isExpression(v.raw) && FLOATING.has(v.raw),
    );
    if (floats !== undefined) {
      violate(
        `${rel}: is a deterministic CI lane but wires floating Bun "${floats.raw}". It must stay pinned to ${canonical} (${VERSION_FILE}) so setup is reproducible and does not require tag discovery.`,
      );
    }
    if (!values.some((v) => v.raw === canonical)) {
      violate(
        `${rel}: is a deterministic CI lane but does not wire the canonical Bun pin ${canonical} (${VERSION_FILE}). Expected a BUN_VERSION/bun-version: "${canonical}" literal.`,
      );
    }
    if (CONTRACT_ENFORCEMENT_WORKFLOWS.has(name)) {
      if (
        !/node packages\/scripts\/ci-bun-version-contract\.mjs\s+--inventory\s+["']?\$RUNNER_TEMP\/bun-runtime-inventory\.json/.test(
          text,
        )
      ) {
        violate(
          `${rel}: required lane does not execute the Bun contract with an exact-head inventory. Run \`node packages/scripts/ci-bun-version-contract.mjs --inventory "$RUNNER_TEMP/bun-runtime-inventory.json"\`.`,
        );
      }
      if (
        !text.includes("name: bun-runtime-inventory") ||
        !text.includes(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression required in the workflow contract
          "path: ${{ runner.temp }}/bun-runtime-inventory.json",
        )
      ) {
        violate(
          `${rel}: required lane does not upload the bun-runtime-inventory artifact from the exact PR head.`,
        );
      }
    }
  }

  // --- Invariant 4: manifests and type anchors. A tracked package.json that
  // fails to parse throws: a surface that cannot be inspected must fail the
  // contract rather than silently vanish from the inventory. ---
  for (const rel of tracked) {
    if (basename(rel) !== "package.json") continue;
    let parsed;
    try {
      parsed = JSON.parse(read(rel));
    } catch (error) {
      throw new Error(
        `${rel}: tracked manifest failed to parse — cannot verify its Bun surfaces (${error.message})`,
        { cause: error },
      );
    }
    const pm = parsed.packageManager;
    if (typeof pm === "string" && pm.startsWith("bun@")) {
      const version = pm.slice("bun@".length);
      record({
        surface: "packageManager",
        file: rel,
        value: pm,
        classification: version === canonical ? "canonical" : "divergent",
      });
      if (version !== canonical) {
        violate(
          `${rel}: packageManager is ${pm}, but the canonical Bun runtime is ${canonical} (${VERSION_FILE}) — an unpublished or floating declaration 404s in any tool that resolves it.`,
        );
      }
    }
    const isRoot = rel === "package.json";
    for (const depField of ["dependencies", "devDependencies"]) {
      for (const dep of ["@types/bun", "bun-types"]) {
        const range = parsed[depField]?.[dep];
        if (typeof range !== "string") continue;
        const classification = isRoot
          ? range === canonical
            ? "exact-canonical"
            : "divergent"
          : classifyTypeRange(range, canonical);
        record({
          surface: isRoot ? "root-type-anchor" : "workspace-type-range",
          file: rel,
          value: `${dep}@${range}`,
          classification,
        });
        if (isRoot && range !== canonical) {
          violate(
            `${rel}: root type anchor ${dep} is "${range}" but must pin the canonical ${canonical} exactly — the root anchors are the repository's Bun API baseline.`,
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `${violations.length} Bun runtime contract violation(s):\n- ${violations.join("\n- ")}`,
    );
  }

  return {
    canonical,
    inventory,
    concretePins: inventory.filter(
      (site) =>
        site.surface === "workflow-version" &&
        site.classification === "canonical",
    ),
    gateWorkflows: GATE_WORKFLOWS,
  };
}

/**
 * Dockerfile scan with Docker's actual scoping rules: `FROM
 * oven/bun:${BUN_VERSION}` interpolates only ARGs declared before the FIRST
 * FROM (globals), and a bare in-stage `ARG BUN_VERSION` re-declaration
 * inherits a global default rather than introducing a new one. A RUN-line
 * `${BUN_VERSION}` resolves through the nearest preceding ARG/ENV declaration,
 * walking past bare re-declarations to the global default. An expression with
 * no concrete default anywhere in its chain floats on `--build-arg`, so it
 * fails the contract.
 */
function scanDockerfile({ rel, text, canonical, record, violate }) {
  const lines = text.split("\n");
  const decls = []; // {line, kind: ARG|ENV, value|null}
  let firstFromLine = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*FROM\s/i.test(line) && firstFromLine === Infinity) {
      firstFromLine = i + 1;
    }
    const arg = line.match(
      /^\s*ARG\s+BUN_VERSION(?:=["']?([^\s"']*)["']?)?\s*(?:#.*)?$/,
    );
    if (arg) {
      decls.push({ line: i + 1, kind: "ARG", value: arg[1] ?? null });
      continue;
    }
    const env = line.match(/^\s*ENV\s+BUN_VERSION[= ]["']?([^\s"']+)["']?/);
    if (env) {
      decls.push({ line: i + 1, kind: "ENV", value: env[1] });
    }
  }
  const globalDefault = decls.find(
    (d) =>
      d.kind === "ARG" &&
      d.line < firstFromLine &&
      d.value !== null &&
      d.value !== "",
  );

  for (const decl of decls) {
    if (decl.value === null || decl.value === "") {
      // Bare re-declaration: legal Docker for pulling a global ARG into a
      // stage — but only if a global default actually exists to inherit.
      record({
        surface: "dockerfile-arg-redeclaration",
        file: rel,
        line: decl.line,
        value: null,
        classification: globalDefault ? "inherits-global-default" : "unbound",
      });
      if (!globalDefault) {
        violate(
          `${rel}:${decl.line}: bare ARG BUN_VERSION has no pre-FROM default to inherit — the value floats on --build-arg. Declare ARG BUN_VERSION=${canonical} before the first FROM (${VERSION_FILE}).`,
        );
      }
      continue;
    }
    if (decl.value.includes("${")) continue; // pass-through re-export
    record({
      surface: "dockerfile-arg-default",
      file: rel,
      line: decl.line,
      value: decl.value,
      classification: decl.value === canonical ? "canonical" : "divergent",
    });
    if (decl.value !== canonical) {
      violate(
        `${rel}:${decl.line}: BUN_VERSION defaults to ${decl.value} — a Dockerfile runtime default must be the canonical ${canonical} (${VERSION_FILE}).`,
      );
    }
  }

  // A base image also reaches FROM through an ARG/ENV of any name:
  //   ARG BUN_BASE=oven/bun:canary-alpine
  //   FROM ${BUN_BASE}
  // The FROM matcher below requires a literal `oven/bun:` on the FROM line, and
  // the declaration scan above reads only BUN_VERSION, so this shape cleared
  // both while pinning nothing. That is how a floating canary became the
  // runtime of three deployed cloud service images without a single violation
  // (#17044). The reference is a runtime declaration wherever it is written.
  for (let i = 0; i < lines.length; i++) {
    const decl = lines[i].match(
      /^\s*(ARG|ENV)\s+([A-Za-z_][A-Za-z0-9_]*)[= ]["']?oven\/bun:([A-Za-z0-9._-]+)["']?/,
    );
    if (!decl) continue;
    const [, kind, name, tag] = decl;
    // Variant suffixes (-alpine, -slim, -distroless) are a base-image choice;
    // only the version prefix must match the canonical pin.
    const tagVersion = tag.match(/^(\d+\.\d+\.\d+)(?:-[A-Za-z0-9.-]+)?$/)?.[1];
    const pinned = tagVersion === canonical;
    record({
      surface: "dockerfile-base-image-arg",
      file: rel,
      line: i + 1,
      value: tag,
      classification: pinned
        ? "canonical"
        : /^(canary|latest)(?:-|$)/.test(tag)
          ? "floating"
          : "divergent",
    });
    if (!pinned) {
      violate(
        `${rel}:${i + 1}: ${kind} ${name}=oven/bun:${tag} — a base image reached through ${kind} ${name} must be the canonical ${canonical} (${VERSION_FILE}) (variant suffixes allowed). Pass an out-of-tree image with --build-arg rather than defaulting to a floating tag.`,
      );
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const from = lines[i].match(
      /^\s*FROM\s+(?:--platform=\S+\s+)?oven\/bun:([^\s]+)/i,
    );
    if (!from) continue;
    const tag = from[1];
    const inlineDefault = tag.match(/\$\{BUN_VERSION:-([^}]*)\}/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile ARG interpolation, not a JS template
    const bareExpression = !inlineDefault && tag.includes("${BUN_VERSION}");
    // Image tags carry distro variants (1.3.14-alpine, 1.3.14-debian);
    // the version prefix is what must match the canonical pin.
    const tagVersion = tag.match(/^(\d+\.\d+\.\d+)(?:-[A-Za-z0-9.-]+)?$/)?.[1];
    const floating = /^(canary|latest)(?:-|$)/.test(tag);
    let classification;
    let message = null;
    if (inlineDefault) {
      classification =
        inlineDefault[1] === canonical ? "resolvable-expression" : "divergent";
      if (inlineDefault[1] !== canonical) {
        message = `FROM oven/bun:${tag} — the inline \${BUN_VERSION:-…} default must be the canonical ${canonical} (${VERSION_FILE}).`;
      }
    } else if (bareExpression) {
      // FROM interpolation only sees pre-FROM (global) ARGs; a defaulted ARG
      // after any FROM — or none at all — leaves this tag floating.
      classification = globalDefault
        ? "resolvable-expression"
        : "unbound-expression";
      if (!globalDefault) {
        message = `FROM oven/bun:${tag} interpolates \${BUN_VERSION} with no pre-FROM ARG BUN_VERSION default — the base image floats on --build-arg. Declare ARG BUN_VERSION=${canonical} before the first FROM (${VERSION_FILE}).`;
      }
    } else if (tagVersion === canonical) {
      classification = "canonical";
    } else {
      classification = floating ? "floating" : "divergent";
      message = `FROM oven/bun:${tag} — the base-image runtime must be the canonical ${canonical} (${VERSION_FILE}) (variant suffixes allowed) or \${BUN_VERSION} backed by a pre-FROM canonical ARG default.`;
    }
    record({
      surface: "dockerfile-base-image",
      file: rel,
      line: i + 1,
      value: tag,
      classification,
    });
    if (message) violate(`${rel}:${i + 1}: ${message}`);
  }

  // RUN-line ${BUN_VERSION} uses resolve through the nearest preceding
  // declaration, walking past bare/pass-through re-declarations to the global
  // default.
  const provenAt = (lineNumber) => {
    const before = decls.filter((d) => d.line < lineNumber);
    for (let i = before.length - 1; i >= 0; i--) {
      const decl = before[i];
      if (decl.value === null || decl.value === "") {
        if (globalDefault) return true;
        continue;
      }
      if (decl.value.includes("${")) continue;
      return true;
    }
    return false;
  };
  scanInstallLines({
    rel,
    text,
    canonical,
    record,
    violate,
    shellVarProven: provenAt,
  });
}

// Shared line scan for the two install idioms that appear outside Action
// YAML keys: `curl … bun.sh/install | bash …` and direct release-artifact
// downloads (`oven-sh/bun/releases/download/bun-v<v>/…`). The GitHub
// `releases/latest/download` convenience URL is deliberately rejected because
// it moves without a repository change. Comment lines are prose, not installs.
// A `${BUN_VERSION}` reference is accepted only when `shellVarProven` shows
// the file establishes a canonical default before that line — an unproven
// expression is a floating runtime, not a pin.
function scanInstallLines({
  rel,
  text,
  canonical,
  record,
  violate,
  shellVarProven = () => false,
}) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    if (line.includes("bun.sh/install")) {
      const installGuard = lines
        .slice(Math.max(0, i - 4), i)
        .toReversed()
        .find((candidate) =>
          /^\s*["'`]?\s*if\s+.*command\s+-v\s+bun/.test(candidate),
        );
      if (installGuard !== undefined) {
        const comparesVersion = installGuard.includes("bun --version");
        const resolvesCanonicalVersion =
          comparesVersion &&
          (installGuard.includes(canonical) ||
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
            (installGuard.includes("${BUN_VERSION}") && shellVarProven(i + 1)));
        record({
          surface: "preinstalled-runtime-guard",
          file: rel,
          line: i + 1,
          value: installGuard.trim(),
          classification: resolvesCanonicalVersion ? "canonical" : "implicit",
        });
        if (!resolvesCanonicalVersion) {
          violate(
            comparesVersion
              ? `${rel}:${i + 1}: the install guard compares \`bun --version\` with \${BUN_VERSION}, but this file never proves a canonical BUN_VERSION default before the comparison — prove the default or compare with the literal ${canonical}.`
              : `${rel}:${i + 1}: Bun installation is guarded only by executable presence, so an arbitrary preinstalled Bun becomes authoritative. Compare \`bun --version\` with ${canonical} before deciding to skip the pinned install.`,
          );
        }
      }
      const literalPin = line.includes(`bun-v${canonical}`);
      const viaExpression =
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
        !literalPin && line.includes("bun-v${BUN_VERSION}");
      const proven = viaExpression && shellVarProven(i + 1);
      const pinned = literalPin || proven;
      record({
        surface: "shell-install",
        file: rel,
        line: i + 1,
        value: line.trim(),
        classification: pinned
          ? "canonical"
          : viaExpression
            ? "unproven-expression"
            : "floating",
      });
      if (!pinned) {
        violate(
          viaExpression
            ? `${rel}:${i + 1}: bun.sh/install pins via \${BUN_VERSION}, but this file never proves a canonical BUN_VERSION default before the use — an unproven expression is a floating runtime. Establish BUN_VERSION=${canonical} (or the \${BUN_VERSION:-${canonical}} idiom) earlier in the file.`
            : `${rel}:${i + 1}: bun.sh/install without the pinned release tag — a bare install or a channel argument puts a moving Bun on the host. Use \`bash -s "bun-v${canonical}"\`.`,
        );
      }
    }
    if (/oven-sh\/bun\/releases\/latest\/download\//.test(line)) {
      record({
        surface: "release-download",
        file: rel,
        line: i + 1,
        value: "latest",
        classification: "floating",
      });
      violate(
        `${rel}:${i + 1}: downloads Bun from floating releases/latest — use the canonical bun-v${canonical} release URL (${VERSION_FILE}).`,
      );
      continue;
    }
    const download = line.match(
      /oven-sh\/bun\/releases\/download\/bun-v(\d+\.\d+\.\d+|\$\{BUN_VERSION\})/,
    );
    if (download) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable reference, not a JS template
      const viaExpression = download[1] === "${BUN_VERSION}";
      const value = download[1];
      const ok = viaExpression
        ? shellVarProven(i + 1)
        : download[1] === canonical;
      record({
        surface: "release-download",
        file: rel,
        line: i + 1,
        value,
        classification: ok
          ? "canonical"
          : viaExpression
            ? "unproven-expression"
            : "divergent",
      });
      if (!ok) {
        violate(
          viaExpression
            ? `${rel}:${i + 1}: downloads Bun release bun-v\${BUN_VERSION}, but this file never proves a canonical BUN_VERSION default before the use — establish BUN_VERSION=${canonical} earlier in the file.`
            : `${rel}:${i + 1}: downloads Bun release bun-v${download[1]} — must be the canonical ${canonical} (${VERSION_FILE}).`,
        );
      }
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const inventoryFlag = process.argv.indexOf("--inventory");
    const { canonical, inventory, concretePins, gateWorkflows } = runContract();
    if (inventoryFlag !== -1 && process.argv[inventoryFlag + 1]) {
      writeFileSync(
        process.argv[inventoryFlag + 1],
        `${JSON.stringify({ canonical, generatedAt: new Date().toISOString(), sites: inventory }, null, 2)}\n`,
      );
    }
    const counts = {};
    for (const site of inventory) {
      counts[site.classification] = (counts[site.classification] ?? 0) + 1;
    }
    console.log(
      `ci bun version contract passed (canonical ${canonical}; ${inventory.length} sites scanned; ` +
        `${concretePins.length} workflow pin(s) in lockstep; ${gateWorkflows.length} gate lane(s) pinned; ` +
        `classifications: ${Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")})`,
    );
  } catch (error) {
    console.error(`[ci-bun-version-contract] FAIL ${error.message}`);
    process.exit(1);
  }
}
