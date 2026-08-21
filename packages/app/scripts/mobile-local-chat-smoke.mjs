function adbPath() {
  return androidTool("platform-tools/adb", "adb");
}

function androidBackgroundServicesReady(services, id) {
  const foregroundCount = services.match(/isForeground=true/g)?.length ?? 0;
  return (
    services.includes(`${id}/.ElizaAgentService`) &&
    services.includes(`${id}/.GatewayConnectionService`) &&
    foregroundCount >= 2
  );
}

function androidDeviceSerial(adb) {
  const devices = requireExec(
    adb,
    ["devices"],
    "No Android device or emulator is available.",
  );
  const connected = devices
    .split("\n")
    .slice(1)
    .map((entry) => entry.trim())
    .filter((entry) => entry.endsWith("\tdevice"))
    .map((entry) => entry.split(/\s+/)[0]);
  const requested = process.env.ANDROID_SERIAL?.trim();
  if (requested) {
    if (connected.includes(requested)) return requested;
    const state = tryExec(adb, ["-s", requested, "get-state"], {
      allowFailure: true,
    });
    if (state === "device") return requested;
    if (requireInstalled) {
      throw new Error(
        `ANDROID_SERIAL=${requested} is not an attached Android device/emulator.`,
      );
    }
  }
  return (
    connected.find((serial) => serial.startsWith("emulator-")) ??
    connected[0] ??
    null
  );
}

function androidRunAs(context, script, label, options = {}) {
  const output = tryExec(
    context.adb,
    [
      "-s",
      context.serial,
      "shell",
      `run-as ${shellQuote(appId())} sh -c ${shellQuote(script)}`,
    ],
    options.allowFailure ? { allowFailure: true } : undefined,
  );
  if (output === null && !options.allowFailure) {
    throw new Error(label);
  }
  return output;
}

function androidSdkRoot() {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;
  if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT;
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library/Android/sdk");
  }
  if (process.platform === "win32") {
    return path.join(home, "AppData/Local/Android/Sdk");
  }
  return path.join(home, "Android/Sdk");
}

function androidTool(relativePath, fallbackName) {
  return executablePath(
    path.join(androidSdkRoot(), relativePath),
    fallbackName,
  );
}

function appId() {
  // White-label builds install under a different bundle id than the eliza
  // package config. Allow targeting the installed app explicitly so the smoke can
  // validate whichever shell was actually built.
  if (process.env.ELIZA_SMOKE_APP_ID) return process.env.ELIZA_SMOKE_APP_ID;
  const config = fs.readFileSync(appConfigPath, "utf8");
  return config.match(/appId:\s*["']([^"']+)["']/)?.[1] ?? "app.eliza";
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function assertAndroidRenderedTranscript({ context, marker, expectedReply }) {
  const dumpPath = dumpAndroidUiHierarchy(context, "relaunch-persistence-post");
  const uiXml = readTextFileIfPresent(dumpPath);
  const visibleMarker = uiXml.includes(marker);
  const visibleReply =
    typeof expectedReply === "string" &&
    expectedReply.length > 0 &&
    uiXml.toLowerCase().includes(expectedReply.toLowerCase());
  if (!visibleMarker && !visibleReply) {
    const screenshot = takeAndroidScreenshot(
      context,
      "relaunch-persistence-render-missing",
    );
    throw new Error(
      `Relaunch-persistence server thread survived, but the Android UI hierarchy did not expose the marker or expected reply after relaunch. ` +
        `marker=${marker} expectedReply=${expectedReply} uiDump=${dumpPath ?? "<unavailable>"} screenshot=${screenshot ?? "<unavailable>"}`,
    );
  }
  return {
    uiHierarchyDump: dumpPath,
    visibleMarker,
    visibleReply,
  };
}

function assertInstalledIosRendererIsFresh(udid) {
  assertInstalledIosAppRendererFresh({
    udid,
    bundleId: appId(),
    repoRoot,
    log: (message) => console.log(`[local-chat-smoke] ${message}`),
  });
}

function assertObjectLike(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
  }
  return value;
}

