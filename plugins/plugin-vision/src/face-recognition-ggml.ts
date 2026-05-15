// face-recognition-ggml.ts — EXPERIMENTAL.
//
// bun:ffi binding for the face-embedding head exposed by the standalone
// `packages/native-plugins/face-cpp/` library. This is the ggml-backed
// replacement for `face-recognition.ts` (face-api.js, deprecated). It
// exposes a parallel surface — `FaceRecognitionGgml` mirrors `FaceRecognition`
// for `recognizeFace`, `addOrUpdateFace`, `getFaceProfile`, `getAllProfiles`,
// `saveFaceLibrary`, `loadFaceLibrary` — so existing callers can migrate
// behind the planned `setFaceBackend("ggml")` toggle without touching them.
//
// EXPERIMENTAL: the C ABI is frozen but the model entries
// (`face_embed_open`, `face_embed`) currently return `-ENOSYS` from the
// stub. `FaceRecognitionGgml.isAvailable()` returns false until both the
// compiled `libface.<so|dylib|dll>` AND the embedder GGUF artifact exist.
// `embedFace()` throws a typed `FaceCppUnavailableError({ code: "stub" })`
// when the C ABI surfaces `-ENOSYS`. Real model wiring lands with the
// face-cpp port (see `packages/native-plugins/face-cpp/AGENTS.md`).
//
// This binding intentionally does NOT couple to `face-detector-mediapipe.ts`
// or `face-recognition.ts` — both are read-only here. Callers feed in
// detections produced by `BlazeFaceGgmlDetector` (`face-detector-ggml.ts`)
// which carry the 6 BlazeFace keypoints the embedder uses for alignment.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";
import type { FaceLibrary, FaceProfile } from "./types";
import type { MediaPipeFaceDetection } from "./face-detector-ggml";

const MODULE_TAG = "[FaceRecognitionGgml]";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mirrors include/face/face.h. Keep these in sync with the header — the C
// side validates struct sizing on its end; mismatches here produce wrong
// embeddings rather than a load failure.
const FACE_EMBED_DIM = 128;
const FACE_DETECTOR_KEYPOINT_COUNT = 6;
const FACE_DETECTION_FLOATS = 5 + FACE_DETECTOR_KEYPOINT_COUNT * 2; // 17

// Linux errno for ENOSYS (function not implemented). The C ABI returns
// `-ENOSYS` from the stub; this is the value bun:ffi surfaces back as a
// negative int32. macOS uses ENOSYS=78 — we accept either.
const RC_ENOSYS_LINUX = -38;
const RC_ENOSYS_MACOS = -78;

/**
 * Typed error surfaced when the face-cpp library is loadable but its
 * model entries return `-ENOSYS`. Callers should branch on `code` to
 * decide whether to fall back to a different backend or surface an
 * actionable diagnostic.
 */
export class FaceCppUnavailableError extends Error {
  public readonly code: "stub" | "missing-library" | "missing-gguf";
  constructor(opts: {
    code: "stub" | "missing-library" | "missing-gguf";
    message?: string;
  }) {
    super(
      opts.message ??
        `face-cpp embedder unavailable (code=${opts.code}). See packages/native-plugins/face-cpp/AGENTS.md.`,
    );
    this.name = "FaceCppUnavailableError";
    this.code = opts.code;
  }
}

function defaultLibraryPath(): string {
  const ext =
    process.platform === "darwin"
      ? "dylib"
      : process.platform === "win32"
        ? "dll"
        : "so";
  return (
    process.env.ELIZA_FACE_CPP_LIB ??
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "packages",
      "native-plugins",
      "face-cpp",
      "build",
      `libface.${ext}`,
    )
  );
}

function defaultModelDir(): string {
  const stateDir =
    process.env.ELIZA_STATE_DIR ??
    path.join(process.env.HOME ?? "/tmp", ".milady");
  return path.join(stateDir, "models", "face-cpp");
}

function defaultEmbedWeightsPath(): string {
  return (
    process.env.ELIZA_FACE_CPP_EMBED_GGUF ??
    path.join(defaultModelDir(), "face_embed.gguf")
  );
}

/**
 * Minimal structural type for the bun:ffi pieces we need. Keeps this
 * file typecheckable under plain Node tsc without `bun-types` resolved
 * on every downstream consumer (same trick `face-detector-ggml.ts` uses).
 */
