/**
 * Pure parsing and evaluation for device-qualify.ts. Every function takes
 * captured command output and returns data, so the rules are unit-tested
 * without a device (scripts/__tests__/device-qualify.node.test.ts).
 */

export function parseGetprop(text = "") {
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]: \[(.*)\]$/.exec(line.trim());
    if (match) props[match[1]] = match[2];
  }
  return props;
}

export function parseMeminfoGiB(text = "") {
  const kb = /^MemTotal:\s+(\d+)\s+kB/m.exec(text)?.[1];
  return kb ? round(Number(kb) / 1024 ** 2) : null;
}

// `df -k /data` → total size of the data filesystem.
export function parseDfGiB(text = "") {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const fields = lines.at(-1)?.trim().split(/\s+/) ?? [];
  const blocks = Number(fields[1]);
  return Number.isFinite(blocks) && blocks > 0
    ? round(blocks / 1024 ** 2)
    : null;
}

// `wm size` prints the physical size and, when set, an override. Physical
// hardware capability is what qualification needs.
export function parseWmSize(text = "") {
  const match = /Physical size:\s*(\d+)x(\d+)/.exec(text);
  if (!match) return null;
  const [w, h] = [Number(match[1]), Number(match[2])];
  return {
    width: w,
    height: h,
    longEdge: Math.max(w, h),
    shortEdge: Math.min(w, h),
  };
}

export function parseWmDensity(text = "") {
  const value = /Physical density:\s*(\d+)/.exec(text)?.[1];
  return value ? Number(value) : null;
}

export function parseKernelVersion(text = "") {
  const release = text.trim();
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(release);
  if (!match) return null;
  const gki = /-(android\d+)-(\d+)/.exec(release);
  return {
    release,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : null,
    gkiBranch: gki ? `${gki[1]}-${match[1]}.${match[2]}` : null,
  };
}

// `dumpsys media.camera` prints one static-information block per camera
// device. Facing comes from android.lens.facing; autofocus from the AF modes
// plus a non-zero minimum focus distance (0 means fixed focus).
// CameraMetadata CONTROL_AF_MODE_* values, printed numerically by some HALs.
const AF_MODES = {
  0: "OFF",
  1: "AUTO",
  2: "MACRO",
  3: "CONTINUOUS_VIDEO",
  4: "CONTINUOUS_PICTURE",
  5: "EDOF",
};

export function parseCameras(text = "") {
  const blocks = text.split(/^\s*== Camera HAL device /m).slice(1);
  const cameras = [];
  for (const block of blocks) {
    const id = /^([^\s]+)/.exec(block)?.[1] ?? null;
    const facing =
      /android\.lens\.facing \([0-9a-f]+\): byte\[1\]\s*\[\s*(\w+)\s*\]/i
        .exec(block)?.[1]
        ?.toLowerCase();
    if (!facing) continue;
    const afModes = (
      /android\.control\.afAvailableModes \([0-9a-f]+\): byte\[\d+\]\s*\[([^\]]*)\]/i.exec(
        block,
      )?.[1] ?? ""
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((m) => AF_MODES[m] ?? m.toUpperCase());
    const minFocus =
      /android\.lens\.info\.minimumFocusDistance \([0-9a-f]+\): float\[1\]\s*\[\s*([0-9.]+)\s*\]/i.exec(
        block,
      )?.[1];
    const minimumFocusDistance =
      minFocus === undefined ? null : Number(minFocus);
    const autofocus =
      afModes.some((m) =>
        ["AUTO", "CONTINUOUS_PICTURE", "CONTINUOUS_VIDEO", "MACRO"].includes(m),
      ) && minimumFocusDistance !== 0;
    const pixelArray =
      /android\.sensor\.info\.pixelArraySize \([0-9a-f]+\): int32\[2\]\s*\[\s*(\d+)\s+(\d+)\s*\]/i.exec(
        block,
      );
    const megapixels = pixelArray
      ? round((Number(pixelArray[1]) * Number(pixelArray[2])) / 1e6, 1)
      : null;
    if (!cameras.some((c) => c.id === id))
      cameras.push({
        id,
        facing,
        afModes,
        minimumFocusDistance,
        autofocus,
        megapixels,
      });
  }
  return cameras;
}

