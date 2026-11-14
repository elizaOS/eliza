import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSensePermissions } from "./pixel10a-product.ts";
import { senseSystemuiPatch } from "./sense-systemui.mjs";

const systemuiSource = fileURLToPath(
  new URL("../../android/sense/systemui/chip/", import.meta.url),
);
export const listenerPackage = (appId) => `${appId}.sense`;

/** Permissions the listener may request that need no image grant (normal or user-granted runtime). */
export const UNPRIVILEGED = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "android.permission.HIDE_OVERLAY_WINDOWS",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.RECORD_AUDIO",
];
/** Never requested by, or granted to, the listener. */
export const FORBIDDEN = [
  "android.permission.INTERNET",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.CAPTURE_AUDIO_OUTPUT",
  "android.permission.CAPTURE_MEDIA_OUTPUT",
  "android.permission.CAPTURE_VOICE_COMMUNICATION_OUTPUT",
  "android.permission.BYPASS_CONCURRENT_RECORD_AUDIO_RESTRICTION",
  "android.permission.EXEMPT_FROM_AUDIO_RECORD_RESTRICTIONS",
  "android.permission.RECORD_BACKGROUND_AUDIO",
  "android.permission.MODIFY_AUDIO_ROUTING",
  "android.permission.READ_PHONE_STATE",
];

const withoutComments = (text) => String(text).replace(/<!--[\s\S]*?-->/g, "");

/** Permission names in a privapp-permissions file for one package. */
export function privappPermissions(xml, packageName) {
  const body = withoutComments(xml);
  const blocks = [
    ...body.matchAll(
      /<privapp-permissions\s+package="([^"]+)"\s*>([\s\S]*?)<\/privapp-permissions>/g,
    ),
  ];
  if (blocks.length !== 1 || blocks[0][1] !== packageName)
    throw new Error(`The privapp allowlist must name exactly ${packageName}`);
  if (/<deny-permission/.test(blocks[0][2]))
    throw new Error("The listener allowlist must not use deny-permission");
  return [...blocks[0][2].matchAll(/<permission\s+name="([^"]+)"\s*\/>/g)]
    .map((match) => match[1])
    .sort();
}

/** Parses `aapt dump permissions`: package name and requested permissions. */
export function apkPermissions(dump) {
  const packageName = /^package: (\S+)$/m.exec(dump)?.[1] ?? null;
  const requested = [...dump.matchAll(/^uses-permission: name='([^']+)'/gm)]
    .map((match) => match[1])
    .sort();
  return { packageName, requested };
}

/**
 * Every requested permission is either unprivileged or allowlisted, every allowlisted permission is
 * requested (a stale allowlist entry fails privapp enforcement at boot), and none is forbidden.
 */
export function checkListenerPermissions(dump, privappXml, expectedPackage) {
  const { packageName, requested } = apkPermissions(dump);
  if (packageName !== expectedPackage)
    throw new Error(
      `Listener APK package is ${packageName}, expected ${expectedPackage}`,
    );
  const privileged = privappPermissions(privappXml, expectedPackage);
  const forbidden = [...requested, ...privileged].filter((name) =>
    FORBIDDEN.includes(name),
  );
  if (forbidden.length)
    throw new Error(
      `The listener must not request or be granted: ${[...new Set(forbidden)].join(", ")}`,
    );
  const unreviewed = requested.filter(
    (name) =>
      !UNPRIVILEGED.includes(name) &&
      !privileged.includes(name) &&
      !name.startsWith(`${expectedPackage}.`),
  );
  if (unreviewed.length)
    throw new Error(
      `The listener requests permissions outside the reviewed set: ${unreviewed.join(", ")}`,
    );
  const unused = privileged.filter((name) => !requested.includes(name));
  if (unused.length)
    throw new Error(
      `The privapp allowlist grants permissions the listener does not request: ${unused.join(", ")}`,
    );
  if (
    !requested.includes("android.permission.RECORD_AUDIO") ||
    !requested.includes("android.permission.FOREGROUND_SERVICE_MICROPHONE")
  )
    throw new Error(
      "The listener must request RECORD_AUDIO and FOREGROUND_SERVICE_MICROPHONE",
    );
  return { requested, privileged };
}

