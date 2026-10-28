import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RESIDENT_HOST_CLASSES,
  RESIDENT_HOST_HELPERS,
  RESIDENT_NOTIFICATION_CLASSES,
  RESIDENT_NOTIFICATION_STRINGS,
  ResidentHostSourceError,
  residentHelperKind,
  residentHostIdentity,
  rewriteResidentClass,
  stageResidentHostSources,
} from "./resident-host-sources.mjs";

const upstreamRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
);
const residentRoot =
  "packages/app/platforms/android/app/src/main/java/ai/elizaos/app";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const strings = Object.fromEntries(
  RESIDENT_NOTIFICATION_STRINGS.map(([key]) => [
    key,
    `host_runtime_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`,
  ]),
);
const identity = (overrides = {}) => ({
  packageName: "example.host",
  sockets: {
    agent: "example.host.agent.v1",
    inference: "example.host.inference.v1",
    secureStore: "example.host.secure-store",
  },
  notification: {
    smallIcon: "notification_icon",
    color: "0xff0000ff",
    strings,
  },
  environmentHook: {
    className: "HostAgentEnvironment",
    method: "configure",
    unavailableStatus: "provider-unavailable",
  },
  ...overrides,
});
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resident-host-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const service = () =>
  fs.readFileSync(
    path.join(upstreamRoot, residentRoot, "ElizaAgentService.java"),
    "utf8",
  );

test("every current resident anchor matches and the host identity replaces the upstream one", (t) => {
  const output = path.join(temporary(t), "java");
  const result = stageResidentHostSources({
    sourceRoot: upstreamRoot,
    output,
    identity: identity(),
    helpers: Object.keys(RESIDENT_HOST_HELPERS),
  });
  assert.equal(
    result.files.length,
    RESIDENT_HOST_CLASSES.length + Object.keys(RESIDENT_HOST_HELPERS).length,
  );
  for (const row of result.files) {
    const source = fs.readFileSync(path.join(upstreamRoot, row.path));
    const generated = fs.readFileSync(row.generatedFile);
    assert.equal(row.sourceSha256, sha256(source));
    assert.equal(row.generatedSha256, sha256(generated));
    assert.ok(row.generatedFile.startsWith(output + path.sep));
  }
  for (const name of RESIDENT_HOST_CLASSES) {
    const text = fs.readFileSync(
      path.join(output, "example/host", `${name}.java`),
      "utf8",
    );
    assert.match(text, /^package example\.host;$/m, name);
    assert.doesNotMatch(text, /ai\.elizaos\.app|R\.mipmap\.ic_launcher/, name);
    assert.doesNotMatch(
      text,
      /eliza_local_agent_v1|eliza_bionic_infer_v1/,
      name,
    );
  }
  const agent = fs.readFileSync(
    path.join(output, "example/host/ElizaAgentService.java"),
    "utf8",
  );
  assert.ok(agent.includes('"example.host.agent.v1"'));
  assert.ok(agent.includes('"example.host.inference.v1"'));
  assert.equal(
    agent.split(
      'agentEnv.put("ELIZA_ANDROID_SECURE_STORE_SOCKET", "example.host.secure-store");',
    ).length,
    2,
  );
  assert.equal(
    agent.split("HostAgentEnvironment.configure(this, agentEnv);").length,
    2,
  );
  assert.equal(agent.split(".setColor(0xff0000ff)").length, 3);
  for (const [, anchor] of RESIDENT_NOTIFICATION_STRINGS)
    assert.ok(!agent.includes(anchor), anchor);
  assert.ok(agent.includes("getString(R.string.host_runtime_channel_name)"));
  const connection = fs.readFileSync(
    path.join(
      output,
      "ai/eliza/plugins/browsersurface/ChromiumBrowserConnection.java",
    ),
    "utf8",
  );
  assert.match(
    connection,
    /^package ai\.eliza\.plugins\.browsersurface;\nimport example\.host\.BuildConfig;$/m,
  );
});

test("optional presentation keeps upstream text while sockets and the secure-store route still move", () => {
  const text = rewriteResidentClass(
    "ElizaAgentService",
    service(),
    identity({
      notification: { smallIcon: "notification_icon" },
      environmentHook: null,
    }),
  );
  assert.ok(text.includes('"Eliza agent · Running"'));
  assert.doesNotMatch(text, /setColor|HostAgentEnvironment/);
  assert.ok(text.includes('"example.host.secure-store"'));
  assert.ok(text.includes('"example.host.agent.v1"'));
});