// Counts distinct built-in microphone device ports from the audio policy dump.
// One device port can represent several physical mics, so this is a lower bound.
export function parseMicrophoneCount(text = "") {
  const seen = new Set();
  const pattern =
    /AUDIO_DEVICE_IN_(BUILTIN|BACK)_MIC[^\n]*?(?:@:?\s*"?([^",\s)]*)"?)?/g;
  for (const match of text.matchAll(pattern))
    seen.add(`${match[1]}:${match[2] ?? ""}`);
  return seen.size;
}

// media_codecs XML: collect MIME types declared under <Decoders>/<Encoders>.
export function parseMediaCodecs(text = "") {
  const decoders = new Set();
  const encoders = new Set();
  let section = null;
  for (const token of text.matchAll(
    /<(\/?)(Decoders|Encoders|MediaCodec|Type)\b([^>]*)>/g,
  )) {
    const [, closing, tag, attrs] = token;
    if (tag === "Decoders" || tag === "Encoders") {
      section = closing ? null : tag;
      continue;
    }
    if (closing || !section) continue;
    const type = /\b(?:type|name)="([a-z]+\/[^"]+)"/.exec(attrs)?.[1];
    if (type)
      (section === "Decoders" ? decoders : encoders).add(type.toLowerCase());
  }
  return { decoders: [...decoders].sort(), encoders: [...encoders].sort() };
}

export function parseWifiCountry(text = "") {
  return (
    /country code[^A-Z]*([A-Z]{2})\b/i.exec(text)?.[1]?.toUpperCase() ?? null
  );
}

// 5 GHz capability. Prefer the HAL band bitmask from `dumpsys wifi`
// (WifiScanner bands: 1 = 2.4 GHz, 2 = 5 GHz, 4 = 5 GHz DFS, 8 = 6 GHz).
export function parseWifiBands(text = "") {
  const mask = /wifi_native_supported_sta_bands=(\d+)/.exec(text)?.[1];
  if (mask === undefined) return null;
  const bits = Number(mask);
  return {
    mask: bits,
    ghz2_4: Boolean(bits & 1),
    ghz5: Boolean(bits & 6),
    ghz6: Boolean(bits & 8),
  };
}

export function parseWifi5GHz(text = "") {
  const bands = parseWifiBands(text);
  if (bands) return bands.ghz5;
  if (
    /(5\s?GHz|5G)[^\n]{0,40}(supported|band)[^\n]{0,20}(true|yes)/i.test(text)
  )
    return true;
  if (/is5GHzBandSupported\s*[:=]\s*true/i.test(text)) return true;
  if (
    /(5\s?GHz|5G)[^\n]{0,40}(supported|band)[^\n]{0,20}(false|no)/i.test(text)
  )
    return false;
  return null;
}

// `ls -l PATH` for a single file → permission string, or null when absent.
export function parseLsMode(text = "") {
  const match = /^([-dlcbps][-rwxsStT]{9})\S*\s/m.exec(text);
  return match ? match[1] : null;
}

export function parseVintfTargetLevel(text = "") {
  return (
    /<manifest\b[^>]*\btype="device"[^>]*\btarget-level="([^"]+)"/.exec(
      text,
    )?.[1] ??
    /<manifest\b[^>]*\btarget-level="([^"]+)"[^>]*\btype="device"/.exec(
      text,
    )?.[1] ??
    null
  );
}