function bootedIosUdid() {
  const listing = tryExec("xcrun", ["simctl", "list", "devices", "booted"]);
  if (!listing) return null;
  // Lines look like: "    iPhone 17 (5C9F2EAC-4F1D-…) (Booted)"
  const match = listing.match(/\(([0-9A-Fa-f-]{36})\)\s*\(Booted\)/);
  return match ? match[1] : null;
}

function cleanupAndroidAgentForwards(context, reason) {
  if (!context?.installed) return;
  const forwardedPorts = context.localAgentForward
    ? [context.localAgentForward]
    : [];
  for (const localPort of forwardedPorts) {
    removeAndroidForward(context, localPort);
  }
  context.localAgentForward = null;
  if (forwardedPorts.length > 0) {
    console.log(
      `[local-chat-smoke] Removed Android harness adb forward(s) for tcp:31337 (${reason}): ${forwardedPorts.join(", ")}.`,
    );
  }
}

function copyFileIfChanged(source, destination) {
  const sourceStats = fs.statSync(source);
  try {
    const destinationStats = fs.statSync(destination);
    if (
      destinationStats.isFile() &&
      destinationStats.size === sourceStats.size &&
      Math.floor(destinationStats.mtimeMs) >= Math.floor(sourceStats.mtimeMs)
    ) {
      return false;
    }
  } catch {
    // Copy below.
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.utimesSync(destination, sourceStats.atime, sourceStats.mtime);
  return true;
}

function describeAndroidSmokeModelSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes)) return "unknown size";
  return `${sizeBytes} bytes`;
}

function dumpAndroidUiHierarchy(context, label) {
  if (!context?.installed) return null;
  const outDir = path.join(os.tmpdir(), "eliza-android-ui-dumps");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xml`,
  );
  const remote = `/sdcard/${path.basename(outPath)}`;
  if (
    tryExec(context.adb, [
      "-s",
      context.serial,
      "shell",
      "uiautomator",
      "dump",
      remote,
    ]) === null
  ) {
    return null;
  }
  if (
    tryExec(context.adb, ["-s", context.serial, "pull", remote, outPath]) ===
    null
  ) {
    return null;
  }
  tryExec(context.adb, ["-s", context.serial, "shell", "rm", remote]);
  return outPath;
}

function executablePath(...candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function extractDoneEventFromSse(text) {
  const events = parseSseEvents(text);
  const errorEvent = events.find(
    (event) =>
      event.data &&
      typeof event.data === "object" &&
      event.data.type === "error",
  );
  if (errorEvent) {
    throw new Error(`Stream returned error event: ${errorEvent.dataText}`);
  }
  const done = events
    .map((event) => event.data)
    .find((data) => data && typeof data === "object" && data.type === "done");
  if (!done) {
    throw new Error(
      `Stream did not return a done event: ${text.slice(0, 500)}`,
    );
  }
  return done;
}

function findAndroidJobIdForPackage(context, id) {
  const dump = tryExec(context.adb, [
    "-s",
    context.serial,
    "shell",
    "dumpsys",
    "jobscheduler",
  ]);
  if (!dump) return null;
  const escapedId = id.replace(/[.+]/g, (c) => `\\${c}`);
  const re = new RegExp(`#u\\d+/(\\d+).*?${escapedId}`, "g");
  const ids = new Set();
  for (const match of dump.matchAll(re)) {
    ids.add(Number.parseInt(match[1], 10));
  }
  // Fall back: look for `JOB #u0/<n>` followed by the package name on a
  // subsequent line.
  if (ids.size === 0) {
    const lines = dump.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/JOB\s+#u\d+\/(\d+)/);
      if (!m) continue;
      const block = lines.slice(i, i + 8).join("\n");
      if (block.includes(id)) {
        ids.add(Number.parseInt(m[1], 10));
      }
    }
  }
  if (ids.size === 0) return null;
  // Prefer the smallest known job id (workmanager periodic worker is typically
  // registered with a stable id; if multiple match we return all separately).
  return Array.from(ids).sort((a, b) => a - b);
}

function forceStopConflictingAndroidAgents(context) {
  const id = appId();
  for (const packageName of [id, ...ANDROID_CONFLICTING_AGENT_PACKAGES]) {
    if (!packageName || packageName === id) {
      tryExec(context.adb, [
        "-s",
        context.serial,
        "shell",
        "am",
        "force-stop",
        id,
      ]);
      continue;
    }
    tryExec(context.adb, [
      "-s",
      context.serial,
      "shell",
      "am",
      "force-stop",
      packageName,
    ]);
  }
}

