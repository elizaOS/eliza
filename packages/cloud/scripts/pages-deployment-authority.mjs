/**
 * Closes Cloudflare Pages deployment output into a privacy-safe release proof.
 *
 * Wrangler's append-only NDJSON is accepted only at the deployment boundary.
 * This module validates both v1 records, removes the raw deployment UUID, and
 * binds subsequent public and browser observations to one source SHA, alias,
 * workflow run, and renderer build before a staging receipt can claim that the
 * deployed renderer was tested.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PAGES_AUTHORITY_SCHEMA =
  "elizaos.cloudflare.pages-deployment-authority/v1";
export const PAGES_PUBLIC_CHECK_SCHEMA =
  "elizaos.cloudflare.pages-public-check/v1";
export const DEPLOYED_BROWSER_SMOKE_SCHEMA =
  "elizaos.cloud.deployed-browser-smoke/v1";
export const DEPLOYED_RENDERER_PROOF_SCHEMA =
  "elizaos.cloud.deployed-renderer-proof/v1";

const RECEIPT_LANE = "app-live-e2e-cloud-staging";
const DEPLOYED_LANE = "app-live-e2e-cloud-staging-deployed";
const RENDERER_MANIFEST_SCHEMA = "elizaos.renderer.build/v1";
const LATENCY_METRIC = "first-turn-latency";
const LATENCY_DEFINITION =
  "composer-send-click-to-settled-valid-assistant-turn: starts immediately before the UI send click; ends after the same fresh non-empty assistant row settles and passes the liveness contract; not first-token latency";
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/;

const AUTHORITY_KEYS = [
  "aliasUrl",
  "branch",
  "deploymentIdSha256",
  "deploymentUrl",
  "pagesEnvironment",
  "productionBranch",
  "project",
  "schema",
  "sourceSha",
  "workflow",
];
const WORKFLOW_KEYS = ["runAttempt", "runId"];
const PUBLIC_CHECK_KEYS = ["api", "phase", "renderer", "schema", "sourceSha"];
const PUBLIC_RENDERER_KEYS = [
  "assetCount",
  "buildId",
  "commit",
  "indexHtmlSha256",
  "manifestSchema",
  "origin",
];
const PUBLIC_API_KEYS = ["commit", "environment", "origin"];
const REMOTE_SMOKE_KEYS = [
  "cloudApiOrigin",
  "cloudEnvironment",
  "outcome",
  "rendererBuildId",
  "rendererManifestCommit",
  "rendererOrigin",
  "schema",
  "sourceSha",
];
const LATENCY_KEYS = [
  "definition",
  "firstTurnLatencyMs",
  "lane",
  "metric",
  "schemaVersion",
];
const CONTINUITY_KEYS = [
  "apiBaseReused",
  "challengeTurnCount",
  "cleanupDisposition",
  "conversationHistoryDisposition",
  "forbiddenAgentMutationCount",
  "freshContextHistoryPassed",
  "lane",
  "noAdditionalChatSendAfterChallenge",
  "personalIdentityEndpointPassed",
  "personalIdentityReused",
  "reloadHistoryPassed",
  "runtimeBindingReused",
  "schemaVersion",
];
const PROOF_KEYS = [
  "authority",
  "continuity",
  "lane",
  "latency",
  "postflight",
  "preflight",
  "remoteSmoke",
  "schema",
  "sourceSha",
  "workflow",
];

function fail(message) {
  throw new Error(`[pages-deployment-authority] ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireExactKeys(value, keys, label) {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must use the exact closed schema`);
  }
  return record;
}

function requireString(value, label, pattern) {
  if (
    typeof value !== "string" ||
    !value ||
    (pattern && !pattern.test(value))
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function requireHttpsUrl(value, label) {
  const raw = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    // error-policy:J3 untrusted provider output is rejected as invalid input.
    fail(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    fail(`${label} must be a bare HTTPS origin`);
  }
  return parsed.origin;
}

function requireIsoTimestamp(value, label) {
  const raw = requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return raw;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireNullableString(value, label) {
  if (value !== null && typeof value !== "string") {
    fail(`${label} must be a string or null`);
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    // error-policy:J3 provider and evidence files are untrusted boundaries.
    fail(`${label} must contain valid JSON`);
  }
}

function parseNdjson(raw) {
  if (typeof raw !== "string" || !raw.endsWith("\n")) {
    fail("Wrangler output must end with a newline");
  }
  const lines = raw.slice(0, -1).split("\n");
  if (
    lines.length !== 2 ||
    lines.some((line) => !line || line.includes("\r"))
  ) {
    fail("Wrangler output must contain exactly two non-empty NDJSON records");
  }
  return lines.map((line, index) =>
    parseJson(line, `Wrangler record ${index + 1}`),
  );
}

function parseWorkflow(value, label = "workflow") {
  const record = requireExactKeys(value, WORKFLOW_KEYS, label);
  return {
    runId: requirePositiveInteger(record.runId, `${label}.runId`),
    runAttempt: requirePositiveInteger(
      record.runAttempt,
      `${label}.runAttempt`,
    ),
  };
}

/**
 * Validates the two records emitted by Wrangler 4.100.0 and returns only the
 * closed, publishable identity needed by later release jobs.
 */
