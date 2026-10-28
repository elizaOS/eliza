/**
 * Staging of the pinned Android/AOSP voice bundle into an agent bundle root.
 *
 * The rows come from the `mobile-voice` entry of
 * `model-catalog/voice-model-versions.json`: Paradee-8M TTS with its misaki
 * lexicon (`tts/paradee/`), the eSpeak NG English data misaki uses for words
 * outside the lexicon (`tts/paradee/espeak-ng-data/`, staged after and inside
 * `tts/paradee/`), the ASR model (`asr/`) and Silero VAD (`vad/`).
 * `asr/` holds Phonon-2 (Parakeet-TDT, batch + streaming), the only local ASR.
 * An `asr/` group staged with other rows (the retired Qwen3-ASR pair) is
 * re-staged with Phonon-2. Every file runs on libelizainference; nothing here
 * is ONNX.
 *
 * Each group is staged into `<dir>.staging/`, verified (size + sha256), and
 * published with one rename, so a reader sees the whole group or nothing.
 * An existing group is reused only after its files match their pins.
 *
 * Published rows download from their pinned Hugging Face revision through the
 * AOSP network admission check. Unpublished rows (Paradee GGUF and lexicon,
 * eSpeak NG data, Phonon-2 GGUF, until the owner publishes them) are never
 * downloaded: they
 * can only be copied from a local source directory, checked against the
 * catalog pin when the row has one (Phonon-2's conversion is
 * byte-reproducible) or against pins supplied with that directory.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type AospNetworkAdmissionOptions,
  createAospNetworkAdmissionCheck,
} from "./aosp-network-admission.js";
import {
  isPublishedMobileVoiceFile,
  MOBILE_ASR_ROLES,
  type MobileVoiceFile,
  type MobileVoiceFileRole,
  mobileVoiceBundle,
} from "./model-catalog/voice-models.js";
import { downloadHttpModel } from "./shared/http-model-download.js";

export interface AospVoiceGroup {
  /** Directory relative to the bundle root. */
  readonly dir: string;
  readonly roles: ReadonlyArray<MobileVoiceFileRole>;
  /**
   * Group directory (relative to the bundle root) that must already be staged
   * before this one: a group nested inside another is staged after it, so
   * its directory never makes the outer group look present.
   */
  readonly requires?: string;
}

/** Roles a group may hold several files of (a directory tree). Every other role is one file. */
const MULTI_FILE_ROLES: ReadonlySet<MobileVoiceFileRole> = new Set([
  "g2p-espeak-data",
]);

/** The eSpeak NG data group (nested in `tts/paradee/`, where the loaders look for it). */
export const AOSP_ESPEAK_GROUP: AospVoiceGroup = {
  dir: "tts/paradee/espeak-ng-data",
  roles: ["g2p-espeak-data"],
  requires: "tts/paradee",
};

/**
 * The groups to stage. Order: the voice the user hears first, then VAD, then
 * ASR (the 330 MB Phonon-2 GGUF).
 */
export const AOSP_VOICE_GROUPS: ReadonlyArray<AospVoiceGroup> = [
  { dir: "tts/paradee", roles: ["tts", "g2p-lexicon"] },
  AOSP_ESPEAK_GROUP,
  { dir: "vad", roles: ["vad"] },
  { dir: "asr", roles: MOBILE_ASR_ROLES },
];

/** Name of the per-group record written next to the staged files. */
export const AOSP_VOICE_RECORD = "voice-files.json";

export function aospVoiceFiles(): ReadonlyArray<MobileVoiceFile> {
  return mobileVoiceBundle().files;
}

export function aospVoiceGroupFiles(
  group: AospVoiceGroup,
  files: ReadonlyArray<MobileVoiceFile> = aospVoiceFiles(),
): MobileVoiceFile[] {
  const out = files.filter((file) => group.roles.includes(file.role));
  for (const file of out) {
    const relative = aospVoiceGroupRelativePath(group, file);
    const nested = relative.includes("/");
    if (nested && !MULTI_FILE_ROLES.has(file.role)) {
      throw new Error(
        `[aosp-voice] ${file.id} path ${file.path} is outside group ${group.dir}`,
      );
    }
  }
  const counts = group.roles.map(
    (role) => out.filter((f) => f.role === role).length,
  );
  if (
    group.roles.some((role, i) =>
      MULTI_FILE_ROLES.has(role) ? counts[i] === 0 : counts[i] !== 1,
    )
  ) {
    throw new Error(
      `[aosp-voice] group ${group.dir} expects roles ${group.roles.join(", ")} but the catalog has ${out.map((f) => f.role).join(", ")}`,
    );
  }
  return out;
}

