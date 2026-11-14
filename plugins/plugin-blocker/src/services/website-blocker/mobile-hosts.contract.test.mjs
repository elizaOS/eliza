import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";

const sdk = new URL("../../../../../", import.meta.url).pathname;
const require = createRequire(sdk + "/package.json"),
  ts = require("typescript");
const enginePath =
  process.env.BLOCKER_ENGINE_SOURCE || new URL("./engine.ts", import.meta.url);
const engine = readFileSync(enginePath, "utf8"),
  host = readFileSync(sdk + "/packages/host/src/runtime-env.ts", "utf8");
// Run unchanged owning function AST nodes. Mock only filesystem/elevation/config ports;
// no real hosts file, subprocess, native backend, account or network is accessed.
function declarations(source, names) {
  const file = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return names
    .map((name) => {
      const node = file.statements.find(
        (n) =>
          n.name?.text === name ||
          (ts.isVariableStatement(n) &&
            n.declarationList.declarations.some(
              (d) => d.name.getText(file) === name,
            )),
      );
      assert.ok(node, "Actual source declaration " + name);
      return node.getText(file).replace(/^export\s+/, "");
    })
    .join("\n");
}
const hostFunctions = declarations(host, [
  "presentEnvValue",
  "resolveEnvEntry",
  "resolveEnvValue",
  "resolvePlatform",
  "MOBILE_PLATFORM_VALUES",
  "isMobilePlatform",
]);
const mobilePolicy = new Function(
  "getBootConfigEnvAliases",
  stripTypeScriptTypes(hostFunctions) + ";return isMobilePlatform;",
)(() => null);
const engineFunctions = declarations(engine, [
  "resolveSelfControlHostsFilePath",
  "reconcileSelfControlBlockState",
]);
function fixture(platform, exists = true, extraEnv = {}) {
  const calls = { exists: [], reads: 0 },
    env = { ELIZA_PLATFORM: platform, ...extraEnv };
  const ports = {
    isMobilePlatform: () => mobilePolicy(env),
    process: { env, platform: platform === "android" ? "linux" : "darwin" },
    currentConfig: {},
    fs: {
      existsSync: (p) => {
        calls.exists.push(p);
        return exists;
      },
      readFileSync: () => {
        calls.reads++;
        throw Error("Unexpected hosts read");
      },
    },
    resolveUserPath: (p) => p,
    defaultHostsFilePath: () => "/etc/hosts",
    resolveSelfControlElevationPromptMethod: () => null,
    EMPTY_SELF_CONTROL_BLOCK_POLICY: {
      blockedWebsites: [],
      allowedWebsites: [],
      requestedWebsites: [],
    },
  };
  const api = new Function(
    ...Object.keys(ports),
    stripTypeScriptTypes(engineFunctions) +
      ";return {resolveSelfControlHostsFilePath,reconcileSelfControlBlockState};",
  )(...Object.values(ports));
  return { api, calls };
}
for (const platform of ["android", "ios", " ANDROID "])
  test(
    platform + " refuses a readable hosts file without touching it",
    async () => {
      const { api, calls } = fixture(platform);
      assert.equal(await api.resolveSelfControlHostsFilePath({}), null);
      const status = await api.reconcileSelfControlBlockState({});
      assert.equal(status.available, false);
      assert.equal(status.active, false);
      assert.equal(status.hostsFilePath, null);
      assert.equal(
        status.reason,
        "Website blocking on this device needs the native blocker, which is not connected.",
      );
      assert.deepEqual(calls, { exists: [], reads: 0 });
    },
  );
test("mobile cannot opt into hosts-file writes through config or env overrides", async () => {
  const { api, calls } = fixture("android", true, {
    WEBSITE_BLOCKER_HOSTS_FILE_PATH: "/owned/env-hosts",
  });
  assert.equal(
    await api.resolveSelfControlHostsFilePath({
      hostsFilePath: "/owned/config-hosts",
    }),
    null,
  );
  assert.deepEqual(calls, { exists: [], reads: 0 });
});
test("desktop readable hosts path remains available", async () => {
  const { api, calls } = fixture("desktop");
  assert.equal(await api.resolveSelfControlHostsFilePath({}), "/etc/hosts");
  assert.deepEqual(calls.exists, ["/etc/hosts"]);
});
test("desktop configured path retains precedence over env", async () => {
  const { api } = fixture("desktop", true, {
    WEBSITE_BLOCKER_HOSTS_FILE_PATH: "/owned/env",
  });
  assert.equal(
    await api.resolveSelfControlHostsFilePath({
      hostsFilePath: " /owned/config ",
    }),
    "/owned/config",
  );
});
test("desktop legacy env override remains supported", async () => {
  const { api } = fixture("desktop", true, {
    SELFCONTROL_HOSTS_FILE_PATH: "/owned/legacy",
  });
  assert.equal(await api.resolveSelfControlHostsFilePath({}), "/owned/legacy");
});
test("missing desktop hosts retains its original unavailable status", async () => {
  const { api, calls } = fixture("desktop", false);
  const status = await api.reconcileSelfControlBlockState({});
  assert.equal(status.available, false);
  assert.equal(
    status.reason,
    "Could not find the system hosts file on this machine.",
  );
  assert.equal(calls.reads, 0);
});