export function parseWranglerPagesDeploymentOutput(
  raw,
  {
    expectedProject,
    expectedCommit,
    expectedBranch,
    expectedAlias,
    expectedEnvironment,
    expectedProductionBranch,
    runId,
    runAttempt,
  },
) {
  const [summaryValue, detailedValue] = parseNdjson(raw);
  const summary = requireExactKeys(
    summaryValue,
    ["deployment_id", "pages_project", "timestamp", "type", "url", "version"],
    "pages-deploy record",
  );
  const detailed = requireExactKeys(
    detailedValue,
    [
      "alias",
      "deployment_id",
      "deployment_trigger",
      "environment",
      "pages_project",
      "production_branch",
      "timestamp",
      "type",
      "url",
      "version",
    ],
    "pages-deploy-detailed record",
  );
  if (summary.type !== "pages-deploy" || summary.version !== 1) {
    fail("first Wrangler record must be pages-deploy/v1");
  }
  if (detailed.type !== "pages-deploy-detailed" || detailed.version !== 1) {
    fail("second Wrangler record must be pages-deploy-detailed/v1");
  }
  requireIsoTimestamp(summary.timestamp, "pages-deploy timestamp");
  requireIsoTimestamp(detailed.timestamp, "pages-deploy-detailed timestamp");

  const project = requireString(
    summary.pages_project,
    "pages_project",
    PROJECT,
  );
  const deploymentId = requireString(
    summary.deployment_id,
    "deployment_id",
    UUID,
  );
  const deploymentUrl = requireHttpsUrl(summary.url, "deployment URL");
  const detailedDeploymentUrl = requireHttpsUrl(
    detailed.url,
    "detailed deployment URL",
  );
  const aliasUrl = requireHttpsUrl(detailed.alias, "deployment alias");
  const commitMetadata = requireExactKeys(
    requireExactKeys(
      detailed.deployment_trigger,
      ["metadata"],
      "deployment_trigger",
    ).metadata,
    ["commit_hash"],
    "deployment_trigger.metadata",
  );
  const sourceSha = requireString(
    commitMetadata.commit_hash,
    "deployment commit hash",
    SHA40,
  );

  for (const [label, left, right] of [
    ["pages_project", detailed.pages_project, project],
    ["deployment_id", detailed.deployment_id, deploymentId],
    ["deployment URL", detailedDeploymentUrl, deploymentUrl],
  ]) {
    if (left !== right) fail(`${label} differs between Wrangler records`);
  }
  if (project !== expectedProject) fail("Pages project does not match release");
  if (sourceSha !== expectedCommit) fail("commit hash does not match release");
  if (aliasUrl !== expectedAlias) fail("Pages alias does not match release");
  if (detailed.environment !== expectedEnvironment) {
    fail("Pages environment does not match release");
  }
  if (detailed.production_branch !== expectedProductionBranch) {
    fail("Pages production branch does not match release");
  }

  const expectedDeploymentSuffix = `.${project}.pages.dev`;
  if (!new URL(deploymentUrl).hostname.endsWith(expectedDeploymentSuffix)) {
    fail("deployment URL is not owned by the expected Pages project");
  }
  const expectedAliasHost = `${expectedBranch}.${project}.pages.dev`;
  if (new URL(aliasUrl).hostname !== expectedAliasHost) {
    fail("Pages alias is not owned by the expected release branch");
  }

  return {
    schema: PAGES_AUTHORITY_SCHEMA,
    sourceSha,
    workflow: {
      runId: requirePositiveInteger(runId, "run ID"),
      runAttempt: requirePositiveInteger(runAttempt, "run attempt"),
    },
    project,
    branch: requireString(expectedBranch, "expected branch", PROJECT),
    pagesEnvironment: expectedEnvironment,
    productionBranch: expectedProductionBranch,
    deploymentUrl,
    aliasUrl,
    deploymentIdSha256: sha256(deploymentId),
  };
}