function iosAppDataContainer(udid, id) {
  return requireExec(
    "xcrun",
    ["simctl", "get_app_container", udid, id, "data"],
    `Failed to resolve iOS data container for ${id}.`,
  );
}

function iosAppSupportContainer(udid, id) {
  return path.join(
    iosAppDataContainer(udid, id),
    "Library",
    "Application Support",
    "Eliza",
  );
}

function isTransientFailure(error) {
  const message =
    error instanceof Error ? `${error.message} ${error.cause ?? ""}` : "";
  return TRANSIENT_ERROR_RE.test(message);
}

function launchIosSimulatorApp() {
  const udid = bootedIosUdid();
  if (!udid) {
    console.warn("[local-chat-smoke] No booted iOS simulator found.");
    return null;
  }

  const id = appId();
  clearIosSmokeDefaults({
    udid,
    bundleId: id,
    extraKeys: IOS_SMOKE_STATE_KEYS,
    log: (message) => console.log(`[local-chat-smoke] ${message}`),
  });
  let fullBunSmokeRequestedAtMs = null;
  const container = tryExec("xcrun", [
    "simctl",
    "get_app_container",
    udid,
    id,
    "app",
  ]);
  if (!container) {
    console.warn(
      `[local-chat-smoke] ${id} is not installed in the booted simulator (${udid}).`,
    );
    return { udid, installed: false };
  }

  if (iosSelectLocal || iosFullBunSmoke) {
    preseedIosLocalRuntime(udid, id);
  }
  if (iosFullBunSmoke) {
    fullBunSmokeRequestedAtMs = Date.now();
    stageIosFullBunSmokeModel(udid, id);
    preseedIosFullBunSmoke(udid, id);
  }

  console.log(
    `[local-chat-smoke] Launching ${id} in the booted simulator (${udid}).`,
  );
  tryExec("xcrun", ["simctl", "launch", udid, id]);
  if (!iosFullBunSmoke) {
    tryExec("xcrun", ["simctl", "openurl", udid, "elizaos://chat"]);
  }
  return { udid, installed: true, fullBunSmokeRequestedAtMs };
}

function localInferenceSummary({ hub, device, providers }) {
  return {
    hubActive: hub?.active ?? null,
    hubDownloads: Array.isArray(hub?.downloads) ? hub.downloads : [],
    device: device ?? null,
    providers: Array.isArray(providers?.providers) ? providers.providers : [],
  };
}

function parseSseEvents(text) {
  const events = [];
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    const dataLines = [];
    let event = null;
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const sep = line.indexOf(":");
      const field = sep >= 0 ? line.slice(0, sep) : line;
      let value = sep >= 0 ? line.slice(sep + 1) : "";
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") {
        event = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }
    if (dataLines.length === 0) continue;
    const dataText = dataLines.join("\n");
    let data = dataText;
    try {
      data = JSON.parse(dataText);
    } catch {
      // Keep raw SSE payloads for diagnostics.
    }
    events.push({ event, data, dataText });
  }
  return events;
}

function preseedAndroidLocalRuntime(context) {
  const activeServer = JSON.stringify({
    id: "local:android",
    kind: "remote",
    label: "On-device agent",
    apiBase: ANDROID_LOCAL_AGENT_IPC_BASE,
  });
  writeAndroidCapacitorPreferences(context, {
    "eliza:mobile-runtime-mode": "local",
    "eliza:first-run-complete": "1",
    "elizaos:active-server": activeServer,
  });
  console.log(
    `[local-chat-smoke] Pre-seeded Android Local runtime preferences for ${appId()}.`,
  );
}

