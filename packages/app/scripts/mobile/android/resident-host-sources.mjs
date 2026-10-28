/**
 * Stages the resident runtime's Android classes into a consumer host's own package.
 *
 * A consumer host compiles these classes in its application package so R,
 * BuildConfig and its installed component names (services, WorkManager workers)
 * keep that host's identity. The rewrite anchors are owned here, next to the
 * sources they match, and every anchor fails closed when the source changes.
 * The consumer supplies only data: package, socket namespaces, notification
 * resources, optional environment and lifecycle hooks, the optional shared
 * notification classes it compiles, and the shared plugin helper sources it
 * compiles beside them.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const RESIDENT_ROOT =
  "packages/app/platforms/android/app/src/main/java/ai/elizaos/app";
const UPSTREAM_PACKAGE = "ai.elizaos.app";

/** Resident runtime classes a consumer host compiles in its own package. */
export const RESIDENT_HOST_CLASSES = Object.freeze([
  "SecureStoreFrameInput",
  "AgentSecureStore",
  "DeviceRamTierPolicy",
  "AndroidBunTarget",
  "ElizaAgentService",
  "IpcStartupRecovery",
  "WorkflowSurvivorInventory",
  "ElizaAgentWatchdogPolicy",
  "ElizaAssetExtractionPolicy",
  "ElizaBionicInferenceServer",
  "NativeSourceHost",
  "ElizaStartupTrace",
  "ElizaWorkScheduler",
  "ElizaTasksWorker",
  "InferenceMemoryPolicy",
  "RuntimeInstallationIdentity",
  "BionicDecodeLoop",
  "BionicAsrStreams",
  "ElizaAsrNativeEnv",
  "ElizaVoiceNative",
  "BgeEmbeddingSession",
]);

/**
 * Shared native notification classes a host may also select. Their ids, wire
 * format and routing stay upstream's; a host that selects them compiles them in
 * its own package so its notification icon and channel labels apply.
 */
export const RESIDENT_NOTIFICATION_CLASSES = Object.freeze([
  "NativeNotificationInbox",
  "NativeNotificationWire",
  "NativeNotificationRoute",
  "NativeNotificationChannels",
  "NativeNotificationProjector",
]);
const SELECTABLE_CLASSES = Object.freeze([
  ...RESIDENT_HOST_CLASSES,
  ...RESIDENT_NOTIFICATION_CLASSES,
]);

/**
 * Reviewed shared helpers a host may compile beside the resident classes, keeping
 * their own packages. `host-build-config` sources read the host's BuildConfig and
 * are rewritten for it; every other selected helper is staged verbatim (see
 * residentHelperKind), so adopting a new shared helper needs no edit here.
 */
export const RESIDENT_HOST_HELPERS = Object.freeze({
  "plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/runtime/NativeProcessSupervisor.java":
    "verbatim",
  "plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/runtime/NativeProviderAdmission.java":
    "verbatim",
  ...Object.fromEntries(
    [
      ["ChromiumBrowserIdentity", "verbatim"],
      ["ChromiumBrowserConnection", "host-build-config"],
      ["BrowserWebOrigin", "verbatim"],
      ["BrowserDownloadPolicy", "verbatim"],
      ["BrowserSessionPolicy", "verbatim"],
      ["BrowserSitePermissions", "verbatim"],
      ["BrowserExternalLinkPolicy", "verbatim"],
      ["BrowserAutofillEligibility", "verbatim"],
    ].map(([name, kind]) => [
      `plugins/plugin-native-browser-surface/android/src/main/java/ai/eliza/plugins/browsersurface/${name}.java`,
      kind,
    ]),
  ),
});