export function parsePagesDeploymentAuthority(value) {
  const authority = requireExactKeys(value, AUTHORITY_KEYS, "authority");
  if (authority.schema !== PAGES_AUTHORITY_SCHEMA) {
    fail("authority schema is invalid");
  }
  const sourceSha = requireString(authority.sourceSha, "sourceSha", SHA40);
  const project = requireString(authority.project, "project", PROJECT);
  const branch = requireString(authority.branch, "branch", PROJECT);
  const deploymentUrl = requireHttpsUrl(
    authority.deploymentUrl,
    "deploymentUrl",
  );
  const aliasUrl = requireHttpsUrl(authority.aliasUrl, "aliasUrl");
  if (!new URL(deploymentUrl).hostname.endsWith(`.${project}.pages.dev`)) {
    fail("authority deployment URL does not match project");
  }
  if (new URL(aliasUrl).hostname !== `${branch}.${project}.pages.dev`) {
    fail("authority alias does not match branch and project");
  }
  const parsed = {
    schema: PAGES_AUTHORITY_SCHEMA,
    sourceSha,
    workflow: parseWorkflow(authority.workflow, "authority.workflow"),
    project,
    branch,
    pagesEnvironment: requireString(
      authority.pagesEnvironment,
      "pagesEnvironment",
    ),
    productionBranch: requireString(
      authority.productionBranch,
      "productionBranch",
      PROJECT,
    ),
    deploymentUrl,
    aliasUrl,
    deploymentIdSha256: requireString(
      authority.deploymentIdSha256,
      "deploymentIdSha256",
      SHA256,
    ),
  };
  if (parsed.pagesEnvironment !== "preview") {
    fail(
      "deployed staging authority must target the Pages preview environment",
    );
  }
  return parsed;
}

function parseRendererManifest(value, expectedCommit) {
  const manifest = requireExactKeys(
    value,
    [
      "assetCount",
      "buildId",
      "builtAt",
      "capacitorTarget",
      "commit",
      "indexHtmlSha256",
      "iosApnsEnabled",
      "playwrightTestAuth",
      "runtimeMode",
      "schema",
      "variant",
    ],
    "renderer manifest",
  );
  if (manifest.schema !== RENDERER_MANIFEST_SCHEMA) {
    fail("renderer manifest schema is invalid");
  }
  const commit = requireString(manifest.commit, "renderer commit", SHA40);
  if (commit !== expectedCommit) fail("renderer manifest commit is stale");
  requireString(manifest.buildId, "renderer buildId", SHA256);
  requireString(manifest.indexHtmlSha256, "renderer index hash", SHA256);
  if (!Number.isSafeInteger(manifest.assetCount) || manifest.assetCount <= 0) {
    fail("renderer assetCount must be a positive safe integer");
  }
  requireIsoTimestamp(manifest.builtAt, "renderer builtAt");
  requireNullableString(manifest.variant, "renderer variant");
  requireNullableString(manifest.capacitorTarget, "renderer capacitorTarget");
  requireNullableString(manifest.runtimeMode, "renderer runtimeMode");
  if (manifest.playwrightTestAuth !== false) {
    fail("deployed renderer must not contain Playwright test auth");
  }
  if (
    manifest.iosApnsEnabled !== null &&
    typeof manifest.iosApnsEnabled !== "boolean"
  ) {
    fail("renderer iosApnsEnabled is invalid");
  }
  return {
    manifestSchema: RENDERER_MANIFEST_SCHEMA,
    commit,
    buildId: manifest.buildId,
    indexHtmlSha256: manifest.indexHtmlSha256,
    assetCount: manifest.assetCount,
  };
}

function parseHealth(value, expectedCommit) {
  const health = requireRecord(value, "API health");
  if (health.commit !== expectedCommit || health.environment !== "staging") {
    fail("API health does not match the staging release");
  }
  return { commit: expectedCommit, environment: "staging" };
}