test("a changed anchor fails closed instead of producing a partly branded service", () => {
  const source = service();
  for (const [anchor, message] of [
    ['"Eliza agent · Running"', /notification presentation/],
    [
      'agentEnv.put("ELIZA_LOCAL_AGENT_SOCKET_PATH",privateSocketPath);',
      /insertion point changed/,
    ],
    [".setSmallIcon(R.mipmap.ic_launcher)", /notification builders/],
  ]) {
    const changed = source.replace(anchor, "/* reviewed upstream change */");
    assert.notEqual(changed, source, anchor);
    assert.throws(
      () => rewriteResidentClass("ElizaAgentService", changed, identity()),
      (error) =>
        error instanceof ResidentHostSourceError && message.test(error.message),
    );
  }
});

test("lifecycle hooks wrap the one root publication and follow every running path", () => {
  const hooks = {
    rootPublication: { className: "HostTransport", method: "publishRoot" },
    ready: { className: "HostNotifications", method: "resume" },
  };
  const text = rewriteResidentClass(
    "ElizaAgentService",
    service(),
    identity({ lifecycleHooks: hooks }),
  );
  assert.equal(
    text.split(
      "            HostTransport.publishRoot(() -> { currentLocalAgentToken = token; });",
    ).length,
    2,
  );
  assert.equal(
    text.split("            currentLocalAgentToken = token;").length,
    1,
  );
  assert.equal(
    text.split(
      'currentStatus = "running"; HostNotifications.resume(getApplicationContext());',
    ).length,
    5,
  );
  // Without hooks the upstream lifecycle is unchanged.
  const plain = rewriteResidentClass(
    "ElizaAgentService",
    service(),
    identity(),
  );
  assert.doesNotMatch(plain, /HostTransport|HostNotifications/);
  // A changed lifecycle anchor fails closed instead of skipping a running path.
  for (const [from, to, message] of [
    [
      "            currentLocalAgentToken = token;",
      "            currentLocalAgentToken = rotated;",
      /root publication/,
    ],
    [
      'currentStatus = "running";',
      'currentStatus = "ready";',
      /ready lifecycle/,
    ],
  ]) {
    const changed = service().replace(from, to);
    assert.notEqual(changed, service());
    assert.throws(
      () =>
        rewriteResidentClass(
          "ElizaAgentService",
          changed,
          identity({ lifecycleHooks: hooks }),
        ),
      (error) =>
        error instanceof ResidentHostSourceError && message.test(error.message),
    );
  }
});

test("a host may compile the shared notification classes with its icon and channel labels", (t) => {
  const present = RESIDENT_NOTIFICATION_CLASSES.filter((name) =>
    fs.existsSync(path.join(upstreamRoot, residentRoot, `${name}.java`)),
  );
  assert.ok(present.includes("NativeNotificationProjector"));
  const output = path.join(temporary(t), "java");
  const branded = identity({
    notification: { ...identity().notification, channelLabel: "Host" },
  });
  const result = stageResidentHostSources({
    sourceRoot: upstreamRoot,
    output,
    identity: branded,
    classes: [...RESIDENT_HOST_CLASSES, ...present],
  });
  assert.equal(
    result.files.length,
    RESIDENT_HOST_CLASSES.length + present.length,
  );
  for (const name of present) {
    const text = fs.readFileSync(
      path.join(output, "example/host", `${name}.java`),
      "utf8",
    );
    assert.match(text, /^package example\.host;$/m, name);
    assert.doesNotMatch(text, /ai\.elizaos\.app|ic_dialog_info/, name);
  }
  assert.ok(
    fs
      .readFileSync(
        path.join(output, "example/host/NativeNotificationProjector.java"),
        "utf8",
      )
      .includes(".setSmallIcon(R.drawable.notification_icon)"),
  );
  // Channel ids stay upstream's; only the visible labels take the host name.
  const channels = [
    "package ai.elizaos.app;",
    'id = "eliza_alerts"; name = "Eliza alerts";',
    'id = "eliza_notifications"; name = "Eliza";',
    'id = "eliza_updates"; name = "Eliza updates";',
    'id = "eliza_quiet"; name = "Eliza background";',
  ].join("\n");
  const labelled = rewriteResidentClass(
    "NativeNotificationChannels",
    channels,
    branded,
  );
  for (const expected of [
    'id = "eliza_alerts"; name = "Host alerts";',
    'id = "eliza_notifications"; name = "Host";',
    'id = "eliza_updates"; name = "Host updates";',
    'id = "eliza_quiet"; name = "Host background";',
  ])
    assert.ok(labelled.includes(expected), expected);
  assert.equal(
    rewriteResidentClass("NativeNotificationChannels", channels, identity()),
    channels.replace("ai.elizaos.app", "example.host"),
  );
  assert.throws(
    () =>
      rewriteResidentClass(
        "NativeNotificationChannels",
        channels.replace('name = "Eliza updates"', 'name = "Updates"'),
        branded,
      ),
    /notification channels/,
  );
  assert.throws(
    () =>
      rewriteResidentClass(
        "NativeNotificationProjector",
        "package ai.elizaos.app;",
        branded,
      ),
    /shared notification builders/,
  );
});