/** Runtime notification text in ElizaAgentService, by semantic key: anchor and occurrences. */
export const RESIDENT_NOTIFICATION_STRINGS = Object.freeze([
  ["channelName", '"Eliza Agent"', 1],
  ["channelDescription", '"Local Eliza agent runtime status"', 1],
  ["title", '"Eliza agent"', 2],
  ["running", '"Eliza agent · Running"', 1],
  ["starting", '"Eliza agent · Starting"', 1],
  ["stopped", '"Eliza agent · Stopped"', 1],
  ["assetError", '"Eliza agent · Asset error"', 1],
  ["missingFiles", '"Eliza agent · Missing files"', 1],
  ["spawnFailed", '"Eliza agent · Spawn failed"', 1],
  ["restartBlocked", '"Eliza agent · Restart blocked"', 1],
  ["runningDetail", '"On-device agent ready"', 1],
]);
/** NativeNotificationChannels labels by channel: anchor and the suffix after the host label. */
const CHANNEL_LABELS = Object.freeze([
  ['name = "Eliza alerts"', " alerts"],
  ['name = "Eliza"', ""],
  ['name = "Eliza updates"', " updates"],
  ['name = "Eliza background"', " background"],
]);
const PROJECTOR_ICON = "android.R.drawable.ic_dialog_info";
// ElizaAgentService publishes a rotated local-agent root here, once.
const ROOT_PUBLICATION_ANCHOR = "            currentLocalAgentToken = token;";
// Every path that reaches the running state: start, detached adoption and the ready probes.
const READY_ANCHOR = 'currentStatus = "running";';
const READY_OCCURRENCES = 4;
const ENVIRONMENT_ANCHOR =
  'agentEnv.put("ELIZA_LOCAL_AGENT_SOCKET_PATH",privateSocketPath);';
const SOCKET_ANCHORS = Object.freeze({
  agent: '"eliza_local_agent_v1"',
  inference: '"eliza_bionic_infer_v1"',
});

export class ResidentHostSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResidentHostSourceError";
  }
}
const requireValue = (condition, message) => {
  if (!condition) throw new ResidentHostSourceError(message);
};
const javaPackage = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const javaIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const resourceName = /^[a-z][a-z0-9_]*$/;
const socketName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const channelLabel = /^[A-Za-z0-9][A-Za-z0-9 ]{0,31}$/;
// A shared native plugin's main Java source; the capture is its package path.
const HELPER_SOURCE =
  /^plugins\/plugin-native-[a-z0-9-]+\/android\/src\/main\/java\/((?:[a-z][a-z0-9_]*\/)+[A-Z][A-Za-z0-9_]*\.java)$/;

/**
 * How a selected helper is staged: a reviewed rewrite from RESIDENT_HOST_HELPERS,
 * otherwise verbatim. Only shared native plugin main Java sources are admitted.
 */
export function residentHelperKind(relative) {
  requireValue(
    typeof relative === "string" && HELPER_SOURCE.test(relative),
    `Resident helpers must be shared native plugin Java sources: ${relative}`,
  );
  return Object.hasOwn(RESIDENT_HOST_HELPERS, relative)
    ? RESIDENT_HOST_HELPERS[relative]
    : "verbatim";
}
function occurrences(text, anchor) {
  return text.split(anchor).length - 1;
}
function replaceCounted(text, anchor, replacement, expected, message) {
  requireValue(occurrences(text, anchor) === expected, message);
  return text.replaceAll(anchor, () => replacement);
}

/** Validate a host identity mapping; returns a normalized copy. */
export function residentHostIdentity(identity) {
  requireValue(
    identity && typeof identity === "object",
    "A resident host identity is required",
  );
  const {
    packageName,
    sockets,
    notification,
    environmentHook,
    lifecycleHooks,
  } = identity;
  requireValue(
    javaPackage.test(packageName ?? "") && packageName !== UPSTREAM_PACKAGE,
    "Resident host package must be the consumer application package",
  );
  requireValue(
    sockets &&
      ["agent", "inference", "secureStore"].every((key) =>
        socketName.test(sockets[key] ?? ""),
      ) &&
      new Set([sockets.agent, sockets.inference, sockets.secureStore]).size ===
        3,
    "Resident host sockets need three distinct abstract names",
  );
  requireValue(
    notification && resourceName.test(notification.smallIcon ?? ""),
    "Resident host notifications need a drawable small icon",
  );
  requireValue(
    notification.color === undefined ||
      notification.color === null ||
      /^0x[0-9a-f]{8}$/.test(notification.color),
    "Notification color must be a 0xAARRGGBB literal",
  );
  const strings = notification.strings ?? null;
  if (strings !== null) {
    const keys = RESIDENT_NOTIFICATION_STRINGS.map(([key]) => key);
    requireValue(
      Object.keys(strings).length === keys.length &&
        keys.every((key) => resourceName.test(strings[key] ?? "")),
      "Notification strings must name a string resource for every runtime notification",
    );
  }
  requireValue(
    notification.channelLabel === undefined ||
      notification.channelLabel === null ||
      (typeof notification.channelLabel === "string" &&
        channelLabel.test(notification.channelLabel) &&
        notification.channelLabel === notification.channelLabel.trim()),
    "Notification channel label must be a short plain name",
  );
  const hooks = {};
  if (lifecycleHooks !== undefined && lifecycleHooks !== null) {
    requireValue(
      typeof lifecycleHooks === "object" &&
        !Array.isArray(lifecycleHooks) &&
        Object.keys(lifecycleHooks).every((key) =>
          ["rootPublication", "ready"].includes(key),
        ),
      "Lifecycle hooks are rootPublication and ready",
    );
    for (const [key, hook] of Object.entries(lifecycleHooks)) {
      requireValue(
        hook &&
          javaIdentifier.test(hook.className ?? "") &&
          javaIdentifier.test(hook.method ?? ""),
        `Lifecycle hook ${key} needs a host class and static method`,
      );
      hooks[key] = { className: hook.className, method: hook.method };
    }
  }
  if (environmentHook !== undefined && environmentHook !== null)
    requireValue(
      javaIdentifier.test(environmentHook.className ?? "") &&
        javaIdentifier.test(environmentHook.method ?? "") &&
        /^[a-z][a-z0-9-]{0,63}$/.test(environmentHook.unavailableStatus ?? ""),
      "Environment hook needs a host class, static method and unavailable status",
    );
  return {
    packageName,
    sockets: { ...sockets },
    notification: {
      smallIcon: notification.smallIcon,
      color: notification.color ?? null,
      strings: strings && { ...strings },
      channelLabel: notification.channelLabel ?? null,
    },
    environmentHook: environmentHook ? { ...environmentHook } : null,
    lifecycleHooks: hooks,
  };
}

