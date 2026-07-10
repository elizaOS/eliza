/**
 * Unit tests for the connector auth-path registry: structural invariants of
 * the shipped CONNECTOR_PATHS, owner/agent slot naming against the repo's two
 * conventions, and the declarative availability evaluator driven through a
 * fully injected machine context (no real fs/PATH/exec needed to simulate
 * machine states like "signal-cli installed but unregistered").
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { isSecretEnvName, PROBEABLE_PATH_IDS } from "./credential-probes.mjs";

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

function markdownCells(row) {
  return row
    .replaceAll("\\|", "__ESCAPED_PIPE__")
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.replaceAll("__ESCAPED_PIPE__", "|").trim());
}

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const IDENTITY_SLOT_CATALOG = resolve(
  ROOT,
  "docs/testing/hitl-identity-slots.md",
);

function slotModel(path) {
  if (path.rolesVia === "env-slots") return "env slots";
  if (path.rolesVia === "oauth-requested-role") return "OAuth requestedRole";
  if (path.rolesVia === "separate-real-accounts")
    return "separate real account";
  return "single/slotless";
}

function markdownList(values) {
  return values.length > 0 ? values.join("<br>") : "n/a";
}

function parseIdentitySlotCatalog() {
  const rows = new Map();
  const text = readFileSync(IDENTITY_SLOT_CATALOG, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue;
    const cells = markdownCells(line);
    const id = cells[0]?.replace(/^`|`$/g, "");
    assert.equal(cells.length, 8, `${id} row must have 8 columns`);
    rows.set(id, {
      family: cells[1],
      kind: cells[2],
      slotModel: cells[3],
      ownerVars: cells[4],
      agentVars: cells[5],
      gateVars: cells[6],
      notes: cells[7],
    });
  }
  return rows;
}

// --- registry shape ------------------------------------------------------------

test("shipped registry passes every structural invariant", () => {
  assert.deepEqual(validateConnectorPaths(CONNECTOR_PATHS), []);
});

test("wired per-path probes have registry metadata and documented rows", () => {
  const byPath = new Map(CONNECTOR_PATHS.map((path) => [path.id, path]));
  const probeable = new Set(PROBEABLE_PATH_IDS);

  for (const pathId of probeable) {
    const path = byPath.get(pathId);
    assert.ok(path, `PATH_PROBES contains unknown path ${pathId}`);
    assert.notEqual(path.probeId, null, `${pathId} probeId is missing`);
  }
  for (const path of CONNECTOR_PATHS) {
    if (path.probeId !== null) {
      assert.ok(probeable.has(path.id), `${path.id} claims unwired probeId`);
    }
  }

  const doc = readFileSync(
    new URL("../../docs/testing/hitl-probes.md", import.meta.url),
    "utf8",
  );
  const rows = doc.split("\n").filter((line) => /^\| `[^`]+` \|/.test(line));
  const docIds = rows.map((row) => markdownCells(row)[0].replaceAll("`", ""));
  assert.deepEqual(
    docIds.sort(),
    CONNECTOR_PATHS.map((path) => path.id).sort(),
  );

  for (const row of rows) {
    const cells = markdownCells(row);
    assert.equal(cells.length, 10, `wrong cell count in ${row}`);
    const pathId = cells[0].replaceAll("`", "");
    const probeState = cells[4];
    const expected = probeable.has(pathId) ? "wired" : "documented-skip";
    assert.equal(probeState, expected, `${pathId} doc probe state`);
    assert.ok(
      cells.every((cell) => cell.length > 0),
      `${pathId} has blanks`,
    );
  }
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

test("identity-slot catalog is in lockstep with every connector path", () => {
  const rows = parseIdentitySlotCatalog();
  assert.deepEqual(
    [...rows.keys()].sort(),
    CONNECTOR_PATHS.map((path) => path.id).sort(),
  );
  for (const path of CONNECTOR_PATHS) {
    const row = rows.get(path.id);
    assert.ok(row, `missing identity-slot catalog row for ${path.id}`);
    assert.equal(row.family, path.family, `${path.id} family drift`);
    assert.equal(row.kind, path.kind, `${path.id} kind drift`);
    assert.equal(row.slotModel, slotModel(path), `${path.id} slot model drift`);
    assert.equal(
      row.ownerVars,
      markdownList(path.ownerVars),
      `${path.id} owner vars drift`,
    );
    assert.equal(
      row.agentVars,
      markdownList(path.agentVars),
      `${path.id} agent vars drift`,
    );
    assert.equal(
      row.gateVars,
      markdownList([...path.requiredAll, ...path.requiredAny]),
      `${path.id} gate vars drift`,
    );
    assert.ok(row.notes.length > 0, `${path.id} notes cell must not be blank`);
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

test("telegram user-client gates on the owner session key with a legacy alias", () => {
  const path = byId("telegram.user-client");
  assert.deepEqual(path.requiredAll, ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"]);
  assert.deepEqual(path.requiredAny, [
    "TELEGRAM_OWNER_SESSION",
    "TELEGRAM_USER_SESSION",
  ]);
  assert.match(path.notes, /TELEGRAM_OWNER_SESSION/);

  const missing = checkAvailability(path.availability, fakeCtx());
  assert.equal(missing.available, false);
  assert.match(missing.reason, /TELEGRAM_API_ID/);

  const sessionWithoutApiCredentials = checkAvailability(
    path.availability,
    fakeCtx({ env: { TELEGRAM_OWNER_SESSION: "session" } }),
  );
  assert.equal(sessionWithoutApiCredentials.available, false);
  assert.match(sessionWithoutApiCredentials.reason, /TELEGRAM_API_ID/);

  const ownerSession = checkAvailability(
    path.availability,
    fakeCtx({
      env: {
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "hash",
        TELEGRAM_OWNER_SESSION: "session",
      },
    }),
  );
  assert.equal(ownerSession.available, true);

  const legacySession = checkAvailability(
    path.availability,
    fakeCtx({
      env: {
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "hash",
        TELEGRAM_USER_SESSION: "session",
      },
    }),
  );
  assert.equal(legacySession.available, true);

  const savedSession = checkAvailability(
    path.availability,
    fakeCtx({
      env: { TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "hash" },
      existsSync: (filePath) => filePath.endsWith("telegram-user.session"),
    }),
  );
  assert.equal(savedSession.available, true);
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

test("signal.cli scenario: installed-but-unrunnable CLI skips distinctly", () => {
  const spec = byId("signal.cli").availability;
  // This machine's GROUND state: signal-cli in PATH, no data dir, no REST URL.
  const broken = checkAvailability(
    spec,
    fakeCtx({ commandInPath: (command) => command === "signal-cli" }),
  );
  assert.equal(broken.available, false);
  assert.match(broken.reason, /installed but not runnable/);
  // REST bridge configured -> available regardless of the local CLI.
  const viaRest = checkAvailability(
    spec,
    fakeCtx({ env: { SIGNAL_HTTP_URL: "http://x" } }),
  );
  assert.equal(viaRest.available, true);
  // CLI in PATH plus a successful read-only account listing -> available.
  const registered = checkAvailability(
    spec,
    fakeCtx({
      commandInPath: (command) => command === "signal-cli",
      runCommand: (_command, args) => ({
        ok: args[0] === "--version" || args[0] === "listAccounts",
        stdout:
          args[0] === "listAccounts"
            ? "Number: +15551234567\n"
            : "signal-cli 0.13\n",
      }),
    }),
  );
  assert.equal(registered.available, true);
});

test("Signal Desktop and signal-cli unavailability shapes stay distinct", () => {
  const desktop = byId("signal.desktop-bridge").availability;
  const absent = checkAvailability(desktop, fakeCtx());
  assert.equal(absent.available, false);
  assert.equal(absent.reason, "Signal Desktop not installed");
  const noProfile = checkAvailability(
    desktop,
    fakeCtx({ existsSync: (path) => path === "/Applications/Signal.app" }),
  );
  assert.equal(noProfile.available, false);
  assert.equal(noProfile.reason, "no Signal Desktop profile directory");

  const cli = byId("signal.cli").availability;
  const noBinary = checkAvailability(cli, fakeCtx());
  assert.match(noBinary.reason, /signal-cli not in PATH/);
  const noAccount = checkAvailability(
    cli,
    fakeCtx({
      commandInPath: () => true,
      runCommand: (_command, args) => ({
        ok: args[0] === "--version" || args[0] === "listAccounts",
        stdout: args[0] === "listAccounts" ? "" : "signal-cli 0.13\n",
      }),
    }),
  );
  assert.match(noAccount.reason, /no linked Signal account/);
});

test("command-output-nonempty requires both success and actual stdout", () => {
  const spec = {
    type: "command-output-nonempty",
    command: "signal-cli",
    args: ["listAccounts"],
    reason: "no linked account",
  };
  assert.deepEqual(
    checkAvailability(
      spec,
      fakeCtx({ runCommand: () => ({ ok: true, stdout: "" }) }),
    ),
    { available: false, reason: "no linked account" },
  );
  assert.deepEqual(
    checkAvailability(
      spec,
      fakeCtx({
        runCommand: () => ({ ok: true, stdout: "Number: +15551234567\n" }),
      }),
    ),
    { available: true, reason: null },
  );
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

test("github device login is a designed owner-setup state until a client id exists", () => {
  const path = byId("github.device-oauth");
  assert.equal(path.oneClick.type, "github-device");
  const missing = checkAvailability(path.availability, fakeCtx());
  assert.equal(missing.available, false);
  assert.match(missing.reason, /needs owner setup/);
  const configured = checkAvailability(
    path.availability,
    fakeCtx({ env: { GITHUB_OAUTH_CLIENT_ID: "device-client" } }),
  );
  assert.equal(configured.available, true);
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

test("Telegram session env names are classified as secrets", () => {
  assert.equal(isSecretEnvName("TELEGRAM_OWNER_SESSION"), true);
  assert.equal(isSecretEnvName("TELEGRAM_USER_SESSION"), true);
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
