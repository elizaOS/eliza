/**
 * Unit coverage for the LP3 wearable operator's host-side safety contract. The
 * physical lane still needs a real LP3 run for evidence; these tests keep the
 * command builder, redaction, and mode gates from regressing into destructive
 * device operations.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAdbCommandSafe,
  assertLp3Identity,
  buildModePlan,
  buildSettingsCommands,
  DEFAULT_HOST_AGENT_PORT,
  DEFAULT_PACKAGE,
  deriveNextHumanAction,
  FIRST_RUN_REMOTE_DEEPLINK,
  hostStateFileFor,
  makeSafeAdb,
  parseArgs,
  parsePackageInfo,
  parseSurfaceState,
  redactText,
  SHIM_BODY_BY_ROUTE,
  SHIM_ROUTES,
  sanitizeForJson,
  VOICE_SETTINGS_HASH,
  validateRouteSemantics,
} from "./lp3-wearable-operator.mjs";

const baseOptions = {
  mode: "prepare-transport",
  serial: "lp3-serial",
  packageName: DEFAULT_PACKAGE,
  color: false,
  allowUiShim: false,
  cdpPort: 9222,
  hostAgentPort: DEFAULT_HOST_AGENT_PORT,
  startHostAgent: true,
};

function safe(command) {
  return assertAdbCommandSafe({ serial: "s", packageName: DEFAULT_PACKAGE }, [
    "-s",
    "s",
    ...command,
  ]);
}

test("CLI requires explicit serial and package and refuses non-app packages", () => {
  assert.throws(
    () => parseArgs(["status", "--package", DEFAULT_PACKAGE]),
    /--serial is required/,
  );
  assert.throws(
    () => parseArgs(["status", "--serial", "s"]),
    /--package is required/,
  );
  assert.throws(
    () =>
      parseArgs([
        "status",
        "--serial",
        "s",
        "--package",
        "com.android.settings",
      ]),
    /Refusing package/,
  );
});

test("adb safety gate requires the literal exact serial prefix", () => {
  assert.throws(
    () =>
      assertAdbCommandSafe({ serial: "lp3", packageName: DEFAULT_PACKAGE }, [
        "get-state",
      ]),
    /literal -s exact serial/,
  );
  assert.throws(
    () =>
      assertAdbCommandSafe({ serial: "lp3", packageName: DEFAULT_PACKAGE }, [
        "-s",
        "other",
        "get-state",
      ]),
    /literal -s exact serial/,
  );
  assert.doesNotThrow(() =>
    assertAdbCommandSafe({ serial: "lp3", packageName: DEFAULT_PACKAGE }, [
      "-s",
      "lp3",
      "get-state",
    ]),
  );
});

test("strict allowlist accepts only operator adb commands", () => {
  for (const command of [
    ["get-state"],
    ["shell", "getprop", "ro.product.model"],
    ["shell", "getprop", "ro.product.product.name"],
    ["shell", "getprop", "ro.product.device"],
    ["shell", "getprop", "ro.build.fingerprint"],
    ["shell", "dumpsys", "package", DEFAULT_PACKAGE],
    ["shell", "dumpsys", "window", "windows"],
    ["shell", "dumpsys", "activity", "activities"],
    ["shell", "pm", "path", DEFAULT_PACKAGE],
    ["shell", "sha256sum", `/data/app/~~abc/${DEFAULT_PACKAGE}-xyz/base.apk`],
    ["shell", "pidof", DEFAULT_PACKAGE],
    ["logcat", "-c"],
    ["logcat", "-d", "-t", "800"],
    ["forward", "tcp:9222", "localabstract:webview_devtools_remote_123"],
    ["forward", "--remove", "tcp:9222"],
    ["reverse", "--remove", "tcp:31337"],
    ["reverse", "tcp:31337", "tcp:31338"],
    ["shell", "am", "force-stop", DEFAULT_PACKAGE],
    ["shell", "am", "start", "-W", "-n", `${DEFAULT_PACKAGE}/.MainActivity`],
    [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-c",
      "android.intent.category.BROWSABLE",
      "-d",
      "elizaos://settings",
      DEFAULT_PACKAGE,
    ],
    [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-c",
      "android.intent.category.BROWSABLE",
      "-d",
      FIRST_RUN_REMOTE_DEEPLINK,
      DEFAULT_PACKAGE,
    ],
  ]) {
    assert.doesNotThrow(() => safe(command), command.join(" "));
  }
});

test("adb safety gate rejects destructive, arbitrary, and overly broad commands", () => {
  for (const command of [
    ["install", "-r", "app.apk"],
    ["uninstall", DEFAULT_PACKAGE],
    ["push", "x", "/sdcard/x"],
    ["pull", "/sdcard/x", "x"],
    ["shell", "rm", "-rf", "/sdcard/x"],
    ["shell", "pm", "clear", DEFAULT_PACKAGE],
    [
      "shell",
      "pm",
      "grant",
      DEFAULT_PACKAGE,
      "android.permission.RECORD_AUDIO",
    ],
    ["root"],
    ["reboot"],
    ["shell", "su", "-c", "id"],
    ["shell", "settings", "list", "global"],
    ["shell", "am", "start", "-d", "https://example.test/?token=x"],
    ["reverse", "tcp:31337", "tcp:notaport"],
    ["logcat", "-d"],
  ]) {
    assert.throws(() => safe(command), /Unsafe|refused/);
  }
});

test("force-stop is allowed only for ai.elizaos.app orphan GATT reset", () => {
  assert.doesNotThrow(() =>
    safe(["shell", "am", "force-stop", DEFAULT_PACKAGE]),
  );
  assert.throws(
    () => safe(["shell", "am", "force-stop", "com.android.bluetooth"]),
    /Unsafe adb shell command|force-stop/,
  );
});

test("makeSafeAdb enforces the explicit serial prefix", () => {
  const calls = [];
  const adb = makeSafeAdb({
    serial: "lp3",
    packageName: DEFAULT_PACKAGE,
    adbBin: "adb",
    exec: (_bin, args) => {
      calls.push(args);
      return { status: 0, stdout: "ok", stderr: "" };
    },
  });
  assert.equal(adb(["shell", "getprop", "ro.product.model"]), "ok");
  assert.deepEqual(calls[0], [
    "-s",
    "lp3",
    "shell",
    "getprop",
    "ro.product.model",
  ]);
});

test("external-tools and color settings match LightOS sibling contract", () => {
  assert.deepEqual(buildSettingsCommands(), [
    ["shell", "settings", "put", "global", "show_external_tools", "true"],
    ["shell", "settings", "get", "global", "show_external_tools"],
  ]);
  assert.deepEqual(buildSettingsCommands({ color: true }), [
    ["shell", "settings", "put", "global", "show_external_tools", "true"],
    ["shell", "settings", "get", "global", "show_external_tools"],
    ["shell", "settings", "put", "system", "accessibility_color_mode", "1"],
    ["shell", "settings", "get", "system", "accessibility_color_mode"],
  ]);
  for (const command of buildSettingsCommands({ color: true })) {
    assert.doesNotThrow(() => safe(command));
  }
});

test("settings safety gate rejects invented or unrelated keys", () => {
  for (const command of [
    ["shell", "settings", "put", "system", "LIGHTOS_SHOW_EXTERNAL_TOOLS", "1"],
    [
      "shell",
      "settings",
      "put",
      "secure",
      "accessibility_display_daltonizer",
      "-1",
    ],
    [
      "shell",
      "settings",
      "put",
      "secure",
      "enabled_accessibility_services",
      "x",
    ],
  ]) {
    assert.throws(() => safe(command), /Unsafe settings/);
  }
});

test("prepare uses app force-stop, managed host reverse, and token-free remote deep link", () => {
  const plan = buildModePlan(baseOptions);
  const commands = plan.commands.map((command) => command.join(" "));
  assert.ok(commands.includes("logcat -c"));
  assert.ok(commands.includes(`shell am force-stop ${DEFAULT_PACKAGE}`));
  assert.ok(commands.includes("reverse --remove tcp:31337"));
  assert.ok(commands.includes("reverse tcp:31337 tcp:<host-agent-port>"));
  assert.ok(
    commands.indexOf("reverse --remove tcp:31337") <
      commands.indexOf("reverse tcp:31337 tcp:<host-agent-port>"),
  );
  assert.equal(plan.startsManagedHost, true);
  assert.equal(plan.usesAdbReverse, true);
  assert.equal(plan.usesRemoteFirstRunDeepLink, true);
  assert.equal(
    FIRST_RUN_REMOTE_DEEPLINK,
    "elizaos://first-run/runtime/remote?api=http%3A%2F%2F127.0.0.1%3A31337",
  );
  assert.doesNotMatch(FIRST_RUN_REMOTE_DEEPLINK, /token|bearer|session|code/i);
  assert.doesNotMatch(commands.join("\n"), /pm clear|install|uninstall/);
});

test("orphan GATT reset ordering clears logcat before app force-stop", () => {
  const plan = buildModePlan(baseOptions);
  const commands = plan.commands.map((command) => command.join(" "));
  assert.ok(
    commands.indexOf("logcat -c") <
      commands.indexOf(`shell am force-stop ${DEFAULT_PACKAGE}`),
  );
});

test("recover preserves app data and never first-run mutates", () => {
  const plan = buildModePlan({
    ...baseOptions,
    mode: "recover",
    allowUiShim: true,
  });
  const text = plan.commands.map((command) => command.join(" ")).join("\n");
  assert.match(text, new RegExp(`shell am force-stop ${DEFAULT_PACKAGE}`));
  assert.match(text, /reverse tcp:31337 tcp:<host-agent-port>/);
  assert.equal(plan.usesRemoteFirstRunDeepLink, false);
  assert.equal(plan.firstRunStorageMutation, false);
  assert.doesNotMatch(text, /first-run|install|uninstall|pm clear|wipe|reboot/);
  assert.deepEqual(plan.shimRoutes, SHIM_ROUTES);
});

test("acceptance plan excludes host, reverse, deep link, shim, and storage mutation", () => {
  assert.throws(
    () =>
      parseArgs([
        "acceptance",
        "--serial",
        "s",
        "--package",
        DEFAULT_PACKAGE,
        "--allow-ui-shim",
      ]),
    /acceptance refuses --allow-ui-shim/,
  );
  const plan = buildModePlan({ ...baseOptions, mode: "acceptance" });
  const text = plan.commands.map((command) => command.join(" ")).join("\n");
  assert.deepEqual(plan.shimRoutes, []);
  assert.equal(plan.firstRunStorageMutation, false);
  assert.equal(plan.qualificationMode, "full_e2e");
  assert.equal(plan.startsManagedHost, false);
  assert.equal(plan.usesAdbReverse, false);
  assert.equal(plan.usesRemoteFirstRunDeepLink, false);
  assert.doesNotMatch(text, /reverse|first-run|elizaos:\/\/|settings put/);
});

test("all transport modes report transport qualification only", () => {
  assert.equal(
    buildModePlan({ ...baseOptions, mode: "prepare-transport" })
      .qualificationMode,
    "transport_qualification_only",
  );
  assert.equal(
    buildModePlan({ ...baseOptions, mode: "recover" }).qualificationMode,
    "transport_qualification_only",
  );
  assert.equal(
    buildModePlan({ ...baseOptions, mode: "acceptance" }).qualificationMode,
    "full_e2e",
  );
});

test("UI shim body map is exact and does not imply storage writes", async () => {
  assert.deepEqual(SHIM_ROUTES, [
    "GET /api/auth/status",
    "GET /api/status",
    "GET /api/first-run/status",
  ]);
  assert.deepEqual(SHIM_BODY_BY_ROUTE["GET /api/auth/status"], {
    required: false,
    authenticated: true,
    loginRequired: false,
    bootstrapRequired: false,
    localAccess: true,
    passwordConfigured: false,
    pairingEnabled: false,
    expiresAt: null,
  });
  assert.deepEqual(SHIM_BODY_BY_ROUTE["GET /api/status"], {
    state: "running",
    agentName: "LP3 Transport Qualification",
    canRespond: true,
  });
  assert.deepEqual(SHIM_BODY_BY_ROUTE["GET /api/first-run/status"], {
    complete: true,
    cloudProvisioned: false,
    deploymentTarget: "local",
  });
  const source = new URL("./lp3-wearable-operator.mjs", import.meta.url);
  const text = await import("node:fs").then((fs) =>
    fs.readFileSync(source, "utf8"),
  );
  assert.doesNotMatch(text, /localStorage\.setItem|sessionStorage\.setItem/);
  assert.match(text, /patchCapacitor/);
  assert.match(text, /const plugins = capacitor\.Plugins/);
  assert.match(text, /originalAgentRequest/);
  assert.match(text, /responseBodyFor/);
});

test("managed host ownership state is stable across evidence directories", () => {
  const first = hostStateFileFor({ hostStateFile: null });
  const second = hostStateFileFor({ hostStateFile: null });
  assert.equal(first, second);
  assert.match(first, /[\\/]\.eliza[\\/]lp3-wearable-operator[\\/]/);
});

test("real host route semantics accept optional compatibility fields", () => {
  assert.equal(
    validateRouteSemantics("GET /api/auth/status", 200, {
      required: false,
      authenticated: false,
      loginRequired: false,
    }),
    true,
  );
  assert.equal(
    validateRouteSemantics("GET /api/status", 200, { state: "running" }),
    true,
  );
  assert.equal(
    validateRouteSemantics("GET /api/first-run/status", 200, {
      complete: true,
      cloudProvisioned: false,
    }),
    true,
  );
});

test("voice wearable navigation uses the registered Settings section hash", () => {
  assert.equal(VOICE_SETTINGS_HASH, "#voice");
});

test("disconnected pendant status text does not suppress operator connect", () => {
  assert.equal(
    parseSurfaceState({
      surfaceVisible: true,
      connectEnabled: true,
      connectedVisible: false,
      statusText: "Disconnected",
    }),
    "connect_ready",
  );
  assert.equal(
    parseSurfaceState({
      surfaceVisible: true,
      connectEnabled: false,
      connectedVisible: true,
      statusText: "Hearing",
    }),
    "status_visible",
  );
});

test("Android WebView CDP disconnect never closes the app browser", async () => {
  const source = new URL("./lp3-wearable-operator.mjs", import.meta.url);
  const text = await import("node:fs").then((fs) =>
    fs.readFileSync(source, "utf8"),
  );
  assert.match(text, /puppeteer-core/);
  assert.match(text, /browser\.disconnect\(\)/);
  assert.doesNotMatch(text, /browser\.close\(\)/);
});

test("managed-host plan is safe and detached by source contract", async () => {
  const source = new URL("./lp3-wearable-operator.mjs", import.meta.url);
  const text = await import("node:fs").then((fs) =>
    fs.readFileSync(source, "utf8"),
  );
  assert.match(text, /serve-real-local-agent\.ts/);
  assert.match(text, /run-node-tsx\.mjs/);
  assert.match(text, /detached:\s*true/);
  assert.match(text, /ELIZA_PAIRING_DISABLED:\s*"1"/);
  assert.match(text, /127\.0\.0\.1/);
  assert.match(text, /\/api\/first-run\/status/);
  assert.match(text, /LP3 Transport Qualification/);
  assert.match(
    text,
    /if \(!hasManagedHostOwnership\(state\)\)[\s\S]+process\.kill\(Number\(state\.pid\), "SIGTERM"\)/,
  );
});

test("status nextHumanAction is exactly one approved actionable string", () => {
  assert.equal(
    deriveNextHumanAction({
      wearableSurfaceState: "status_visible",
      foregroundScreen: "unknown",
      startupRouteHealth: {
        "GET /api/auth/status": { status: 200, ok: true },
        "GET /api/status": { status: 200, ok: true },
        "GET /api/first-run/status": { status: 200, ok: true },
      },
      qualificationMode: "transport_qualification_only",
      mode: "prepare-transport",
      permissions: { RECORD_AUDIO: false },
    }),
    "approve the Android system permission prompt",
  );

  const nextHumanAction = deriveNextHumanAction({
    wearableSurfaceState: "status_visible",
    foregroundScreen: "mCurrentFocus=BluetoothDevicePicker",
    startupRouteHealth: {
      "GET /api/auth/status": { status: 200, ok: true },
      "GET /api/status": { status: 200, ok: true },
      "GET /api/first-run/status": { status: 200, ok: true },
    },
    qualificationMode: "full_e2e",
    mode: "acceptance",
  });
  assert.equal(typeof nextHumanAction, "string");
  assert.equal(nextHumanAction.split(/\n/).length, 1);
  assert.match(
    nextHumanAction,
    /Android system permission|system device chooser|spoken phrase|speak one phrase|rerun/,
  );
  assert.doesNotMatch(nextHumanAction, /tap the app connect button/i);
});

test("result JSON shape has one next action string and no raw response bodies", () => {
  const result = sanitizeForJson({
    ok: false,
    mode: "acceptance",
    error: "bad token=secret",
    nextHumanAction: "rerun prepare-transport",
    startupRouteHealth: {
      "GET /api/auth/status": { status: 200, ok: true },
      "GET /api/status": { status: 500, ok: false },
    },
    package: { versionCode: "123", baseApkSha256: "abc" },
  });
  assert.equal(typeof result.nextHumanAction, "string");
  assert.equal(result.nextHumanAction.split(/\n/).length, 1);
  assert.deepEqual(result.startupRouteHealth["GET /api/status"], {
    status: 500,
    ok: false,
  });
  assert.deepEqual(result.startupRouteHealth["GET /api/auth/status"], {
    status: 200,
    ok: true,
  });
  assert.deepEqual(result.package, {
    versionCode: "123",
    baseApkSha256: "abc",
  });
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("redaction catches URLs, query secrets, bearer strings, JWTs, blobs, and sensitive object keys", () => {
  const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.signature";
  const text = [
    "Bearer secret-token-value",
    "https://example.test/api?token=abc&session=def",
    `jwt=${jwt}`,
    "A".repeat(140),
  ].join("\n");
  const redacted = redactText(text);
  assert.match(redacted, /Bearer \[REDACTED]/);
  assert.doesNotMatch(redacted, /secret-token-value/);
  assert.doesNotMatch(redacted, /token=abc/);
  assert.doesNotMatch(redacted, new RegExp(jwt.replaceAll(".", "\\.")));
  assert.match(redacted, /\[REDACTED_BLOB]/);
  assert.deepEqual(
    sanitizeForJson({
      token: "abc",
      auth: { nested: "secret" },
      credentialBody: { url: "https://x.test/?token=abc" },
      safe: "ok",
    }),
    {
      token: "[REDACTED]",
      auth: "[REDACTED]",
      credentialBody: "[REDACTED]",
      safe: "ok",
    },
  );
});

test("LP3 identity check accepts only TLP301 LightPhoneIII", () => {
  assert.equal(
    assertLp3Identity({
      model: "TLP301",
      product: "LightPhoneIII",
      device: "LightPhoneIII",
    }),
    true,
  );
  assert.throws(
    () =>
      assertLp3Identity({
        model: "Pixel 9",
        product: "LightPhoneIII",
        device: "LightPhoneIII",
      }),
    /Refusing non-LP3/,
  );
});

test("package parser requires debuggable state without fabricating success", () => {
  assert.deepEqual(
    parsePackageInfo(`
      versionCode=42 minSdk=29
      versionName=1.2.3
      pkgFlags=[ HAS_CODE DEBUGGABLE ALLOW_CLEAR_USER_DATA ]
    `),
    { versionCode: "42", versionName: "1.2.3", debuggable: true },
  );
  assert.deepEqual(
    parsePackageInfo("versionName=1.2.3 pkgFlags=[ HAS_CODE ]"),
    {
      versionCode: null,
      versionName: "1.2.3",
      debuggable: false,
    },
  );
});

test("no forbidden source command literals appear in execution paths", async () => {
  const source = new URL("./lp3-wearable-operator.mjs", import.meta.url);
  const text = await import("node:fs").then((fs) =>
    fs.readFileSync(source, "utf8"),
  );
  for (const literal of [
    '"install"',
    '"uninstall"',
    '"clear"',
    '"root"',
    '"reboot"',
    '"grant"',
    '"rm"',
    '"push"',
    '"pull"',
  ]) {
    assert.doesNotMatch(text, new RegExp(literal.replaceAll('"', '\\"')));
  }
});