/** PermissionManager EXEMPTED_ROLES: holders are hidden from the microphone/camera privacy indicator. */
export const INDICATOR_EXEMPT_ROLES = [
  "config_systemAmbientAudioIntelligence",
  "config_systemUiIntelligence",
  "config_systemAudioIntelligence",
  "config_systemNotificationIntelligence",
  "config_systemTextIntelligence",
  "config_systemVisualIntelligence",
];

/**
 * The overlay sets press-and-hold power to the assistant, leaves emergency/camera gestures alone
 * and clears every indicator-exempt role. `hostPackages` are refused as any role value even if the
 * emptiness rule were relaxed.
 */
export function checkListenerOverlay(configXml, hostPackages = []) {
  const body = withoutComments(configXml);
  const value = (name) =>
    new RegExp(`<(?:integer|bool|string)\\s+name="${name}"[^>]*>([^<]*)<`)
      .exec(body)?.[1]
      ?.trim();
  if (value("config_longPressOnPowerBehavior") !== "5")
    throw new Error(
      "Press and hold power must open the assistant (config_longPressOnPowerBehavior 5)",
    );
  if (value("config_keyChordPowerVolumeUp") !== "2")
    throw new Error(
      "Power + volume up must keep opening the power menu (config_keyChordPowerVolumeUp 2)",
    );
  if (value("config_supportsMicToggle") !== "true")
    throw new Error("The microphone privacy toggle must be available");
  for (const role of INDICATOR_EXEMPT_ROLES) {
    const holder = value(role);
    if (holder === undefined)
      throw new Error(
        `${role} must be overlaid to empty: its holder is exempt from the microphone indicator`,
      );
    if (hostPackages.some((pkg) => holder.split(/[\s,;]+/).includes(pkg)))
      throw new Error(
        `${role} names a host package: it would be hidden from the microphone indicator`,
      );
    if (holder !== "")
      throw new Error(
        `${role} must be empty: its holder is exempt from the microphone indicator`,
      );
  }
  for (const kept of [
    /config_doublePressOnPowerBehavior/,
    /config_cameraDoubleTapPowerGestureEnabled/,
    /[Ee]mergency/,
    /config_defaultAssistant/,
    /config_keyChordPowerVolumeDown/,
  ])
    if (kept.test(body))
      throw new Error(`The listener overlay must not change ${kept.source}`);
  return true;
}

export const VOICE_HOST_RECORD = "android/voice-host/qualified-voice-host.json";
export const LISTENER_BUNDLE_MANIFEST = "assets/paradee-voice/v1/manifest.json";

/**
 * The voice bundle the listener loads at runtime (ai.eliza.voice.VoiceAssets then NativeAsr: the
 * same libelizainference engine and bundle as the host). A listener APK without the ASR slot pair
 * would sit in SPEECH_UNAVAILABLE forever, so production staging refuses it. `entries` are the
 * APK's zip entry names; `voiceHost` is android/voice-host/qualified-voice-host.json (schema 2);
 * `readEntry(name)` returns an entry's text. Returns the ABIs that package the engine and JNI.
 */