/** Rewrite one resident class for a host identity. Pure; throws when an anchor changed. */
export function rewriteResidentClass(name, source, identity) {
  requireValue(
    SELECTABLE_CLASSES.includes(name),
    `Unknown resident class ${name}`,
  );
  const host = residentHostIdentity(identity);
  // Function replacements: no `$` pattern in a value is ever interpreted.
  let value = source
    .replaceAll(UPSTREAM_PACKAGE, () => host.packageName)
    .replaceAll(
      "R.mipmap.ic_launcher",
      () => `R.drawable.${host.notification.smallIcon}`,
    )
    .replaceAll(SOCKET_ANCHORS.agent, () => JSON.stringify(host.sockets.agent))
    .replaceAll(SOCKET_ANCHORS.inference, () =>
      JSON.stringify(host.sockets.inference),
    );
  if (name === "NativeNotificationProjector")
    return replaceCounted(
      value,
      PROJECTOR_ICON,
      `R.drawable.${host.notification.smallIcon}`,
      1,
      "Review changed shared notification builders",
    );
  if (name === "NativeNotificationChannels") {
    if (host.notification.channelLabel)
      for (const [anchor, suffix] of CHANNEL_LABELS)
        value = replaceCounted(
          value,
          anchor,
          `name = ${JSON.stringify(host.notification.channelLabel + suffix)}`,
          1,
          `Review changed shared notification channels: ${anchor}`,
        );
    return value;
  }
  if (name !== "ElizaAgentService") return value;
  // Product presentation over the canonical runtime: the state machine,
  // notification timing, Stop action and binder-free bootstrap stay unchanged.
  if (host.notification.strings)
    for (const [key, anchor, expected] of RESIDENT_NOTIFICATION_STRINGS)
      value = replaceCounted(
        value,
        anchor,
        `getString(R.string.${host.notification.strings[key]})`,
        expected,
        `Review changed runtime notification presentation: ${anchor}`,
      );
  if (host.notification.color) {
    const icon = `.setSmallIcon(R.drawable.${host.notification.smallIcon})`;
    value = replaceCounted(
      value,
      icon,
      `${icon}\n            .setColor(${host.notification.color})`,
      2,
      "Review changed runtime notification builders",
    );
  }
  const { rootPublication, ready } = host.lifecycleHooks;
  // The host publishes a rotated root through its own guard (for example to
  // suspend a previous transport atomically) instead of a bare assignment.
  if (rootPublication)
    value = replaceCounted(
      value,
      ROOT_PUBLICATION_ANCHOR,
      `            ${rootPublication.className}.${rootPublication.method}(() -> { ${ROOT_PUBLICATION_ANCHOR.trim()} });`,
      1,
      "Review changed resident root publication",
    );
  // The host learns of readiness on every running path, never before readiness.
  if (ready)
    value = replaceCounted(
      value,
      READY_ANCHOR,
      `${READY_ANCHOR} ${ready.className}.${ready.method}(getApplicationContext());`,
      READY_OCCURRENCES,
      "Review changed resident ready lifecycle",
    );
  requireValue(
    occurrences(value, ENVIRONMENT_ANCHOR) === 1,
    "Native runtime environment insertion point changed",
  );
  const environment = [
    `agentEnv.put("ELIZA_ANDROID_SECURE_STORE_SOCKET", ${JSON.stringify(host.sockets.secureStore)});`,
  ];
  if (host.environmentHook) {
    const { className, method, unavailableStatus } = host.environmentHook;
    environment.push(
      `try { ${className}.${method}(this, agentEnv); } catch (java.io.IOException unavailable) { currentStatus = ${JSON.stringify(unavailableStatus)}; updateNotification(); return; }`,
    );
  }
  return value.replace(ENVIRONMENT_ANCHOR, () =>
    [ENVIRONMENT_ANCHOR, ...environment].join("\n            "),
  );
}