async function fetchJson(url, fetchImpl) {
  let lastError = "no attempts";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
        redirect: "error",
        signal: controller.signal,
      });
      const expected = new URL(url);
      const observed = response.url ? new URL(response.url) : expected;
      if (
        !response.ok ||
        observed.origin !== expected.origin ||
        observed.pathname !== expected.pathname
      ) {
        lastError = `unexpected HTTP response (${response.status}) or redirect`;
      } else {
        const text = await response.text();
        if (Buffer.byteLength(text) > 128 * 1024) {
          lastError = "response exceeded the public proof size limit";
        } else {
          return parseJson(text, `response from ${expected.origin}`);
        }
      }
    } catch (error) {
      // error-policy:J1 public network failures remain explicit failed checks.
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 4)
      await new Promise((done) => setTimeout(done, attempt * 2_000));
  }
  fail(`public check failed after four attempts: ${lastError}`);
}

export async function verifyPublicPagesDeployment(
  authorityValue,
  { apiBase, phase, fetchImpl = fetch },
) {
  const authority = parsePagesDeploymentAuthority(authorityValue);
  if (phase !== "preflight" && phase !== "postflight") {
    fail("public verification phase must be preflight or postflight");
  }
  const apiOrigin = requireHttpsUrl(apiBase, "API base");
  if (apiOrigin !== "https://api-staging.eliza.app") {
    fail("public verification API base must be staging");
  }
  const manifestUrl = `${authority.aliasUrl}/eliza-renderer-build.json?source=${authority.sourceSha}`;
  const healthUrl = `${apiOrigin}/api/health?source=${authority.sourceSha}`;
  const [manifestValue, healthValue] = await Promise.all([
    fetchJson(manifestUrl, fetchImpl),
    fetchJson(healthUrl, fetchImpl),
  ]);
  const renderer = parseRendererManifest(manifestValue, authority.sourceSha);
  const api = parseHealth(healthValue, authority.sourceSha);
  return {
    schema: PAGES_PUBLIC_CHECK_SCHEMA,
    phase,
    sourceSha: authority.sourceSha,
    renderer: { origin: authority.aliasUrl, ...renderer },
    api: { origin: apiOrigin, ...api },
  };
}

export function parsePagesPublicCheck(value, expectedPhase) {
  const check = requireExactKeys(value, PUBLIC_CHECK_KEYS, expectedPhase);
  if (
    check.schema !== PAGES_PUBLIC_CHECK_SCHEMA ||
    check.phase !== expectedPhase
  ) {
    fail(`${expectedPhase} identity is invalid`);
  }
  const sourceSha = requireString(
    check.sourceSha,
    `${expectedPhase}.sourceSha`,
    SHA40,
  );
  const renderer = requireExactKeys(
    check.renderer,
    PUBLIC_RENDERER_KEYS,
    `${expectedPhase}.renderer`,
  );
  const api = requireExactKeys(
    check.api,
    PUBLIC_API_KEYS,
    `${expectedPhase}.api`,
  );
  const parsed = {
    schema: PAGES_PUBLIC_CHECK_SCHEMA,
    phase: expectedPhase,
    sourceSha,
    renderer: {
      origin: requireHttpsUrl(
        renderer.origin,
        `${expectedPhase}.renderer.origin`,
      ),
      manifestSchema: requireString(
        renderer.manifestSchema,
        `${expectedPhase}.renderer.manifestSchema`,
      ),
      commit: requireString(
        renderer.commit,
        `${expectedPhase}.renderer.commit`,
        SHA40,
      ),
      buildId: requireString(
        renderer.buildId,
        `${expectedPhase}.renderer.buildId`,
        SHA256,
      ),
      indexHtmlSha256: requireString(
        renderer.indexHtmlSha256,
        `${expectedPhase}.renderer.indexHtmlSha256`,
        SHA256,
      ),
      assetCount: requirePositiveInteger(
        renderer.assetCount,
        `${expectedPhase}.renderer.assetCount`,
      ),
    },
    api: {
      origin: requireHttpsUrl(api.origin, `${expectedPhase}.api.origin`),
      commit: requireString(api.commit, `${expectedPhase}.api.commit`, SHA40),
      environment: requireString(
        api.environment,
        `${expectedPhase}.api.environment`,
      ),
    },
  };
  if (
    parsed.renderer.manifestSchema !== RENDERER_MANIFEST_SCHEMA ||
    parsed.renderer.commit !== sourceSha ||
    parsed.api.commit !== sourceSha
  ) {
    fail(`${expectedPhase} renderer/API source identity is inconsistent`);
  }
  return parsed;
}