function preseedIosFullBunSmoke(udid, id) {
  deleteIosDefaultsKey({
    udid,
    bundleId: id,
    key: IOS_FULL_BUN_SMOKE_RESULT_KEY,
  });
  deleteIosDefaultsKey({
    udid,
    bundleId: id,
    key: IOS_FULL_BUN_PREWARM_RESULT_KEY,
  });
  writeIosDefaultsString({
    udid,
    bundleId: id,
    key: IOS_FULL_BUN_SMOKE_RESULT_KEY,
    value: JSON.stringify({
      ok: false,
      phase: "requested",
      updatedAt: new Date().toISOString(),
    }),
  });
  writeIosDefaultsString({
    udid,
    bundleId: id,
    key: IOS_FULL_BUN_SMOKE_REQUEST_KEY,
    value: "1",
  });
  flushIosPreferencesCache(udid);
  const diagnostics = readIosFullBunSmokeDiagnostics(udid, id);
  const requestReadback =
    diagnostics.keys[IOS_FULL_BUN_SMOKE_REQUEST_KEY]?.defaultsValue ??
    diagnostics.keys[IOS_FULL_BUN_SMOKE_REQUEST_KEY]?.plistValue;
  const resultReadback =
    diagnostics.keys[IOS_FULL_BUN_SMOKE_RESULT_KEY]?.defaultsValue ??
    diagnostics.keys[IOS_FULL_BUN_SMOKE_RESULT_KEY]?.plistValue;
  if (requestReadback !== "1" || !resultReadback) {
    throw new Error(
      `iOS full Bun smoke preseed was not readable from native defaults: ${JSON.stringify(diagnostics)}`,
    );
  }
  console.log(
    `[local-chat-smoke] Requested in-app iOS full Bun backend smoke for ${id}; native defaults readback succeeded.`,
  );
}

function preseedIosLocalRuntime(udid, id) {
  const activeServer = JSON.stringify({
    id: "local:mobile",
    kind: "remote",
    label: "On-device agent",
    apiBase: IOS_LOCAL_AGENT_IPC_BASE,
  });

  tryExec("xcrun", ["simctl", "terminate", udid, id], { allowFailure: true });
  writeIosDefaultsString({
    udid,
    bundleId: id,
    key: "eliza:mobile-runtime-mode",
    value: "local",
  });
  writeIosDefaultsString({
    udid,
    bundleId: id,
    key: "eliza:first-run-complete",
    value: "1",
  });
  writeIosDefaultsString({
    udid,
    bundleId: id,
    key: "elizaos:active-server",
    value: activeServer,
  });
  flushIosPreferencesCache(udid);
  console.log(
    `[local-chat-smoke] Pre-seeded iOS Local runtime preferences for ${id}.`,
  );
}

function printHelp() {
  console.log(`Usage: node packages/app/scripts/mobile-local-chat-smoke.mjs [options]

Options:
  --platform ios|android|both       Simulator platform to launch (default: ios)
  --require-installed              Fail when the selected app/simulator is unavailable
  --live                           Exercise the app-core local-agent HTTP API on Android
  --api-base URL                   Exercise an already-reachable app-core HTTP API
  --start-host-agent               Start the deterministic host app-core API when --api-base is omitted
  --host-agent-port PORT           Port for --start-host-agent (default: 31338, or a free port if busy)
  --auth-token TOKEN               Bearer token for protected app-core API routes
  --ios-select-local               Pre-seed iOS first-run/runtime state for Local mode before launch
  --ios-full-bun-smoke             Run a WebView-executed full Bun backend smoke in the iOS app
  --android-select-local           Tap through Android first-run Local runtime selection
  --android-stage-smoke-model      Stage the smallest active Eliza-1 GGUF into Android app data
  --android-background             Background Android, force-fire the WorkManager job, and poll /api/health
  --ios-background                 Background iOS, fire a BGTaskScheduler task via LLDB, and poll /api/health
  --ios-background-task-id ID      iOS BGTask identifier to simulate (default: ai.eliza.tasks.refresh)
  --relaunch-persistence           After the turn, send a unique marker through the live stream path, force-stop +
                                   relaunch the app, and assert server truth plus rendered transcript proof.
                                   Android only:
                                   the iOS on-device agent is IPC-only, so its relaunch check needs the Preferences
                                   handshake / XCUITest path (#13689).
  --help                           Print this help

Notes:
  --live validates the running app-core/local-agent API. It is not a remote
  service test. The chat step requires local-inference readiness and a completed
  streamed model reply from the local Android agent.
  ANDROID_SERIAL selects a specific Android device or emulator when set.`);
}