/** Rewrite one helper source for a host identity. */
function rewriteResidentHelper(relative, source, packageName) {
  const kind = residentHelperKind(relative);
  if (kind === "verbatim") return source;
  requireValue(javaPackage.test(packageName ?? ""), "Invalid host package");
  const declaration = /^package ([a-z][a-z0-9_.]*);$/m.exec(source);
  requireValue(declaration, `Review changed helper package: ${relative}`);
  return source.replace(
    declaration[0],
    () => `${declaration[0]}\nimport ${packageName}.BuildConfig;`,
  );
}

function readSource(sourceRoot, relative) {
  const file = path.join(sourceRoot, relative);
  for (let cursor = file; cursor !== sourceRoot; cursor = path.dirname(cursor))
    requireValue(
      !fs.lstatSync(cursor).isSymbolicLink(),
      `Resident source path contains a symlink: ${relative}`,
    );
  requireValue(
    fs.statSync(file).isFile(),
    `Missing resident source ${relative}`,
  );
  return fs.readFileSync(file, "utf8");
}

/**
 * Write rewritten resident classes and selected helpers under `output`, which
 * must be absent or empty. `sourceRoot` is an already-authenticated checkout of
 * the upstream commit the host packages. Returns provenance rows in write order.
 */
export function stageResidentHostSources({
  sourceRoot,
  output,
  identity,
  classes = RESIDENT_HOST_CLASSES,
  helpers = [],
}) {
  const host = residentHostIdentity(identity);
  sourceRoot = fs.realpathSync(sourceRoot);
  output = path.resolve(output);
  requireValue(
    !output.startsWith(sourceRoot + path.sep),
    "Resident host sources must be staged outside the upstream source",
  );
  const existing = fs.lstatSync(output, { throwIfNoEntry: false });
  requireValue(
    !existing ||
      (existing.isDirectory() &&
        !existing.isSymbolicLink() &&
        fs.readdirSync(output).length === 0),
    "Resident host source output must be a new directory",
  );
  requireValue(
    Array.isArray(classes) &&
      new Set(classes).size === classes.length &&
      classes.every((name) => SELECTABLE_CLASSES.includes(name)) &&
      classes.includes("ElizaAgentService"),
    "Resident classes must be distinct known classes including ElizaAgentService",
  );
  requireValue(
    Array.isArray(helpers) && new Set(helpers).size === helpers.length,
    "Resident helpers must be distinct",
  );
  for (const relative of helpers) residentHelperKind(relative);
  const rows = [];
  const write = (relative, target, input, value) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value, { flag: "wx" });
    rows.push({
      path: relative,
      generatedFile: target,
      sourceSha256: sha256(input),
      generatedSha256: sha256(value),
    });
  };
  const packageDirectory = path.join(output, ...host.packageName.split("."));
  for (const name of classes) {
    const relative = `${RESIDENT_ROOT}/${name}.java`;
    const input = readSource(sourceRoot, relative);
    write(
      relative,
      path.join(packageDirectory, `${name}.java`),
      input,
      rewriteResidentClass(name, input, host),
    );
  }
  for (const relative of helpers) {
    const input = readSource(sourceRoot, relative);
    write(
      relative,
      path.join(output, HELPER_SOURCE.exec(relative)[1]),
      input,
      rewriteResidentHelper(relative, input, host.packageName),
    );
  }
  return { packageName: host.packageName, files: rows };
}