// `fastboot getvar all` writes "(bootloader) key:value" lines to stderr.
export function parseFastbootVars(text = "") {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\(bootloader\)\s+([^:]+(?::[^:\s]+)?):\s*(.*)$/.exec(
      line.trim(),
    );
    if (match) vars[match[1].trim()] = match[2].trim();
  }
  return vars;
}

export function deriveFacts(raw) {
  const props = parseGetprop(raw.getprop);
  const kernel = parseKernelVersion(raw.uname ?? "");
  const display = parseWmSize(raw.wmSize ?? "");
  const codecs = parseMediaCodecs(raw.mediaCodecs ?? "");
  const vendorApiRaw = firstInt(
    props["ro.vendor.api_level"],
    props["ro.board.api_level"],
    props["ro.board.first_api_level"],
    props["ro.vendor.build.version.sdk"],
  );
  const vendorApi = normalizeVendorApiLevel(vendorApiRaw);
  const chargeNodes = (raw.chargeControl ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("/"));
  const platform = (
    props["ro.board.platform"] ||
    props["ro.hardware"] ||
    ""
  ).toLowerCase();
  return {
    emulator: props["ro.kernel.qemu"] === "1" || props["ro.boot.qemu"] === "1",
    manufacturer: props["ro.product.manufacturer"] ?? null,
    model: props["ro.product.model"] ?? null,
    device: props["ro.product.device"] ?? null,
    fingerprint: props["ro.build.fingerprint"] ?? null,
    vendorFingerprint: props["ro.vendor.build.fingerprint"] ?? null,
    androidRelease: firstInt(props["ro.build.version.release"]),
    sdk: firstInt(props["ro.build.version.sdk"]),
    securityPatch: props["ro.build.version.security_patch"] ?? null,
    vendorSecurityPatch: props["ro.vendor.build.security_patch"] ?? null,
    firstApiLevel: firstInt(props["ro.product.first_api_level"]),
    vendorApiLevel: vendorApi,
    vendorApiLevelRaw: vendorApiRaw,
    vndkVersion: props["ro.vndk.version"] ?? null,
    treble: props["ro.treble.enabled"] === "true",
    abi: props["ro.product.cpu.abi"] ?? null,
    platform: platform || null,
    socManufacturer: props["ro.soc.manufacturer"] ?? null,
    socModel: props["ro.soc.model"] ?? null,
    mediatek:
      /^mt\d/.test(platform) ||
      /mediatek/i.test(props["ro.soc.manufacturer"] ?? ""),
    kernel,
    ramGiB: parseMeminfoGiB(raw.meminfo ?? ""),
    dataGiB: parseDfGiB(raw.dfData ?? ""),
    display,
    densityDpi: parseWmDensity(raw.wmDensity ?? ""),
    cameras: parseCameras(raw.cameras ?? ""),
    microphoneCount: raw.audioPolicy
      ? parseMicrophoneCount(raw.audioPolicy)
      : null,
    codecs,
    wifiCountry: parseWifiCountry(raw.wifiCountry ?? ""),
    wifi5GHz: parseWifi5GHz(`${raw.wifiStatus ?? ""}\n${raw.wifiDump ?? ""}`),
    wifiBands: parseWifiBands(raw.wifiDump ?? ""),
    bluetooth: {
      leAudio:
        props["ro.bluetooth.leaudio_switcher.supported"] === "true" ||
        props["bluetooth.profile.bap.unicast.client.enabled"] === "true",
      asha: props["bluetooth.profile.asha.central.enabled"] === "true",
    },
    dynamicPartitions: props["ro.boot.dynamic_partitions"] === "true",
    abUpdates: props["ro.build.ab_update"] === "true",
    virtualAb: props["ro.virtual_ab.enabled"] === "true",
    slotSuffix: props["ro.boot.slot_suffix"] ?? null,
    verifiedBootState: props["ro.boot.verifiedbootstate"] ?? null,
    vbmetaDeviceState: props["ro.boot.vbmeta.device_state"] ?? null,
    flashLocked: props["ro.boot.flash.locked"] ?? null,
    selinux: (raw.getenforce ?? "").trim() || null,
    chargeControlNodes: chargeNodes,
    wlanCountryProcMode: parseLsMode(raw.wlanCountryProc ?? ""),
    regulatoryFirmwareFiles: (raw.vendorFirmware ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim().split(/\s+/).at(-1))
      .filter(
        (name) =>
          name && /TxPwrLimit|wifi\.cfg|WIFI_RAM_CODE|WMT|\.dat$/i.test(name),
      ),
    vintfTargetLevel: parseVintfTargetLevel(raw.vintfManifest ?? ""),
  };
}

