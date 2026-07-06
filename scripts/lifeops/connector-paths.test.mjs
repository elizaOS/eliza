/**
 * Unit tests for the connector auth-path registry: structural invariants of
 * the shipped CONNECTOR_PATHS, owner/agent slot naming against the repo's two
 * conventions, and the declarative availability evaluator driven through a
 * fully injected machine context (no real fs/PATH/exec needed to simulate
 * machine states like "signal-cli installed but unregistered").
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  appBase,
  CONNECTOR_PATH_ENV_NAMES,
  CONNECTOR_PATH_KINDS,
  CONNECTOR_PATHS,
  checkAvailability,
  DEFAULT_APP_BASE,
  evaluateConnectorPaths,
  getFamilies,
  getPathsForFamily,
  resolveDeepLink,
  validateConnectorPaths,
} from "./connector-paths.mjs";

/** Deterministic machine context; override per scenario. */
function fakeCtx(overrides = {}) {
  return {
    env: {},
    platform: "darwin",
    home: "/Users/op",
    existsSync: () => false,
    commandInPath: () => false,
    runCommand: () => ({ ok: false }),
    ...overrides,
  };
}

const byId = (id) => {
  const path = CONNECTOR_PATHS.find((entry) => entry.id === id);
  assert.ok(path, `registry is missing ${id}`);
  return path;
};

// --- registry shape ------------------------------------------------------------

test("shipped registry passes every structural invariant", () => {
  assert.deepEqual(validateConnectorPaths(CONNECTOR_PATHS), []);
});

test("validateConnectorPaths flags duplicates, bad kinds, bad probe ids, missing endpoints", () => {
  const problems = validateConnectorPaths([
    {
      id: "fam.a",
      family: "fam",
      kind: "bot",
      label: "ok",
      requiredAll: [],
      requiredAny: [],
      optional: [],
      ownerVars: [],
      agentVars: [],
      rolesVia: null,
      probeId: "telegram",
      probeEndpoint: "GET x",
      oneClick: null,
      availability: { type: "always" },
    },
    {
      id: "fam.a",
      family: "other",
      kind: "carrier-pigeon",
      label: "",
      requiredAll: ["lower_case"],
      requiredAny: [],
      optional: [],
      ownerVars: ["OWNER_VAR"],
      agentVars: [],
      rolesVia: null,
      probeId: "nope",
      probeEndpoint: "",
      oneClick: { type: "telepathy" },
      availability: { type: "mystery" },
    },
  ]);
  for (const needle of [
    "duplicate id: fam.a",
    "id must be <family>.<slug>",
    "invalid kind carrier-pigeon",
    "missing label",
    "unknown probeId nope",
    "free/cheap probe endpoint",
    "invalid oneClick type telepathy",
    "ownerVars/agentVars imply rolesVia env-slots",
    "malformed env name lower_case",
    "unknown availability type mystery",
  ]) {
    assert.ok(
      problems.some((problem) => problem.includes(needle)),
      `expected a problem matching ${JSON.stringify(needle)} in ${JSON.stringify(problems)}`,
    );
  }
});

test("every required family is present with multiple-path families intact", () => {
  const families = getFamilies();
  for (const family of [
    "model",
    "elizacloud",
    "github",
    "google",
    "telegram",
    "discord",
    "slack",
    "signal",
    "whatsapp",
    "imessage",
    "x",
    "twilio",
    "health",
    "finance",
    "crypto",
  ]) {
    assert.ok(families.includes(family), `missing family ${family}`);
  }
  assert.equal(getPathsForFamily("model").length, 3);
  assert.ok(getPathsForFamily("github").length >= 3);
  assert.ok(getPathsForFamily("signal").length >= 2);
});

test("kinds are constrained to the declared vocabulary", () => {
  for (const path of CONNECTOR_PATHS) {
    assert.ok(
      CONNECTOR_PATH_KINDS.includes(path.kind),
      `${path.id} kind ${path.kind}`,
    );
  }
});

// --- owner/agent conventions ------------------------------------------------------