export function checkListenerSpeechBundle(entries, voiceHost, readEntry) {
  const names = new Set(entries);
  if (!names.has(LISTENER_BUNDLE_MANIFEST))
    throw new Error(
      `The listener APK has no ${LISTENER_BUNDLE_MANIFEST}: build it after the voice outputs are staged (node scripts/android-stage-voice-models.mjs), or it can never listen`,
    );
  if (readEntry) {
    let paths;
    try {
      paths = new Set(
        JSON.parse(readEntry(LISTENER_BUNDLE_MANIFEST)).files.map(
          (row) => row.path,
        ),
      );
    } catch {
      throw new Error("The listener APK's voice bundle manifest is unreadable");
    }
    const missing = (voiceHost?.asrSlot?.paths ?? []).filter(
      (file) => !paths.has(file),
    );
    if (!voiceHost?.asrSlot?.paths?.length || missing.length)
      throw new Error(
        `The listener APK's voice bundle has no ${missing.join(", ") || "ASR slot"}: it can never recognise speech`,
      );
  }
  const abis = (voiceHost?.abis ?? []).map((row) => row.abi);
  const packaged = abis.filter(
    (abi) =>
      names.has(`lib/${abi}/libelizainference.so`) &&
      names.has(`lib/${abi}/libparadeevoicejni.so`),
  );
  if (!packaged.length)
    throw new Error(
      `The listener APK packages no recorded voice host ABI (${abis.join(", ") || "none recorded"})`,
    );
  return packaged;
}

/**
 * The engine libraries the listener packages must be the recorded bytes (the voice host row's
 * libraries). The JNI bridge is compiled by Gradle from the pinned source and is not pinned here.
 * `hashOf(entry)` returns the SHA-256 of a zip entry. Only packaged ABIs are checked.
 */
export function checkListenerSpeechNatives(packaged, voiceHost, hashOf) {
  for (const abi of packaged) {
    const libraries =
      (voiceHost?.abis ?? []).find((item) => item.abi === abi)?.libraries ?? [];
    if (!libraries.length)
      throw new Error(`No voice host libraries are recorded for ${abi}`);
    for (const lib of libraries) {
      const actual = hashOf(`lib/${abi}/${lib.name}`);
      if (actual !== lib.sha256)
        throw new Error(
          `Listener ${abi}/${lib.name} differs from the recorded voice host library`,
        );
    }
  }
  return true;
}

/**
 * The reviewed listener descriptor: an independently reviewed record pinning the listener APK's
 * bytes and signer, like the launcher's --descriptor. Production staging requires it.
 */
export function checkListenerDescriptor(
  descriptor,
  { appId, apkSha256, signer },
) {
  if (!descriptor || typeof descriptor !== "object")
    throw new Error("A reviewed --listener-descriptor is required");
  if (descriptor.packageName !== listenerPackage(appId))
    throw new Error(
      `Listener descriptor names ${descriptor.packageName}, expected ${listenerPackage(appId)}`,
    );
  if (
    !/^[0-9a-f]{64}$/.test(descriptor.apkSha256 ?? "") ||
    descriptor.apkSha256 !== apkSha256
  )
    throw new Error(
      "The listener APK does not match the reviewed descriptor's apkSha256",
    );
  if (
    !/^[0-9a-f]{64}$/.test(descriptor.certificateSha256 ?? "") ||
    descriptor.certificateSha256 !== signer
  )
    throw new Error(
      "The listener APK signer does not match the reviewed descriptor's certificateSha256",
    );
  return true;
}

export function validateSenseProduct(product) {
  const host = product?.launcher?.packageName,
    config = product?.sense;
  const pkg = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
  if (
    !config ||
    [
      "moduleName",
      "componentPackage",
      "assistActivity",
      "appName",
      "storageName",
    ].some((key) => typeof config[key] !== "string")
  )
    throw Error("Invalid shared Sense product identity");
  if (
    product?.target !== "pixel10a" ||
    product.releaseQualified !== false ||
    !pkg.test(host) ||
    !config ||
    !/^[A-Z][A-Za-z0-9]*$/.test(config.moduleName) ||
    !pkg.test(config.componentPackage) ||
    !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(
      config.assistActivity,
    ) ||
    !config.assistActivity.startsWith(`${host}.`) ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(config.appName) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(config.storageName) ||
    !Array.isArray(config.wakeNames) ||
    config.wakeNames.length < 1 ||
    config.wakeNames.length > 8 ||
    config.wakeNames.some(
      (name) => typeof name !== "string" || !/^[a-z][a-z0-9]{0,31}$/.test(name),
    ) ||
    new Set(config.wakeNames).size !== config.wakeNames.length
  )
    throw Error("Invalid shared Sense product identity");
  return {
    ...config,
    hostPackage: host,
    packageName: `${host}.sense`,
    receiverClass: `${config.componentPackage}.ListenerActionReceiver`,
  };
}