export function parseDeployedBrowserSmoke(value) {
  const smoke = requireExactKeys(value, REMOTE_SMOKE_KEYS, "remoteSmoke");
  if (
    smoke.schema !== DEPLOYED_BROWSER_SMOKE_SCHEMA ||
    smoke.outcome !== "success"
  ) {
    fail("remote browser smoke did not close successfully");
  }
  return {
    schema: DEPLOYED_BROWSER_SMOKE_SCHEMA,
    sourceSha: requireString(smoke.sourceSha, "remoteSmoke.sourceSha", SHA40),
    rendererOrigin: requireHttpsUrl(
      smoke.rendererOrigin,
      "remoteSmoke.rendererOrigin",
    ),
    rendererManifestCommit: requireString(
      smoke.rendererManifestCommit,
      "remoteSmoke.rendererManifestCommit",
      SHA40,
    ),
    rendererBuildId: requireString(
      smoke.rendererBuildId,
      "remoteSmoke.rendererBuildId",
      SHA256,
    ),
    cloudApiOrigin: requireHttpsUrl(
      smoke.cloudApiOrigin,
      "remoteSmoke.cloudApiOrigin",
    ),
    cloudEnvironment: requireString(
      smoke.cloudEnvironment,
      "remoteSmoke.cloudEnvironment",
    ),
    outcome: "success",
  };
}

function parseLatency(value) {
  const latency = requireExactKeys(value, LATENCY_KEYS, "latency");
  if (
    latency.schemaVersion !== 1 ||
    latency.lane !== RECEIPT_LANE ||
    latency.metric !== LATENCY_METRIC ||
    latency.definition !== LATENCY_DEFINITION
  ) {
    fail("latency evidence labels are invalid");
  }
  return {
    schemaVersion: 1,
    lane: RECEIPT_LANE,
    metric: LATENCY_METRIC,
    definition: LATENCY_DEFINITION,
    firstTurnLatencyMs: requirePositiveInteger(
      latency.firstTurnLatencyMs,
      "latency.firstTurnLatencyMs",
    ),
  };
}

function parseContinuity(value) {
  const continuity = requireExactKeys(value, CONTINUITY_KEYS, "continuity");
  const expected = {
    schemaVersion: 1,
    lane: RECEIPT_LANE,
    challengeTurnCount: 1,
    noAdditionalChatSendAfterChallenge: true,
    personalIdentityEndpointPassed: true,
    reloadHistoryPassed: true,
    freshContextHistoryPassed: true,
    personalIdentityReused: true,
    runtimeBindingReused: true,
    apiBaseReused: true,
    forbiddenAgentMutationCount: 0,
    cleanupDisposition: "no-test-owned-agent",
    conversationHistoryDisposition: "preserved",
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (continuity[key] !== expectedValue) {
      fail(`continuity.${key} is invalid`);
    }
  }
  return expected;
}

export function createDeployedRendererProof({
  authority: authorityValue,
  preflight: preflightValue,
  remoteSmoke: remoteSmokeValue,
  latency: latencyValue,
  continuity: continuityValue,
  postflight: postflightValue,
}) {
  const authority = parsePagesDeploymentAuthority(authorityValue);
  const preflight = parsePagesPublicCheck(preflightValue, "preflight");
  const remoteSmoke = parseDeployedBrowserSmoke(remoteSmokeValue);
  const latency = parseLatency(latencyValue);
  const continuity = parseContinuity(continuityValue);
  const postflight = parsePagesPublicCheck(postflightValue, "postflight");

  for (const [label, observed] of [
    ["preflight", preflight.sourceSha],
    ["remote smoke", remoteSmoke.sourceSha],
    ["remote smoke manifest", remoteSmoke.rendererManifestCommit],
    ["postflight", postflight.sourceSha],
  ]) {
    if (observed !== authority.sourceSha) {
      fail(`${label} source does not match deployment authority`);
    }
  }
  if (
    preflight.renderer.origin !== authority.aliasUrl ||
    remoteSmoke.rendererOrigin !== authority.aliasUrl ||
    postflight.renderer.origin !== authority.aliasUrl
  ) {
    fail("renderer observations do not match the deployment alias");
  }
  if (
    preflight.renderer.buildId !== remoteSmoke.rendererBuildId ||
    preflight.renderer.buildId !== postflight.renderer.buildId ||
    preflight.renderer.indexHtmlSha256 !==
      postflight.renderer.indexHtmlSha256 ||
    preflight.renderer.assetCount !== postflight.renderer.assetCount
  ) {
    fail("renderer changed across the deployed browser trajectory");
  }
  if (
    preflight.api.origin !== "https://api-staging.eliza.app" ||
    remoteSmoke.cloudApiOrigin !== preflight.api.origin ||
    postflight.api.origin !== preflight.api.origin ||
    preflight.api.commit !== authority.sourceSha ||
    postflight.api.commit !== authority.sourceSha ||
    preflight.api.environment !== "staging" ||
    remoteSmoke.cloudEnvironment !== "staging" ||
    postflight.api.environment !== "staging"
  ) {
    fail("API observations do not match the exact staging release");
  }

  return {
    schema: DEPLOYED_RENDERER_PROOF_SCHEMA,
    lane: DEPLOYED_LANE,
    sourceSha: authority.sourceSha,
    workflow: { ...authority.workflow },
    authority,
    preflight,
    remoteSmoke,
    latency,
    continuity,
    postflight,
  };
}