function compareVersion(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const pass = (observed) => ({ result: "pass", observed });
const fail = (observed) => ({ result: "fail", observed });
const unknown = (observed = null) => ({ result: "unknown", observed });

const checks = {
  androidRelease: (f, r) =>
    f.androidRelease == null
      ? unknown()
      : (f.androidRelease >= r.min ? pass : fail)(f.androidRelease),
  treble: (f) => (f.treble ? pass : fail)(f.treble),
  vendorApiLevel: (f, r) =>
    f.vendorApiLevel == null
      ? unknown()
      : (f.vendorApiLevel >= r.min ? pass : fail)(f.vendorApiLevel),
  kernelVersion: (f, r) =>
    !f.kernel
      ? unknown()
      : (compareVersion(`${f.kernel.major}.${f.kernel.minor}`, r.min) >= 0
          ? pass
          : fail)(f.kernel.release),
  abi: (f, r) =>
    f.abi == null ? unknown() : (f.abi === r.equals ? pass : fail)(f.abi),
  ramGiB: (f, r) =>
    f.ramGiB == null ? unknown() : (f.ramGiB >= r.min ? pass : fail)(f.ramGiB),
  dataGiB: (f, r) =>
    f.dataGiB == null
      ? unknown()
      : (f.dataGiB >= r.min ? pass : fail)(f.dataGiB),
  displayLongEdgePx: (f, r) =>
    !f.display
      ? unknown()
      : (f.display.longEdge >= r.min ? pass : fail)(f.display.longEdge),
  displayShortEdgePx: (f, r) =>
    !f.display
      ? unknown()
      : (f.display.shortEdge >= r.min ? pass : fail)(f.display.shortEdge),
  camera: (f, r) => {
    if (!f.cameras?.length) return unknown([]);
    const match = f.cameras.filter((c) => c.facing === r.facing);
    return (match.length ? pass : fail)(match.map((c) => c.id));
  },
  cameraAutofocus: (f, r) => {
    const match = (f.cameras ?? []).filter((c) => c.facing === r.facing);
    if (!match.length) return unknown([]);
    return (match.some((c) => c.autofocus) ? pass : fail)(
      match.map(({ id, afModes, minimumFocusDistance }) => ({
        id,
        afModes,
        minimumFocusDistance,
      })),
    );
  },
  microphoneCount: (f, r) =>
    f.microphoneCount == null || f.microphoneCount === 0
      ? unknown(f.microphoneCount)
      : (f.microphoneCount >= r.min ? pass : fail)(f.microphoneCount),
  wifi5GHz: (f) =>
    f.wifi5GHz == null ? unknown() : (f.wifi5GHz ? pass : fail)(f.wifi5GHz),
  codec: (f, r) =>
    !f.codecs?.decoders?.length
      ? unknown()
      : (f.codecs.decoders.includes(r.mime) ? pass : fail)(r.mime),
  dynamicPartitions: (f) =>
    (f.dynamicPartitions ? pass : fail)(f.dynamicPartitions),
  abUpdates: (f) => (f.abUpdates ? pass : fail)(f.abUpdates),
  selinuxEnforcing: (f) =>
    f.selinux == null
      ? unknown()
      : (f.selinux === "Enforcing" ? pass : fail)(f.selinux),
  chargeControl: (f) =>
    f.chargeControlNodes?.length ? pass(f.chargeControlNodes) : unknown([]),
  // Absent node: not a MediaTek gen4m driver, or hidden from shell. Present
  // and world-writable fails; anything else is an observation, not proof.
  wifiCountryProcNotWorldWritable: (f) =>
    f.wlanCountryProcMode == null
      ? unknown(null)
      : (f.wlanCountryProcMode[8] === "w" ? fail : pass)(f.wlanCountryProcMode),
  fastbootUnlockable: (f) => {
    const v = f.fastboot ?? {};
    if (v.unlocked === "yes" || v.unlock_ability === "1")
      return pass(v.unlocked ?? v.unlock_ability);
    if (v.unlock_ability === "0") return fail("0");
    return unknown(v.unlocked ?? null);
  },
  fastbootAvbCustomKey: (f) => {
    const value = f.fastboot?.["partition-type:avb_custom_key"];
    if (value === undefined) return unknown(null);
    return (value && !/fail|unknown|not found/i.test(value) ? pass : fail)(
      value,
    );
  },
};

export const checkNames = Object.freeze(Object.keys(checks));

// Requirements files are product data; reject anything the evaluator would
// silently misread.
export function validateRequirements(requirements) {
  if (requirements?.schemaVersion !== 1)
    throw new Error("requirements: expected schemaVersion 1");
  const ids = new Set();
  for (const listName of ["requirements", "fastbootRequirements"]) {
    const list = requirements[listName] ?? [];
    if (!Array.isArray(list))
      throw new Error(`requirements: ${listName} must be an array`);
    for (const req of list) {
      if (typeof req?.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(req.id))
        throw new Error(`requirements: invalid id ${JSON.stringify(req?.id)}`);
      if (ids.has(req.id))
        throw new Error(`requirements: duplicate id ${req.id}`);
      ids.add(req.id);
      if (!["required", "preferred"].includes(req.level))
        throw new Error(
          `requirements: ${req.id} level must be required or preferred`,
        );
      if (!Object.hasOwn(checks, req.check))
        throw new Error(
          `requirements: ${req.id} uses unknown check ${req.check}`,
        );
    }
  }
  if (!requirements.requirements?.length)
    throw new Error("requirements: at least one adb requirement is needed");
  return requirements;
}

export function evaluate(facts, requirements, { fastboot = false } = {}) {
  const list =
    (fastboot
      ? requirements.fastbootRequirements
      : requirements.requirements) ?? [];
  const results = list.map((req) => {
    const check = Object.hasOwn(checks, req.check) ? checks[req.check] : null;
    if (!check) throw new Error(`Unknown requirement check ${req.check}`);
    return { id: req.id, level: req.level, ...check(facts, req) };
  });
  const required = results.filter((r) => r.level === "required");
  const verdict = required.some((r) => r.result === "fail")
    ? "fail"
    : required.some((r) => r.result === "unknown")
      ? "incomplete"
      : "pass";
  return {
    verdict,
    evidenceLevel: facts.emulator
      ? "emulator-observation"
      : fastboot
        ? "bootloader-observation"
        : "device-observation",
    disclaimer:
      "Read-only observation. Not a GSI or image boot, and not RF, FCC, acoustic, battery or user-acceptance evidence.",
    results,
    warnings: results
      .filter((r) => r.level === "preferred" && r.result !== "pass")
      .map((r) => r.id),
  };
}

// Android 15 moved vendor API levels to YYYYMM (202404 = Android 15,
// 202504 = Android 16). Map them back to SDK numbers for comparison.
export function normalizeVendorApiLevel(value) {
  if (value == null || value < 200000) return value;
  const year = Math.floor(value / 100);
  return 35 + (year - 2024);
}

function firstInt(...values) {
  for (const value of values) {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