test("github.pat carries the concrete two-slot env names from plugin-github", () => {
  const path = byId("github.pat");
  assert.equal(path.rolesVia, "env-slots");
  assert.deepEqual(path.ownerVars, [
    "GITHUB_USER_PAT",
    "ELIZA_E2E_GITHUB_USER_PAT",
  ]);
  assert.deepEqual(path.agentVars, [
    "GITHUB_AGENT_PAT",
    "ELIZA_E2E_GITHUB_AGENT_PAT",
  ]);
});

test("google owner/agent rows use oauth requestedRole, never invented env slots", () => {
  for (const id of ["google.oauth-owner", "google.oauth-agent"]) {
    const path = byId(id);
    assert.equal(path.rolesVia, "oauth-requested-role");
    assert.deepEqual(path.ownerVars, []);
    assert.deepEqual(path.agentVars, []);
  }
});

test("x agent slot is a separate real account, permanently skipped with the matrix reason", () => {
  const path = byId("x.agent-account");
  assert.equal(path.rolesVia, "separate-real-accounts");
  const { available, reason } = checkAvailability(path.availability, fakeCtx());
  assert.equal(available, false);
  assert.match(reason, /separate real account/);
});

test("env-name union covers the dashboard allowlist extensions", () => {
  for (const name of [
    "GITHUB_USER_PAT",
    "GITHUB_AGENT_PAT",
    "ELIZA_CLOUD_API_KEY",
    "BLUEBUBBLES_SERVER_URL",
    "EVM_PRIVATE_KEY",
    "TWITTER_ACCESS_TOKEN_SECRET",
  ]) {
    assert.ok(CONNECTOR_PATH_ENV_NAMES.has(name), `missing ${name}`);
  }
});

// --- availability evaluator ---------------------------------------------------------

test("leaf spec types evaluate against the injected ctx", () => {
  const ctx = fakeCtx({
    env: { SET_VAR: "x", BLANK: "  " },
    existsSync: (path) => path === "/Users/op/thing",
    commandInPath: (command) => command === "have-me",
    runCommand: (command) => ({ ok: command === "gh" }),
    platform: "linux",
  });
  assert.equal(checkAvailability({ type: "always" }, ctx).available, true);
  assert.deepEqual(checkAvailability({ type: "never", reason: "no" }, ctx), {
    available: false,
    reason: "no",
  });
  assert.equal(
    checkAvailability({ type: "env-present", names: ["SET_VAR"] }, ctx)
      .available,
    true,
  );
  assert.equal(
    checkAvailability({ type: "env-present", names: ["BLANK"] }, ctx).available,
    false,
  );
  assert.equal(
    checkAvailability({ type: "env-all", names: ["SET_VAR", "BLANK"] }, ctx)
      .available,
    false,
  );
  assert.match(
    checkAvailability({ type: "env-all", names: ["SET_VAR", "BLANK"] }, ctx)
      .reason,
    /BLANK/,
  );
  assert.equal(
    checkAvailability({ type: "file-exists", path: "~/thing" }, ctx).available,
    true,
  );
  assert.equal(
    checkAvailability({ type: "dir-exists", path: "/elsewhere" }, ctx)
      .available,
    false,
  );
  assert.equal(
    checkAvailability({ type: "command-in-path", command: "have-me" }, ctx)
      .available,
    true,
  );
  assert.equal(
    checkAvailability(
      { type: "command-ok", command: "gh", args: ["auth", "token"] },
      ctx,
    ).available,
    true,
  );
  assert.equal(
    checkAvailability({ type: "platform", platform: "darwin" }, ctx).available,
    false,
  );
  assert.throws(
    () => checkAvailability({ type: "mystery" }, ctx),
    /Unknown availability/,
  );
});