test("identity mappings are complete, distinct and never reuse the upstream identity", () => {
  for (const mutate of [
    (value) => (value.packageName = "ai.elizaos.app"),
    (value) => (value.packageName = "Example.Host"),
    (value) => (value.sockets.inference = value.sockets.agent),
    (value) => (value.sockets.secureStore = "with space"),
    (value) => (value.notification.color = "#0000ff"),
    (value) => (value.notification.smallIcon = "Icon"),
    (value) => delete value.notification.strings.runningDetail,
    (value) => (value.environmentHook.method = "configure()"),
    (value) => (value.environmentHook.unavailableStatus = "$&"),
    (value) => (value.notification.channelLabel = "Host\nalerts"),
    (value) => (value.notification.channelLabel = " Host"),
    (value) =>
      (value.lifecycleHooks = { started: { className: "A", method: "b" } }),
    (value) =>
      (value.lifecycleHooks = { ready: { className: "A", method: "b()" } }),
  ]) {
    const value = structuredClone(identity());
    mutate(value);
    assert.throws(() => residentHostIdentity(value), ResidentHostSourceError);
  }
});

test("staging writes only into a new directory outside the upstream source", (t) => {
  const root = temporary(t);
  const occupied = path.join(root, "occupied");
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, "keep.java"), "user");
  assert.throws(
    () =>
      stageResidentHostSources({
        sourceRoot: upstreamRoot,
        output: occupied,
        identity: identity(),
      }),
    /new directory/,
  );
  assert.equal(
    fs.readFileSync(path.join(occupied, "keep.java"), "utf8"),
    "user",
  );
  assert.throws(
    () =>
      stageResidentHostSources({
        sourceRoot: upstreamRoot,
        output: path.join(upstreamRoot, "packages/app/build/resident-host"),
        identity: identity(),
      }),
    /outside the upstream source/,
  );
  for (const options of [
    { classes: ["Unknown"] },
    { classes: ["AgentSecureStore"] },
    { helpers: ["packages/app/package.json"] },
    { helpers: [`${residentRoot}/ElizaAgentService.java`] },
    {
      helpers: [
        Object.keys(RESIDENT_HOST_HELPERS)[0],
        Object.keys(RESIDENT_HOST_HELPERS)[0],
      ],
    },
  ])
    assert.throws(
      () =>
        stageResidentHostSources({
          sourceRoot: upstreamRoot,
          output: path.join(root, "fresh"),
          identity: identity(),
          ...options,
        }),
      ResidentHostSourceError,
    );
  assert.equal(fs.existsSync(path.join(root, "fresh")), false);
});

test("a host selects shared plugin helpers as data: reviewed rewrites apply, others stage verbatim", (t) => {
  const browser =
    "plugins/plugin-native-browser-surface/android/src/main/java/ai/eliza/plugins/browsersurface";
  // A shared helper this module has not reviewed for a rewrite is copied byte for byte.
  const unreviewed = `${browser}/BrowserMainFrameGate.java`;
  assert.equal(Object.hasOwn(RESIDENT_HOST_HELPERS, unreviewed), false);
  assert.equal(residentHelperKind(unreviewed), "verbatim");
  assert.equal(
    residentHelperKind(`${browser}/ChromiumBrowserConnection.java`),
    "host-build-config",
  );
  const output = path.join(temporary(t), "java");
  const result = stageResidentHostSources({
    sourceRoot: upstreamRoot,
    output,
    identity: identity(),
    helpers: [unreviewed],
  });
  const row = result.files.find((file) => file.path === unreviewed);
  assert.equal(
    row.generatedFile,
    path.join(
      output,
      "ai/eliza/plugins/browsersurface/BrowserMainFrameGate.java",
    ),
  );
  assert.equal(row.generatedSha256, row.sourceSha256);
  // Only a shared native plugin's main Java source, by a plain package path, is a helper.
  for (const relative of [
    `${browser}/BrowserDockController.kt`,
    `${browser}/../browsersurface/BrowserWebOrigin.java`,
    "plugins/plugin-native-browser-surface/android/src/test/java/ai/Example.java",
    "plugins/plugin-other/android/src/main/java/ai/Example.java",
    "plugins/plugin-native-agent/android/src/main/java/Example.java",
    `/${browser}/BrowserWebOrigin.java`,
    "constructor",
    undefined,
  ])
    assert.throws(() => residentHelperKind(relative), ResidentHostSourceError);
});