/** Match the same reviewed model pins used by the canonical Android speech consumer. */
export function checkListenerSpeechModels(entries, hashEntry) {
  const pins = JSON.parse(
    fs.readFileSync(
      fileURLToPath(
        new URL(
          "../../../../plugins/plugin-local-inference/native/android/inputs.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
  const names = new Set(entries);
  for (const key of ["asr", "vad", "paradee", "lexicon"]) {
    const pin = pins[key],
      entry = `assets/paradee-voice/v1/${pin.path}`;
    if (!names.has(entry) || hashEntry(entry) !== pin.sha256)
      throw Error(`Sense model differs from canonical ${key} pin`);
  }
  return true;
}

/** Stage admitted bytes only; this does not execute speech, grant consent or qualify an image. */
export function stageSenseListener({
  output,
  apk,
  dump,
  signer,
  launcherSigner,
  product,
  descriptor,
  production = false,
  entries,
  voiceHost,
  readEntry,
  hashEntry,
}) {
  const config = validateSenseProduct(product),
    target = path.join(output, "listener");
  if (fs.existsSync(target))
    throw Error("Listener staging output already exists");
  const permissions = renderSensePermissions(config.hostPackage);
  checkListenerPermissions(dump, permissions, config.packageName);
  if (!/^[a-f0-9]{64}$/.test(signer ?? "") || signer !== launcherSigner)
    throw Error("Listener must share the admitted launcher signer");
  if (production || descriptor)
    checkListenerDescriptor(descriptor, {
      appId: config.hostPackage,
      apkSha256: hashEntry(null),
      signer,
    });
  let speechIncluded = false;
  try {
    const packaged = checkListenerSpeechBundle(
      entries ?? [],
      voiceHost,
      readEntry,
    );
    checkListenerSpeechNatives(packaged, voiceHost, hashEntry);
    checkListenerSpeechModels(entries, hashEntry);
    speechIncluded = true;
  } catch (error) {
    if (production) throw error;
  }
  // Signed APKs are copied unchanged, with exact stored/aligned JNI and DEX checks.
  execFileSync(
    "python3",
    [fileURLToPath(new URL("./verify-sense-apk.py", import.meta.url)), apk],
    { stdio: "pipe" },
  );
  const envelope = senseSystemuiPatch();
  const overlayConfig = fs.readFileSync(
    fileURLToPath(new URL("../../android/sense/config.xml", import.meta.url)),
    "utf8",
  );
  checkListenerOverlay(overlayConfig, [config.hostPackage, config.packageName]);
  fs.mkdirSync(target, { recursive: false });
  fs.cpSync(systemuiSource, path.join(target, "systemui/chip"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  fs.copyFileSync(
    apk,
    path.join(target, `${config.moduleName}.apk`),
    fs.constants.COPYFILE_EXCL,
  );
  const write = (name, body) => {
    const file = path.join(target, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { flag: "wx" });
  };
  write(
    `permissions/privapp-permissions-${config.packageName}.xml`,
    permissions,
  );
  const associations = [
    config.hostPackage,
    "com.android.systemui",
    "com.android.permissioncontroller",
    "com.android.settings",
  ];
  write(
    "sysconfig/sense.xml",
    `<config>\n <install-in-user-type package="${config.packageName}"><install-in user-type="android.os.usertype.full.SYSTEM" /></install-in-user-type>\n${associations.map((host) => ` <allow-association target="${config.packageName}" allowed="${host}" />`).join("\n")}\n</config>\n`,
  );
  write(
    "overlay/frameworks/base/core/res/res/values/config.xml",
    overlayConfig,
  );
  write(
    "systemui/chip/overlay/frameworks/base/packages/SystemUI/res/values/sense-listener.xml",
    `<resources>\n <string name="config_senseListeningPackage" translatable="false">${config.packageName}</string>\n <string name="config_senseListeningHostPackage" translatable="false">${config.hostPackage}</string>\n <string name="config_senseListeningReceiverClass" translatable="false">${config.receiverClass}</string>\n <string name="config_senseListeningCertificateSha256" translatable="false">${signer}</string>\n</resources>\n`,
  );
  write(
    "Android.bp",
    `android_app_import {\n name: "${config.moduleName}", apk: "${config.moduleName}.apk", presigned: true, preprocessed: true, privileged: true, system_ext_specific: true, dex_preopt: { enabled: false }, required: ["privapp-permissions-${config.packageName}.xml", "${config.moduleName}-sysconfig.xml"],\n}\nprebuilt_etc { name: "privapp-permissions-${config.packageName}.xml", src: "permissions/privapp-permissions-${config.packageName}.xml", sub_dir: "permissions", system_ext_specific: true }\nprebuilt_etc { name: "${config.moduleName}-sysconfig.xml", src: "sysconfig/sense.xml", sub_dir: "sysconfig", system_ext_specific: true }\n`,
  );
  write(
    "listener.mk",
    `sense_listener_dir := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))\nPRODUCT_PACKAGES += ${config.moduleName}\nPRODUCT_PACKAGE_OVERLAYS += $(sense_listener_dir)/overlay $(sense_listener_dir)/systemui/chip/overlay\nPRODUCT_PRODUCT_PROPERTIES += ro.hotword.detection_service_required=true\n`,
  );
  const evidence = {
    schemaVersion: 1,
    packageName: config.packageName,
    moduleName: config.moduleName,
    receiverClass: config.receiverClass,
    speechIncluded,
    requiredSourcePatches: [
      {
        bundle: "chip",
        manifest: "listener/systemui/chip/manifest.json",
        ...envelope,
      },
    ],
    sourcePatched: false,
    systemUiCompiled: false,
    imageBuilt: false,
    releaseQualified: false,
    deviceAcceptanceVerified: false,
  };
  write("evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
  fs.appendFileSync(
    path.join(output, "product.mk"),
    "\ninclude $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))/listener/listener.mk\n",
  );
  return evidence;
}

/** Native-tool adapter: all admission reads inspect the same private APK copy. */
export function stageSenseApk({
  apk,
  output,
  product,
  launcherSigner,
  descriptor,
  voiceHost,
  production = false,
  aapt = "aapt",
  apksigner = "apksigner",
  env = process.env,
}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sense-admit-"));
  try {
    const copy = path.join(temporary, "Sense.apk");
    fs.copyFileSync(apk, copy);
    const run = (command, args, extra = {}) =>
      execFileSync(command, args, {
        env,
        encoding: "utf8",
        maxBuffer: 16 << 20,
        timeout: 30000,
        ...extra,
      });
    const signatures = run(apksigner, ["verify", "--print-certs", copy]);
    const signers = [
      ...signatures.matchAll(
        /Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9]+)/g,
      ),
    ].map((row) => row[1].toLowerCase());
    if (signers.length !== 1)
      throw Error("Sense requires exactly one APK signer");
    const xml = run(aapt, ["dump", "xmltree", copy, "AndroidManifest.xml"]);
    if (production && /android:debuggable[^\n]*0xffffffff/.test(xml))
      throw Error("Debuggable Sense APK is development-only");
    const entries = run("unzip", ["-Z1", copy]).split(/\r?\n/).filter(Boolean);
    const readEntry = (entry) =>
      run("unzip", ["-p", copy, entry], { maxBuffer: 1 << 20 });
    const hashEntry = (entry) =>
      createHash("sha256")
        .update(
          entry === null
            ? fs.readFileSync(copy)
            : execFileSync("unzip", ["-p", copy, entry], {
                maxBuffer: 256 << 20,
                timeout: 30000,
              }),
        )
        .digest("hex");
    return stageSenseListener({
      output,
      apk: copy,
      dump: run(aapt, ["dump", "permissions", copy]),
      signer: signers[0],
      launcherSigner,
      product,
      descriptor,
      production,
      entries,
      voiceHost,
      readEntry,
      hashEntry,
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const privilegedFlag = /privateFlags=\[[^\]]*\bPRIVILEGED\b/;

/**
 * Read-only admission of a booted product image over adb (`run(...args)` returns adb stdout). It
 * reports what the package manager and properties say; it does not open the microphone, change
 * consent or press keys. The visible indicator, press-and-hold invocation, lock-screen controls,
 * call/echo behaviour and battery remain device/user acceptance and are never established here.
 */
export function verifyAospListener(run, user, appId) {
  if (!/^(0|[1-9]\d*)$/.test(user || ""))
    throw Error("Explicit Android user required");
  const pkg = listenerPackage(appId);
  const system = run(
    "shell",
    "pm",
    "list",
    "packages",
    "-s",
    "--user",
    user,
    pkg,
  );
  if (
    !system
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(`package:${pkg}`)
  )
    throw Error(`${pkg} is not installed as a system package for user ${user}`);
  const dump = run("shell", "dumpsys", "package", pkg);
  if (!privilegedFlag.test(dump)) throw Error(`${pkg} is not a privileged app`);
  if (!/\bflags=\[[^\]]*\bPERSISTENT\b/.test(dump))
    throw Error(`${pkg} is not persistent`);
  const granted = (name) =>
    new RegExp(`${name.replace(/\./g, "\\.")}: granted=true`).test(dump);
  if (!granted("android.permission.CAPTURE_AUDIO_HOTWORD"))
    throw Error("CAPTURE_AUDIO_HOTWORD is not granted to the listener");
  for (const name of FORBIDDEN)
    if (new RegExp(`${name.replace(/\./g, "\\.")}\\b`).test(dump))
      throw Error(`The listener has ${name}`);
  if (privilegedFlag.test(run("shell", "dumpsys", "package", appId)))
    throw Error(`${appId} must stay nonprivileged`);
  if (
    run("shell", "getprop", "ro.hotword.detection_service_required").trim() !==
    "true"
  )
    throw Error("ro.hotword.detection_service_required is not true");
  // SystemUI hides the microphone/camera chip when this DeviceConfig flag is false. Its AOSP
  // default is true and the image has no flag-push service; any explicit false fails admission.
  if (
    /^false$/i.test(
      run(
        "shell",
        "device_config",
        "get",
        "privacy",
        "camera_mic_icons_enabled",
      ).trim(),
    )
  )
    throw Error(
      "DeviceConfig privacy/camera_mic_icons_enabled is false: the microphone indicator is disabled",
    );
  for (const role of [
    "android.app.role.SYSTEM_AMBIENT_AUDIO_INTELLIGENCE",
    "android.app.role.SYSTEM_UI_INTELLIGENCE",
    "android.app.role.SYSTEM_AUDIO_INTELLIGENCE",
    "android.app.role.SYSTEM_NOTIFICATION_INTELLIGENCE",
    "android.app.role.SYSTEM_TEXT_INTELLIGENCE",
    "android.app.role.SYSTEM_VISUAL_INTELLIGENCE",
  ]) {
    const holders = run(
      "shell",
      "cmd",
      "role",
      "get-role-holders",
      "--user",
      user,
      role,
    ).trim();
    if (holders)
      throw Error(
        `${role} is held by ${holders}: its holder is hidden from the microphone indicator`,
      );
  }
  const services = run("shell", "dumpsys", "activity", "services", pkg);
  return {
    user,
    packageName: pkg,
    privileged: true,
    persistent: true,
    captureHotwordGranted: true,
    recordAudioGranted: granted("android.permission.RECORD_AUDIO"),
    listeningServiceRunning: /\.ListeningService\b/.test(services),
    indicatorVerified: false,
    invocationVerified: false,
    lockScreenControlsVerified: false,
  };
}