test("any-of aggregates all branch reasons; all-of reports the first failure", () => {
  const ctx = fakeCtx();
  const anyOf = checkAvailability(
    {
      type: "any-of",
      specs: [
        { type: "never", reason: "first missing" },
        { type: "never", reason: "second missing" },
      ],
    },
    ctx,
  );
  assert.equal(anyOf.available, false);
  assert.equal(anyOf.reason, "first missing; second missing");
  const allOf = checkAvailability(
    {
      type: "all-of",
      specs: [
        { type: "always" },
        { type: "never", reason: "blocker" },
        { type: "never", reason: "unreached" },
      ],
    },
    ctx,
  );
  assert.deepEqual(allOf, { available: false, reason: "blocker" });
});

test("signal.cli scenario: installed-but-unregistered CLI skips with the account reason", () => {
  const spec = byId("signal.cli").availability;
  // This machine's GROUND state: signal-cli in PATH, no data dir, no REST URL.
  const broken = checkAvailability(
    spec,
    fakeCtx({ commandInPath: (command) => command === "signal-cli" }),
  );
  assert.equal(broken.available, false);
  assert.match(broken.reason, /registered signal-cli account/);
  // REST bridge configured -> available regardless of the local CLI.
  const viaRest = checkAvailability(
    spec,
    fakeCtx({ env: { SIGNAL_HTTP_URL: "http://x" } }),
  );
  assert.equal(viaRest.available, true);
  // CLI in PATH plus a registered data dir -> available.
  const registered = checkAvailability(
    spec,
    fakeCtx({
      commandInPath: (command) => command === "signal-cli",
      existsSync: (path) => path === "/Users/op/.local/share/signal-cli",
    }),
  );
  assert.equal(registered.available, true);
});

test("oauth-app-dependent rows skip with an explanatory reason until an app is configured", () => {
  const discord = checkAvailability(
    byId("discord.user-oauth").availability,
    fakeCtx(),
  );
  assert.equal(discord.available, false);
  assert.match(discord.reason, /no Discord user-OAuth app configured/);
  const github = checkAvailability(
    byId("github.user-oauth").availability,
    fakeCtx(),
  );
  assert.equal(github.available, false);
  assert.match(github.reason, /no OAuth app configured/);
  const configured = checkAvailability(
    byId("github.user-oauth").availability,
    fakeCtx({
      env: { GITHUB_OAUTH_CLIENT_ID: "id", GITHUB_OAUTH_CLIENT_SECRET: "s" },
    }),
  );
  assert.equal(configured.available, true);
});

test("github.gh-cli requires gh in PATH and an authenticated keyring", () => {
  const spec = byId("github.gh-cli").availability;
  assert.match(checkAvailability(spec, fakeCtx()).reason, /not in PATH/);
  const unauthed = checkAvailability(
    spec,
    fakeCtx({ commandInPath: () => true, runCommand: () => ({ ok: false }) }),
  );
  assert.match(unauthed.reason, /not authenticated/);
  const authed = checkAvailability(
    spec,
    fakeCtx({ commandInPath: () => true, runCommand: () => ({ ok: true }) }),
  );
  assert.equal(authed.available, true);
});

// --- evaluation output safety ---------------------------------------------------------

test("evaluateConnectorPaths emits env names and reasons, never env values", () => {
  const secret = "sk-super-secret-value-1234";
  const rows = evaluateConnectorPaths(
    fakeCtx({ env: { OPENAI_API_KEY: secret, SIGNAL_HTTP_URL: secret } }),
  );
  assert.equal(rows.length, CONNECTOR_PATHS.length);
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes(secret), false);
  for (const row of rows) {
    assert.equal(typeof row.available, "boolean");
    assert.ok(row.available || typeof row.reason === "string");
  }
});

// --- deep links -------------------------------------------------------------------------

test("deep-link rows resolve against ELIZA_APP_BASE_URL with the v1 default", () => {
  assert.equal(appBase({}), DEFAULT_APP_BASE);
  assert.equal(appBase({ ELIZA_APP_BASE_URL: "http://h:9" }), "http://h:9");
  const owner = byId("google.oauth-owner");
  assert.equal(
    resolveDeepLink(owner, {}),
    `${DEFAULT_APP_BASE}/settings?section=connectors`,
  );
  assert.equal(resolveDeepLink(byId("model.openai-key"), {}), null);
});