export function parseDeployedRendererProof(value) {
  const proof = requireExactKeys(value, PROOF_KEYS, "deployed proof");
  if (
    proof.schema !== DEPLOYED_RENDERER_PROOF_SCHEMA ||
    proof.lane !== DEPLOYED_LANE
  ) {
    fail("deployed proof identity is invalid");
  }
  const rebuilt = createDeployedRendererProof(proof);
  const workflow = parseWorkflow(proof.workflow, "deployed proof.workflow");
  if (
    workflow.runId !== rebuilt.authority.workflow.runId ||
    workflow.runAttempt !== rebuilt.authority.workflow.runAttempt ||
    proof.sourceSha !== rebuilt.sourceSha
  ) {
    fail("deployed proof workflow or source identity is inconsistent");
  }
  return { ...rebuilt, workflow };
}

async function readJson(path, label) {
  return parseJson(await readFile(resolve(path), "utf8"), label);
}

async function writeClosedJson(path, value) {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return outputPath;
}

function parseCliArguments(argv, expected) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    const name = flag.slice(2);
    if (!expected.has(name)) fail(`unsupported argument: ${flag}`);
    if (values.has(name)) fail(`duplicate argument: ${flag}`);
    values.set(name, value);
  }
  for (const name of expected) {
    if (!values.has(name)) fail(`missing argument: --${name}`);
  }
  return values;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "parse") {
    const values = parseCliArguments(
      rest,
      new Set([
        "input",
        "output",
        "expected-project",
        "expected-commit",
        "expected-branch",
        "expected-alias",
        "expected-environment",
        "expected-production-branch",
        "run-id",
        "run-attempt",
      ]),
    );
    const authority = parseWranglerPagesDeploymentOutput(
      await readFile(resolve(values.get("input")), "utf8"),
      {
        expectedProject: values.get("expected-project"),
        expectedCommit: values.get("expected-commit"),
        expectedBranch: values.get("expected-branch"),
        expectedAlias: values.get("expected-alias"),
        expectedEnvironment: values.get("expected-environment"),
        expectedProductionBranch: values.get("expected-production-branch"),
        runId: values.get("run-id"),
        runAttempt: values.get("run-attempt"),
      },
    );
    await writeClosedJson(values.get("output"), authority);
    process.stdout.write(`${authority.aliasUrl}\n`);
    return;
  }
  if (command === "verify") {
    const values = parseCliArguments(
      rest,
      new Set(["authority", "api-base", "phase", "output"]),
    );
    const check = await verifyPublicPagesDeployment(
      await readJson(values.get("authority"), "authority"),
      { apiBase: values.get("api-base"), phase: values.get("phase") },
    );
    await writeClosedJson(values.get("output"), check);
    return;
  }
  if (command === "combine") {
    const values = parseCliArguments(
      rest,
      new Set([
        "authority",
        "preflight",
        "remote-smoke",
        "latency",
        "continuity",
        "postflight",
        "output",
      ]),
    );
    const proof = createDeployedRendererProof({
      authority: await readJson(values.get("authority"), "authority"),
      preflight: await readJson(values.get("preflight"), "preflight"),
      remoteSmoke: await readJson(values.get("remote-smoke"), "remote smoke"),
      latency: await readJson(values.get("latency"), "latency"),
      continuity: await readJson(values.get("continuity"), "continuity"),
      postflight: await readJson(values.get("postflight"), "postflight"),
    });
    await writeClosedJson(values.get("output"), proof);
    return;
  }
  fail("usage: pages-deployment-authority.mjs parse|verify|combine ...");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    // error-policy:J1 the CLI boundary fails closed without printing evidence.
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