function readAndroidLocalAgentToken(context) {
  if (!context?.installed) return null;
  return tryExec(
    context.adb,
    [
      "-s",
      context.serial,
      "shell",
      "run-as",
      appId(),
      "cat",
      "files/auth/local-agent-token",
    ],
    { allowFailure: true },
  );
}

function readIosFullBunSmokeDiagnostics(udid, domain) {
  const dataContainer = tryExec(
    "xcrun",
    ["simctl", "get_app_container", udid, domain, "data"],
    { allowFailure: true },
  );
  const plist = dataContainer
    ? path.join(dataContainer, "Library", "Preferences", `${domain}.plist`)
    : null;
  let plistData = null;
  if (plist && fs.existsSync(plist)) {
    const json = tryExec("plutil", ["-convert", "json", "-o", "-", plist], {
      allowFailure: true,
    });
    if (json) {
      try {
        plistData = JSON.parse(json);
      } catch {
        // error-policy:J3 malformed preference plists remain explicitly unreadable.
        plistData = null;
      }
    }
  }
  const keys = [
    IOS_FULL_BUN_SMOKE_REQUEST_KEY,
    IOS_FULL_BUN_SMOKE_RESULT_KEY,
    IOS_FULL_BUN_PREWARM_RESULT_KEY,
  ].map((key) => {
    const nativeKeys = preferenceNativeKeys(key);
    const plistValue = nativeKeys
      .map((nativeKey) => plistData?.[nativeKey])
      .find((value) => typeof value === "string");
    return [
      key,
      {
        nativeKeys,
        plistValue: typeof plistValue === "string" ? plistValue : null,
        defaultsValue: readIosDefaultsString({
          udid,
          bundleId: domain,
          key,
        }),
      },
    ];
  });
  return {
    udid,
    domain,
    dataContainer: dataContainer || null,
    plist,
    plistExists: Boolean(plist && fs.existsSync(plist)),
    keys: Object.fromEntries(keys),
  };
}