/**
 * `file.path` relative to `group.dir` (POSIX). Throws when the row is not
 * inside the group directory or tries to leave it.
 */
export function aospVoiceGroupRelativePath(
  group: AospVoiceGroup,
  file: MobileVoiceFile,
): string {
  const prefix = `${group.dir}/`;
  const relative = file.path.startsWith(prefix)
    ? file.path.slice(prefix.length)
    : "";
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    relative
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      `[aosp-voice] ${file.id} path ${file.path} is outside group ${group.dir}`,
    );
  }
  return relative;
}

function aospVoiceGroupTarget(
  dir: string,
  group: AospVoiceGroup,
  file: MobileVoiceFile,
): string {
  return path.join(dir, ...aospVoiceGroupRelativePath(group, file).split("/"));
}

/** sha256 + byte length a local file must match. */
export interface AospVoicePin {
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * A directory laid out like the bundle (`tts/paradee/…`, `asr/…`, `vad/…`).
 * `pins` gives the expected sha256/bytes for unpublished rows, keyed by row
 * id (for example the values from the fork's `tools/paradee/pins.json`).
 * Published rows are always checked against the catalog pins; a local pin
 * that disagrees with the catalog is rejected.
 */
export interface AospVoiceLocalSource {
  readonly dir: string;
  readonly pins?: Readonly<Record<string, AospVoicePin>>;
}

/** Read `<dir>/voice-pins.json` ({ "<row id>": { sha256, bytes } }) when present. */
export function readAospVoiceLocalSource(dir: string): AospVoiceLocalSource {
  const pinsPath = path.join(dir, "voice-pins.json");
  if (!existsSync(pinsPath)) return { dir };
  const parsed = JSON.parse(readFileSync(pinsPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[aosp-voice] ${pinsPath} must be an object of pins`);
  }
  const pins: Record<string, AospVoicePin> = {};
  for (const [id, value] of Object.entries(parsed)) {
    const pin = value as Partial<AospVoicePin>;
    if (
      typeof pin?.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(pin.sha256) ||
      typeof pin.bytes !== "number" ||
      !Number.isSafeInteger(pin.bytes) ||
      pin.bytes <= 0
    ) {
      throw new Error(`[aosp-voice] ${pinsPath}: invalid pin for ${id}`);
    }
    pins[id] = { sha256: pin.sha256, bytes: pin.bytes };
  }
  return { dir, pins };
}

/** The pin a file must match: the catalog for published rows, else the local pins. */
export function expectedAospVoicePin(
  file: MobileVoiceFile,
  local?: AospVoiceLocalSource,
): AospVoicePin | null {
  const localPin = local?.pins?.[file.id];
  if (isPublishedMobileVoiceFile(file)) {
    if (
      localPin &&
      (localPin.sha256 !== file.sha256 || localPin.bytes !== file.bytes)
    ) {
      throw new Error(
        `[aosp-voice] local pin for ${file.id} disagrees with the catalog`,
      );
    }
    return { sha256: file.sha256, bytes: file.bytes };
  }
  const catalogPin = catalogPinOf(file);
  if (catalogPin) {
    if (
      localPin &&
      (localPin.sha256 !== catalogPin.sha256 ||
        localPin.bytes !== catalogPin.bytes)
    ) {
      throw new Error(
        `[aosp-voice] local pin for ${file.id} disagrees with the catalog`,
      );
    }
    return catalogPin;
  }
  return localPin ?? null;
}

/** sha256 + bytes an unpublished row pins itself (a byte-reproducible build). */
function catalogPinOf(file: MobileVoiceFile): AospVoicePin | null {
  return typeof file.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(file.sha256) &&
    typeof file.bytes === "number" &&
    Number.isSafeInteger(file.bytes) &&
    file.bytes > 0
    ? { sha256: file.sha256, bytes: file.bytes }
    : null;
}

/** Row ids recorded in a staged group's `voice-files.json`, or null without a valid record. */
export function readAospVoiceGroupRecordIds(
  groupDir: string,
  group: AospVoiceGroup,
): string[] | null {
  return (
    readAospVoiceGroupRecordRows(groupDir, group)?.map((row) => row.id) ?? null
  );
}

/** `id`, `path` and `role` of each row in a staged group's record, or null without a valid record. */
function readAospVoiceGroupRecordRows(
  groupDir: string,
  group: AospVoiceGroup,
): Array<{
  id: string;
  path: string | undefined;
  role: string | undefined;
}> | null {
  try {
    const record = JSON.parse(
      readFileSync(path.join(groupDir, AOSP_VOICE_RECORD), "utf8"),
    ) as { schema?: unknown; dir?: unknown; files?: unknown } | null;
    if (
      record?.schema !== "eliza-mobile-voice-group-v1" ||
      record.dir !== group.dir ||
      !Array.isArray(record.files)
    ) {
      return null;
    }
    const rows = record.files.map((row: unknown) => {
      const r =
        row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      return {
        id: r.id,
        path: typeof r.path === "string" ? r.path : undefined,
        role: typeof r.role === "string" ? r.role : undefined,
      };
    });
    return rows.every((row) => typeof row.id === "string")
      ? (rows as Array<{
          id: string;
          path: string | undefined;
          role: string | undefined;
        }>)
      : null;
  } catch {
    // error-policy:J3 an unreadable or missing record is "no record"; the
    // caller decides whether that is an error.
    return null;
  }
}

/**
 * True when `<bundleRoot>/<group.dir>` is absent, or holds a recorded set of
 * rows other than the one this group stages now (for example `asr/` staged
 * with the retired Qwen3-ASR pair before Phonon-2 became the only ASR, or a row
 * whose staged file name changed, such as `paradee-8m-v1.0.gguf` before it
 * became `paradee-8m-v1_0.gguf`).
 */
export function aospVoiceGroupNeedsStaging(
  bundleRoot: string,
  group: AospVoiceGroup,
  files: ReadonlyArray<MobileVoiceFile> = aospVoiceFiles(),
): boolean {
  const dir = path.join(bundleRoot, group.dir);
  if (!existsSync(dir)) return true;
  const recorded = readAospVoiceGroupRecordRows(dir, group);
  if (!recorded) return false;
  const wanted = aospVoiceGroupFiles(group, files);
  return (
    recorded.length !== wanted.length ||
    wanted.some(
      (file) =>
        !recorded.some(
          (row) =>
            row.id === file.id &&
            (row.path === undefined || row.path === file.path),
        ),
    )
  );
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Verified files enter the caller-owned staging directory before its atomic bundle publication. */
export async function downloadAospVoiceAsset(
  asset: { url: string; sha256: string; sizeBytes: number },
  destination: string,
  options: AospNetworkAdmissionOptions & { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await downloadHttpModel({
    url: asset.url,
    stagingPath: `${destination}.part`,
    finalPath: destination,
    label: "Automatic voice artifact",
    expectedSizeBytes: asset.sizeBytes,
    expectedSha256: asset.sha256,
    checkAdmission: createAospNetworkAdmissionCheck(asset.sizeBytes, options),
    fetchImpl: options.fetchImpl,
  });
}

export type AospVoiceGroupResult =
  | { readonly status: "present"; readonly dir: string }
  | { readonly status: "staged"; readonly dir: string }
  | {
      readonly status: "unavailable";
      readonly dir: string;
      readonly reason: string;
    };

export interface StageAospVoiceGroupOptions
  extends AospNetworkAdmissionOptions {
  readonly local?: AospVoiceLocalSource;
  readonly fetchImpl?: typeof fetch;
  readonly files?: ReadonlyArray<MobileVoiceFile>;
  /** Removes a generated `*.staging` dir; the bootstrap passes its guarded remover. */
  readonly removeStaging?: (stagingDir: string) => void;
}

/**
 * Stage one group into `<bundleRoot>/<group.dir>`. Returns "present" when the
 * directory already exists and its files match their pins, "unavailable" when an unpublished row has no
 * local source (nothing is written), else downloads/copies every file into
 * `<dir>.staging`, verifies it, writes the record and renames the staging
 * directory into place.
 */
/** Existing files hashed in this process: path -> pin + stat signature. */
const verifiedExistingFiles = new Map<string, string>();

export async function stageAospVoiceGroup(
  bundleRoot: string,
  group: AospVoiceGroup,
  options: StageAospVoiceGroupOptions = {},
): Promise<AospVoiceGroupResult> {
  const finalDir = path.join(bundleRoot, group.dir);
  const files = aospVoiceGroupFiles(group, options.files);
  if (group.requires && !existsSync(path.join(bundleRoot, group.requires))) {
    return {
      status: "unavailable",
      dir: finalDir,
      reason: `${group.dir} is staged only after ${group.requires}`,
    };
  }
  // A group staged with other rows (the retired ASR pair) is replaced
  // after the new rows are staged and verified, never edited in place.
  const replacing =
    existsSync(finalDir) &&
    aospVoiceGroupNeedsStaging(bundleRoot, group, files);
  if (existsSync(finalDir) && !replacing) {
    if (!lstatSync(finalDir).isDirectory()) {
      throw new Error(
        `[aosp-voice] existing group ${finalDir} is not a directory`,
      );
    }
    let recordedFiles: unknown[] | undefined;
    for (const file of files) {
      let pin = expectedAospVoicePin(file, options.local);
      if (!pin) {
        // Keep the originally authorized local pins when their source directory
        // is no longer attached. Published catalog pins always take precedence.
        if (!recordedFiles) {
          const record = JSON.parse(
            readFileSync(path.join(finalDir, AOSP_VOICE_RECORD), "utf8"),
          ) as {
            schema?: unknown;
            dir?: unknown;
            files?: unknown;
          } | null;
          if (
            record?.schema !== "eliza-mobile-voice-group-v1" ||
            record.dir !== group.dir ||
            !Array.isArray(record.files)
          ) {
            throw new Error(
              `[aosp-voice] existing group ${finalDir} has no valid pin record`,
            );
          }
          recordedFiles = record.files;
        }
        const matches = recordedFiles.filter(
          (row): row is Record<string, unknown> =>
            row !== null &&
            typeof row === "object" &&
            "id" in row &&
            row.id === file.id,
        );
        const row = matches[0];
        if (
          matches.length !== 1 ||
          !row ||
          row.role !== file.role ||
          row.path !== file.path ||
          typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.sha256) ||
          typeof row.bytes !== "number" ||
          !Number.isSafeInteger(row.bytes) ||
          row.bytes <= 0
        ) {
          throw new Error(
            `[aosp-voice] existing ${file.id} has no valid recorded pin`,
          );
        }
        pin = { sha256: row.sha256, bytes: row.bytes };
      }
      const target = aospVoiceGroupTarget(finalDir, group, file);
      const stat = lstatSync(target, { bigint: true });
      // The bootstrap re-runs this for every group whenever any group is
      // missing (and on each TTS request until tts/paradee/ lands), so a
      // file already hashed in this process is not re-hashed (the Phonon-2
      // GGUF is 330 MB) unless its inode, size, mtime or ctime changed.
      const signature = `${pin.sha256}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (verifiedExistingFiles.get(target) === signature) continue;
      verifiedExistingFiles.delete(target);
      if (
        !stat.isFile() ||
        stat.size !== BigInt(pin.bytes) ||
        (await sha256File(target)) !== pin.sha256
      ) {
        throw new Error(
          `[aosp-voice] existing ${file.id} does not match its pin`,
        );
      }
      verifiedExistingFiles.set(target, signature);
    }
    return { status: "present", dir: finalDir };
  }
  const removeStaging =
    options.removeStaging ??
    ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  const plan: Array<{
    file: MobileVoiceFile;
    pin: AospVoicePin;
    localPath: string | null;
  }> = [];
  for (const file of files) {
    const pin = expectedAospVoicePin(file, options.local);
    const candidate = options.local
      ? path.join(options.local.dir, file.path)
      : null;
    const localPath =
      candidate && existsSync(candidate) && lstatSync(candidate).isFile()
        ? candidate
        : null;
    if (!pin) {
      return {
        status: "unavailable",
        dir: finalDir,
        reason: `${file.id} is unpublished and no pinned local copy was supplied (${file.localFrom ?? "owner publish pending"})`,
      };
    }
    if (!localPath && !isPublishedMobileVoiceFile(file)) {
      return {
        status: "unavailable",
        dir: finalDir,
        reason: `${file.id} is unpublished and missing from the local source`,
      };
    }
    plan.push({ file, pin, localPath });
  }
  const stagingDir = `${finalDir}.staging`;
  removeStaging(stagingDir);
  mkdirSync(stagingDir, { recursive: true });
  try {
    const record: Array<Record<string, unknown>> = [];
    for (const { file, pin, localPath } of plan) {
      const target = aospVoiceGroupTarget(stagingDir, group, file);
      mkdirSync(path.dirname(target), { recursive: true });
      if (localPath) {
        copyFileSync(localPath, target);
        const bytes = lstatSync(target).size;
        const sha256 = await sha256File(target);
        if (bytes !== pin.bytes || sha256 !== pin.sha256) {
          throw new Error(
            `[aosp-voice] local ${file.id} does not match its pin (bytes ${bytes}/${pin.bytes}, sha256 ${sha256})`,
          );
        }
      } else if (isPublishedMobileVoiceFile(file)) {
        await downloadAospVoiceAsset(
          { url: file.url, sha256: file.sha256, sizeBytes: file.bytes },
          target,
          options,
        );
      }
      record.push({
        id: file.id,
        role: file.role,
        path: file.path,
        sha256: pin.sha256,
        bytes: pin.bytes,
        license: file.license,
        origin: localPath ? "local" : "download",
        status: file.status,
        revision: file.revision,
      });
    }
    writeFileSync(
      path.join(stagingDir, AOSP_VOICE_RECORD),
      `${JSON.stringify({ schema: "eliza-mobile-voice-group-v1", dir: group.dir, files: record }, null, 2)}\n`,
    );
    mkdirSync(path.dirname(finalDir), { recursive: true });
    if (replacing) {
      // Both renames stay inside the bundle; a reader sees the old group or
      // the new one. The retired dir ends in `.staging` so the guarded
      // remover accepts it.
      const retiredDir = `${finalDir}.retired.staging`;
      removeStaging(retiredDir);
      renameSync(finalDir, retiredDir);
      renameSync(stagingDir, finalDir);
      removeStaging(retiredDir);
    } else {
      renameSync(stagingDir, finalDir);
    }
    return { status: "staged", dir: finalDir };
  } catch (err) {
    removeStaging(stagingDir);
    throw err;
  }
}

/** Absolute path of the staged Phonon-2 ASR GGUF. */
export function aospAsrModelPath(bundleRoot: string): string {
  const file = aospVoiceFiles().find((f) => f.role === "asr-parakeet");
  if (!file) throw new Error("[aosp-voice] no asr-parakeet row");
  return path.join(bundleRoot, file.path);
}

/**
 * The directory to pass to libelizainference as the eSpeak NG data location
 * (`<bundleRoot>/tts/paradee`, which contains `espeak-ng-data/`), or null when
 * the eSpeak group is not staged. Without it misaki spells out words outside
 * its lexicon.
 */
export function aospEspeakDataParent(
  bundleRoot: string,
  files: ReadonlyArray<MobileVoiceFile> = aospVoiceFiles(),
): string | null {
  const groupDir = path.join(bundleRoot, AOSP_ESPEAK_GROUP.dir);
  const rows = aospVoiceGroupFiles(AOSP_ESPEAK_GROUP, files);
  if (aospVoiceGroupNeedsStaging(bundleRoot, AOSP_ESPEAK_GROUP, files))
    return null;
  // A group without a record is not one this module staged.
  if (!readAospVoiceGroupRecordIds(groupDir, AOSP_ESPEAK_GROUP)) return null;
  for (const file of rows) {
    if (!existsSync(aospVoiceGroupTarget(groupDir, AOSP_ESPEAK_GROUP, file)))
      return null;
  }
  return path.dirname(groupDir);
}

/** Absolute paths of the Paradee files inside a staged `tts/paradee/` group. */
export function aospParadeePaths(bundleRoot: string): {
  dir: string;
  gguf: string;
  lexicon: string;
} {
  const group = AOSP_VOICE_GROUPS[0] as AospVoiceGroup;
  const files = aospVoiceGroupFiles(group);
  const dir = path.join(bundleRoot, group.dir);
  const byRole = (role: MobileVoiceFileRole) => {
    const file = files.find((f) => f.role === role);
    if (!file) throw new Error(`[aosp-voice] no ${role} row`);
    return path.join(dir, path.posix.basename(file.path));
  };
  return { dir, gguf: byRole("tts"), lexicon: byRole("g2p-lexicon") };
}