interface BunFFIModule {
  dlopen: (
    p: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ) => {
    symbols: Record<string, (...args: unknown[]) => unknown>;
  };
  FFIType: Record<
    "cstring" | "pointer" | "i32" | "void" | "f32" | "u8" | "u32",
    number
  >;
  ptr: (typedArray: ArrayBufferView) => unknown;
  CString: new (raw: unknown) => { toString(): string };
}

interface FaceEmbedBindings {
  open(ggufPath: string): unknown;
  embed(
    handle: unknown,
    rgb: Buffer,
    w: number,
    h: number,
    stride: number,
    detectionRecord: Float32Array,
  ): Float32Array;
  close(handle: unknown): void;
  cosineDistance(a: Float32Array, b: Float32Array): number;
  l2Distance(a: Float32Array, b: Float32Array): number;
}

let bindingsPromise: Promise<FaceEmbedBindings | null> | null = null;

async function loadBindings(): Promise<FaceEmbedBindings | null> {
  if (bindingsPromise) return bindingsPromise;
  bindingsPromise = (async (): Promise<FaceEmbedBindings | null> => {
    const libPath = defaultLibraryPath();
    try {
      await fs.access(libPath);
    } catch {
      logger.warn(`${MODULE_TAG} native library not found at ${libPath}`);
      return null;
    }

    let bunFFI: BunFFIModule | null = null;
    try {
      const dynImport = new Function("spec", "return import(spec)") as (
        s: string,
      ) => Promise<BunFFIModule>;
      bunFFI = await dynImport("bun:ffi");
    } catch {
      logger.warn(
        `${MODULE_TAG} bun:ffi unavailable — face-cpp requires bun runtime.`,
      );
      return null;
    }

    const { dlopen, FFIType, ptr } = bunFFI;

    let lib;
    try {
      lib = dlopen(libPath, {
        face_embed_open: {
          args: [FFIType.cstring, FFIType.pointer],
          returns: FFIType.i32,
        },
        face_embed: {
          args: [
            FFIType.pointer,
            FFIType.pointer,
            FFIType.i32,
            FFIType.i32,
            FFIType.i32,
            FFIType.pointer,
            FFIType.pointer,
          ],
          returns: FFIType.i32,
        },
        face_embed_close: {
          args: [FFIType.pointer],
          returns: FFIType.i32,
        },
        face_embed_distance: {
          args: [FFIType.pointer, FFIType.pointer],
          returns: FFIType.f32,
        },
        face_embed_distance_l2: {
          args: [FFIType.pointer, FFIType.pointer],
          returns: FFIType.f32,
        },
      });
    } catch (error) {
      logger.warn(
        `${MODULE_TAG} dlopen failed for ${libPath}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }

    const bindings: FaceEmbedBindings = {
      open(ggufPath) {
        const cstr = Buffer.from(ggufPath + "\0", "utf-8");
        const handleSlot = new BigUint64Array(1);
        const rc = lib.symbols.face_embed_open(
          ptr(cstr) as never,
          ptr(handleSlot) as never,
        ) as number;
        if (rc === RC_ENOSYS_LINUX || rc === RC_ENOSYS_MACOS) {
          throw new FaceCppUnavailableError({ code: "stub" });
        }
        if (rc !== 0) {
          throw new Error(
            `face_embed_open failed (rc=${rc}) — GGUF likely missing or shape mismatch.`,
          );
        }
        return handleSlot[0];
      },
      embed(handle, rgb, w, h, stride, detectionRecord) {
        // The C-side `face_embed` takes a `face_detection*` whose layout
        // matches a 17-float record (5 + 6 keypoint pairs). We pass the
        // already-packed Float32Array directly.
        if (detectionRecord.length < FACE_DETECTION_FLOATS) {
          throw new Error(
            `${MODULE_TAG} detection record too small: ${detectionRecord.length} < ${FACE_DETECTION_FLOATS}`,
          );
        }
        const out = new Float32Array(FACE_EMBED_DIM);
        const rc = lib.symbols.face_embed(
          handle as never,
          ptr(rgb) as never,
          w,
          h,
          stride,
          ptr(detectionRecord) as never,
          ptr(out) as never,
        ) as number;
        if (rc === RC_ENOSYS_LINUX || rc === RC_ENOSYS_MACOS) {
          throw new FaceCppUnavailableError({ code: "stub" });
        }
        if (rc !== 0) {
          throw new Error(`face_embed failed (rc=${rc}).`);
        }
        return out;
      },
      close(handle) {
        lib.symbols.face_embed_close(handle as never);
      },
      cosineDistance(a, b) {
        if (a.length !== FACE_EMBED_DIM || b.length !== FACE_EMBED_DIM) {
          throw new Error(
            `${MODULE_TAG} embeddings must be ${FACE_EMBED_DIM}-d.`,
          );
        }
        return lib.symbols.face_embed_distance(
          ptr(a) as never,
          ptr(b) as never,
        ) as number;
      },
      l2Distance(a, b) {
        if (a.length !== FACE_EMBED_DIM || b.length !== FACE_EMBED_DIM) {
          throw new Error(
            `${MODULE_TAG} embeddings must be ${FACE_EMBED_DIM}-d.`,
          );
        }
        return lib.symbols.face_embed_distance_l2(
          ptr(a) as never,
          ptr(b) as never,
        ) as number;
      },
    };
    return bindings;
  })();
  return bindingsPromise;
}

/**
 * Pack a `MediaPipeFaceDetection` (output of `BlazeFaceGgmlDetector`)
 * into the 17-float layout the C ABI expects (mirrors `face_detection`
 * in include/face/face.h).
 */
function packDetection(det: MediaPipeFaceDetection): Float32Array {
  const out = new Float32Array(FACE_DETECTION_FLOATS);
  out[0] = det.bbox.x;
  out[1] = det.bbox.y;
  out[2] = det.bbox.width;
  out[3] = det.bbox.height;
  out[4] = det.confidence;
  const kps = det.keypoints ?? [];
  for (let i = 0; i < FACE_DETECTOR_KEYPOINT_COUNT; i++) {
    const kp = kps[i];
    out[5 + i * 2 + 0] = kp ? kp.x : 0;
    out[5 + i * 2 + 1] = kp ? kp.y : 0;
  }
  return out;
}

/**
 * EXPERIMENTAL ggml-backed face-recognition store. Mirrors
 * `FaceRecognition` (face-api.js) for the parts that don't depend on
 * `canvas` / `face-api.js`: cosine matching, profile bookkeeping,
 * persistence. Detection + embedding go through `face-cpp` via
 * `BlazeFaceGgmlDetector` and this class.
 *
 * Currently disabled (`isAvailable()` returns `false`) until the
 * face-cpp model entries graduate from the ENOSYS stub and a face
 * embedder GGUF artifact lands.
 */
export class FaceRecognitionGgml {
  private bindings: FaceEmbedBindings | null = null;
  private handle: unknown = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private faceLibrary: FaceLibrary = {
    faces: new Map(),
    embeddings: new Map(),
  };

  // Cosine-distance threshold. ArcFace / FaceNet embedders typically
  // place same-identity pairs around 0.2–0.4 and different identities
  // above 0.6. We start at the conservative 0.5 cutoff used by
  // insightface's own demos.
  private readonly FACE_MATCH_THRESHOLD = 0.5;

  /**
   * `true` only when both the native library AND the embedder GGUF
   * weights are on disk. Loading happens lazily in `initialize()`.
   */
  static async isAvailable(): Promise<boolean> {
    const libPath = defaultLibraryPath();
    try {
      await fs.access(libPath);
    } catch {
      return false;
    }
    try {
      await fs.access(defaultEmbedWeightsPath());
    } catch {
      return false;
    }
    const bindings = await loadBindings();
    return Boolean(bindings);
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    this.bindings = await loadBindings();
    if (!this.bindings) {
      throw new FaceCppUnavailableError({
        code: "missing-library",
        message: `${MODULE_TAG} face-cpp library unavailable; build packages/native-plugins/face-cpp first.`,
      });
    }
    const ggufPath = defaultEmbedWeightsPath();
    try {
      await fs.access(ggufPath);
    } catch {
      throw new FaceCppUnavailableError({
        code: "missing-gguf",
        message: `${MODULE_TAG} embedder GGUF missing at ${ggufPath} — see scripts/face_embed_to_gguf.py.`,
      });
    }
    this.handle = this.bindings.open(ggufPath);
    this.initialized = true;
    logger.info(`${MODULE_TAG} initialized`);
  }

  /**
   * Compute a 128-d L2-normalized embedding for one detection.
   * Surfaces `FaceCppUnavailableError({ code: "stub" })` when the C ABI
   * returns `-ENOSYS` (i.e. the model entries have not been wired yet).
   */
  async embedFace(
    rgb: Buffer,
    width: number,
    height: number,
    detection: MediaPipeFaceDetection,
  ): Promise<Float32Array> {
    if (!this.initialized) await this.initialize();
    if (!this.bindings || !this.handle) {
      throw new FaceCppUnavailableError({ code: "missing-library" });
    }
    const det = packDetection(detection);
    return this.bindings.embed(
      this.handle,
      rgb,
      width,
      height,
      width * 3,
      det,
    );
  }

  /** Cosine distance between two 128-d embeddings via the C helper. */
  cosineDistance(a: Float32Array, b: Float32Array): number {
    if (!this.bindings) {
      throw new FaceCppUnavailableError({ code: "missing-library" });
    }
    return this.bindings.cosineDistance(a, b);
  }

  async recognizeFace(
    descriptor: Float32Array,
  ): Promise<{ profileId: string; distance: number } | null> {
    let bestMatch: { profileId: string; distance: number } | null = null;
    let minDistance = Infinity;

    for (const [profileId, embeddings] of this.faceLibrary.embeddings) {
      for (const known of embeddings) {
        const distance = this.cosineDistanceJs(descriptor, known);
        if (distance < this.FACE_MATCH_THRESHOLD && distance < minDistance) {
          minDistance = distance;
          bestMatch = { profileId, distance };
        }
      }
    }
    return bestMatch;
  }

  async addOrUpdateFace(
    descriptor: Float32Array,
    attributes?: Partial<FaceProfile>,
  ): Promise<string> {
    const match = await this.recognizeFace(descriptor);
    if (match) {
      const profile = this.faceLibrary.faces.get(match.profileId);
      if (!profile) {
        throw new Error(
          `${MODULE_TAG} profile not found for matched profileId: ${match.profileId}`,
        );
      }
      profile.lastSeen = Date.now();
      profile.seenCount++;

      const embeddings = this.faceLibrary.embeddings.get(match.profileId);
      if (!embeddings) {
        throw new Error(
          `${MODULE_TAG} embeddings not found for matched profileId: ${match.profileId}`,
        );
      }
      if (embeddings.length < 10) {
        embeddings.push(Array.from(descriptor));
      }
      if (attributes) {
        Object.assign(profile, attributes);
      }
      return match.profileId;
    }

    const profileId = `face-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const profile: FaceProfile = {
      id: profileId,
      embeddings: [Array.from(descriptor)],
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      seenCount: 1,
      ...attributes,
    };
    this.faceLibrary.faces.set(profileId, profile);
    this.faceLibrary.embeddings.set(profileId, [Array.from(descriptor)]);
    logger.info(`${MODULE_TAG} new face registered: ${profileId}`);
    return profileId;
  }

  getFaceProfile(profileId: string): FaceProfile | undefined {
    return this.faceLibrary.faces.get(profileId);
  }

  getAllProfiles(): FaceProfile[] {
    return Array.from(this.faceLibrary.faces.values());
  }

  async saveFaceLibrary(filePath: string): Promise<void> {
    const data = {
      faces: Array.from(this.faceLibrary.faces.entries()),
      embeddings: Array.from(this.faceLibrary.embeddings.entries()),
    };
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2));
    logger.info(`${MODULE_TAG} face library saved to ${filePath}`);
  }

  async loadFaceLibrary(filePath: string): Promise<void> {
    const fsp = await import("node:fs/promises");
    const data = JSON.parse(await fsp.readFile(filePath, "utf-8"));
    this.faceLibrary.faces = new Map(data.faces);
    this.faceLibrary.embeddings = new Map(data.embeddings);
    logger.info(
      `${MODULE_TAG} loaded ${this.faceLibrary.faces.size} face profiles`,
    );
  }

  async dispose(): Promise<void> {
    if (this.bindings && this.handle) {
      this.bindings.close(this.handle);
    }
    this.handle = null;
    this.initialized = false;
    this.initPromise = null;
    logger.debug(`${MODULE_TAG} disposed`);
  }

  // Pure-JS fallback for cosine distance against stored number[] arrays.
  // The C helper is only invoked between two Float32Arrays both produced
  // by the embedder; persisted embeddings come back as plain number[].
  private cosineDistanceJs(
    a: Float32Array | number[],
    b: number[] | Float32Array,
  ): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i] as number;
      const y = b[i] as number;
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (denom === 0) return 1;
    return 1 - dot / denom;
  }
}