function readLastWakeFiredAtMs(health) {
  if (!health || typeof health !== "object") return null;
  const raw = health.lastWakeFiredAt;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function readStartupAttempt(health) {
  const attempt = health?.startup?.attempt;
  return typeof attempt === "number" && Number.isFinite(attempt)
    ? attempt
    : null;
}

function readTextFileIfPresent(filePath) {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function relaunchAndroidApp(context) {
  const id = appId();
  requireExec(
    context.adb,
    ["-s", context.serial, "shell", "am", "force-stop", id],
    `Failed to force-stop ${id} on ${context.serial}.`,
  );
  requireExec(
    context.adb,
    ["-s", context.serial, "shell", "am", "start", "-n", `${id}/.MainActivity`],
    `Failed to relaunch ${id} on ${context.serial}.`,
  );
  tryExec(context.adb, [
    "-s",
    context.serial,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "elizaos://chat",
    id,
  ]);
}

function removeAndroidForward(context, localPort) {
  tryExec(
    context.adb,
    ["-s", context.serial, "forward", "--remove", localPort],
    { allowFailure: true },
  );
}

function requireExec(command, args, label) {
  const output = tryExec(command, args);
  if (output === null) {
    throw new Error(label ?? `${command} ${args.join(" ")} failed`);
  }
  return output;
}

function requireUsableFullTurnReply(done, rawStreamText) {
  const doneObject = assertObjectLike(done, "Stream done event");
  if (doneObject.failureKind) {
    throw new Error(
      `Full-turn smoke returned failureKind=${doneObject.failureKind}: ${JSON.stringify(doneObject)}`,
    );
  }
  if (doneObject.noResponseReason) {
    throw new Error(
      `Full-turn smoke returned noResponseReason=${doneObject.noResponseReason}`,
    );
  }
  const reply = String(doneObject.fullText ?? doneObject.text ?? "").trim();
  if (!reply) {
    throw new Error(`Full-turn smoke returned empty reply: ${rawStreamText}`);
  }
  if (ANDROID_FULL_TURN_FAILURE_RE.test(reply)) {
    throw new Error(`Full-turn smoke returned unusable reply: ${reply}`);
  }
  const normalizedReply = reply
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (normalizedReply !== ANDROID_FULL_TURN_EXPECTED_REPLY) {
    throw new Error(
      `Full-turn smoke returned the wrong reply: ${reply} (expected ${ANDROID_FULL_TURN_EXPECTED_REPLY})`,
    );
  }
  return reply;
}

function run(command, args, options = {}) {
  const invocation = resolveSmokeCommand(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stageIosFullBunSmokeModel(udid, id) {
  const source =
    process.env.ELIZA_IOS_FULL_BUN_SMOKE_MODEL_PATH ??
    path.join(
      os.homedir(),
      ".eliza",
      "local-inference",
      IOS_FULL_BUN_SMOKE_MODEL_RELATIVE_PATH,
    );
  if (!fs.existsSync(source)) {
    throw new Error(
      `iOS full-Bun smoke model is missing: ${source}. Set ELIZA_IOS_FULL_BUN_SMOKE_MODEL_PATH to an Eliza-1 GGUF file.`,
    );
  }
  const sourceStats = fs.statSync(source);
  if (!sourceStats.isFile()) {
    throw new Error(`iOS full-Bun smoke model is not a file: ${source}`);
  }

  const localInferenceRoot = path.join(
    iosAppSupportContainer(udid, id),
    "local-inference",
  );
  const modelPath = path.join(
    localInferenceRoot,
    IOS_FULL_BUN_SMOKE_MODEL_RELATIVE_PATH,
  );
  const copied = copyFileIfChanged(source, modelPath);
  const now = new Date().toISOString();
  const registry = {
    models: [
      {
        id: IOS_FULL_BUN_SMOKE_MODEL_ID,
        displayName: "eliza-1-2B",
        path: modelPath,
        sizeBytes: sourceStats.size,
        installedAt: now,
        lastUsedAt: now,
        source: "ios-full-bun-smoke",
        bundleVerifiedAt: now,
        contextSize: IOS_FULL_BUN_SMOKE_CONTEXT_SIZE,
      },
    ],
  };
  const assignments = {
    assignments: Object.fromEntries(
      [
        "TEXT_NANO",
        "TEXT_SMALL",
        "TEXT_MEDIUM",
        "TEXT_LARGE",
        "RESPONSE_HANDLER",
        "ACTION_PLANNER",
        "TEXT_COMPLETION",
      ].map((slot) => [slot, IOS_FULL_BUN_SMOKE_MODEL_ID]),
    ),
  };
  fs.mkdirSync(localInferenceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(localInferenceRoot, "registry.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(localInferenceRoot, "assignments.json"),
    `${JSON.stringify(assignments, null, 2)}\n`,
  );
  console.log(
    `[local-chat-smoke] ${copied ? "Staged" : "Reused"} iOS full-Bun smoke model ${IOS_FULL_BUN_SMOKE_MODEL_ID}: ${modelPath}`,
  );
}

function takeAndroidScreenshot(context, label) {
  if (!context?.installed) return null;
  const outDir = path.join(os.tmpdir(), "eliza-android-bg-smoke");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  const remote = `/sdcard/${path.basename(outPath)}`;
  if (
    tryExec(context.adb, [
      "-s",
      context.serial,
      "shell",
      "screencap",
      "-p",
      remote,
    ]) === null
  ) {
    return null;
  }
  if (
    tryExec(context.adb, ["-s", context.serial, "pull", remote, outPath]) ===
    null
  ) {
    return null;
  }
  tryExec(context.adb, ["-s", context.serial, "shell", "rm", remote], {
    allowFailure: true,
  });
  return outPath;
}

function takeIosScreenshot(udid, label) {
  if (!udid) return null;
  const outDir = path.join(os.tmpdir(), "eliza-ios-bg-smoke");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  const ok = tryExec("xcrun", ["simctl", "io", udid, "screenshot", outPath]);
  if (ok === null) return null;
  return outPath;
}

function tryExec(command, args, options = {}) {
  try {
    const invocation = resolveSmokeCommand(command, args);
    return execFileSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (requireInstalled && !options.allowFailure) {
      throw error;
    }
    return null;
  }
}

function writeAndroidCapacitorPreferences(context, entries) {
  const xml = [
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
    "<map>",
    ...Object.entries(entries).map(
      ([key, value]) =>
        `    <string name="${xmlEscape(key)}">${xmlEscape(value)}</string>`,
    ),
    "</map>",
    "",
  ].join("\n");
  const encoded = Buffer.from(xml, "utf8").toString("base64");
  const script = [
    "mkdir -p shared_prefs",
    `(printf %s ${encoded} | base64 -d > shared_prefs/CapacitorStorage.xml) || (printf %s ${encoded} | toybox base64 -d > shared_prefs/CapacitorStorage.xml)`,
    "chmod 660 shared_prefs/CapacitorStorage.xml",
  ].join(" && ");
  requireExec(
    context.adb,
    [
      "-s",
      context.serial,
      "shell",
      `run-as ${shellQuote(appId())} sh -c ${shellQuote(script)}`,
    ],
    "Failed to pre-seed Android Capacitor Preferences.",
  );
}

function writeAndroidJsonFile(context, targetDir, fileName, value, label) {
  const encoded = Buffer.from(
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  ).toString("base64");
  const target = `${targetDir}/${fileName}`;
  const script = [
    `mkdir -p ${shellQuote(targetDir)}`,
    `(printf %s ${encoded} | base64 -d > ${shellQuote(target)}) || (printf %s ${encoded} | toybox base64 -d > ${shellQuote(target)})`,
    `chmod 600 ${shellQuote(target)}`,
  ].join(" && ");
  androidRunAs(context, script, label);
}

function writeAndroidLocalInferenceRegistry(context, localInferenceDir) {
  // `localInferenceDir` already starts with `files/` (it is run-as-home
  // relative), so the on-device absolute path is the app home + that dir — do
  // NOT prepend another `files/` (that produced a dead `files/files/...` path
  // whose fs.stat failed, so the provider reported "No Eliza-1 bundle installed").
  const absoluteModelPath = `/data/data/${appId()}/${localInferenceDir}/models/${ANDROID_SMOKE_MODEL_FILE}`;
  const now = new Date().toISOString();
  writeAndroidJsonFile(
    context,
    localInferenceDir,
    "registry.json",
    {
      models: [
        {
          id: ANDROID_SMOKE_MODEL_ID,
          displayName: "eliza-1-2B",
          path: absoluteModelPath,
          sizeBytes: ANDROID_SMOKE_MODEL_SIZE_BYTES,
          installedAt: now,
          lastUsedAt: now,
          source: "android-local-chat-smoke",
          bundleVerifiedAt: now,
        },
      ],
    },
    "Failed to write Android local-inference registry.",
  );
  writeAndroidJsonFile(
    context,
    localInferenceDir,
    "assignments.json",
    {
      assignments: Object.fromEntries(
        [
          "TEXT_SMALL",
          "TEXT_LARGE",
          "RESPONSE_HANDLER",
          "ACTION_PLANNER",
          "TEXT_COMPLETION",
        ].map((slot) => [slot, ANDROID_SMOKE_MODEL_ID]),
      ),
    },
    "Failed to write Android local-inference assignments.",
  );
  console.log(
    `[local-chat-smoke] Staged Android local-inference registry + assignments for ${ANDROID_SMOKE_MODEL_ID}: ${absoluteModelPath}`,
  );
}

function writeAndroidSmokeModelManifest(context, targetDir) {
  writeAndroidJsonFile(
    context,
    targetDir,
    "manifest.json",
    {
      models: [
        {
          id: ANDROID_SMOKE_MODEL_ID,
          role: "chat",
          filename: ANDROID_SMOKE_MODEL_FILE,
          ggufFile: ANDROID_SMOKE_MODEL_FILE,
          sha256: ANDROID_SMOKE_MODEL_SHA256,
          sizeBytes: ANDROID_SMOKE_MODEL_SIZE_BYTES,
          contextSize: ANDROID_SMOKE_MODEL_CONTEXT_SIZE,
          useGpu: false,
          maxThreads: 2,
        },
      ],
    },
    "Failed to write Android smoke model manifest.",
  );
}

function writeIosFullBunSmokeResultEvidence(
  result,
  evidenceDirectory = process.env.ELIZA_IOS_FULL_BUN_SMOKE_EVIDENCE_DIR,
) {
  const directory = evidenceDirectory?.trim();
  if (!directory) return null;
  fs.mkdirSync(directory, { recursive: true });
  const outPath = path.join(directory, "result.json");
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  return outPath;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

