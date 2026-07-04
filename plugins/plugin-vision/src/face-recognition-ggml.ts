/**
 * Native ggml face-recognition pipeline for detection, embedding, matching,
 * and in-memory identity storage.
 *
 * The native library produces 128-dimensional L2-normalized embeddings from
 * BlazeFace detections. `FaceEmbedGgmlRecognizer` owns only embedding; matching
 * and persistence live in `FaceRecognition`. There is no tfjs or face-api
 * fallback path.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";
import {
  BlazeFaceGgmlDetector,
  type MediaPipeFaceDetection,
} from "./face-detector-ggml";
import { getSharp } from "./image/sharp-compat";
import type { BoundingBox, FaceLibrary, FaceProfile } from "./types";

const MODULE_TAG = "[FaceEmbedGgml]";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FACE_DETECTOR_KEYPOINT_COUNT = 6;
const FACE_DETECTION_FLOATS = 5 + FACE_DETECTOR_KEYPOINT_COUNT * 2; // 17
const FACE_EMBED_DIM = 128;

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
    process.env.ELIZA_STATE_DIR ?? path.join(os.homedir(), ".eliza");
  return path.join(stateDir, "models", "face-cpp");
}

function defaultEmbedWeightsPath(): string {
  return (
    process.env.ELIZA_FACE_CPP_EMBED_GGUF ??
    path.join(defaultModelDir(), "face_embed.gguf")
  );
}

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
    detection: MediaPipeFaceDetection,
  ): Float32Array;
  close(handle: unknown): void;
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

    let lib: ReturnType<BunFFIModule["dlopen"]>;
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
      });
    } catch (error) {
      logger.warn(
        `${MODULE_TAG} dlopen failed for ${libPath}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }

    const bindings: FaceEmbedBindings = {
      open(ggufPath) {
        const cstr = Buffer.from(`${ggufPath}\0`, "utf-8");
        const handleSlot = new BigUint64Array(1);
        const rc = lib.symbols.face_embed_open(
          ptr(cstr) as never,
          ptr(handleSlot) as never,
        ) as number;
        if (rc !== 0) {
          throw new Error(
            `face_embed_open failed (rc=${rc}) — GGUF likely missing or invalid.`,
          );
        }
        const handle = handleSlot[0];
        if (handle === 0n) {
          throw new Error("face_embed_open returned NULL handle");
        }
        // bun:ffi pointer-typed args expect a Number, not a BigInt.
        return Number(handle);
      },
      embed(handle, rgb, w, h, stride, detection) {
        // Pack a face_detection record into a 17-float buffer matching
        // the C struct layout: x, y, w, h, conf, then 12 landmark floats.
        const det = new Float32Array(FACE_DETECTION_FLOATS);
        det[0] = detection.bbox.x;
        det[1] = detection.bbox.y;
        det[2] = detection.bbox.width;
        det[3] = detection.bbox.height;
        det[4] = detection.confidence;
        const kps = detection.keypoints ?? [];
        for (let i = 0; i < FACE_DETECTOR_KEYPOINT_COUNT; i++) {
          const kp = kps[i];
          det[5 + i * 2 + 0] = kp ? kp.x : 0;
          det[5 + i * 2 + 1] = kp ? kp.y : 0;
        }
        const out = new Float32Array(FACE_EMBED_DIM);
        const rc = lib.symbols.face_embed(
          handle as never,
          ptr(rgb) as never,
          w,
          h,
          stride,
          ptr(det) as never,
          ptr(out) as never,
        ) as number;
        if (rc !== 0) {
          throw new Error(`face_embed failed (rc=${rc}).`);
        }
        return out;
      },
      close(handle) {
        lib.symbols.face_embed_close(handle as never);
      },
    };
    return bindings;
  })();
  return bindingsPromise;
}

/**
 * Configuration for the ggml-backed face embedder.
 */
export interface FaceEmbedGgmlConfig {
  modelPath?: string;
  modelDir?: string;
}

/**
 * Cosine distance between two 128-d unit-norm embeddings. Matches
 * `face_embed_distance` in the C library: 0 for identical, 1 for
 * orthogonal, 2 for antipodal.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`embedding length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  if (dot > 1) dot = 1;
  if (dot < -1) dot = -1;
  return 1 - dot;
}

/**
 * L2 distance between two 128-d embeddings. For unit-norm inputs this
 * is sqrt(2 - 2*dot(a, b)), in [0, 2].
 */
export function l2Distance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`embedding length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * ggml-backed 128-d face embedder: a 128-d L2-normalized descriptor per
 * detected face, consumed by the `FaceRecognition` class below.
 */
export class FaceEmbedGgmlRecognizer {
  private readonly cfg: FaceEmbedGgmlConfig & { modelDir: string };
  private bindings: FaceEmbedBindings | null = null;
  private handle: unknown = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(config: FaceEmbedGgmlConfig = {}) {
    this.cfg = {
      modelDir: config.modelDir ?? defaultModelDir(),
      ...config,
    };
  }

  /**
   * `true` only when both the native library AND the GGUF weights are
   * on disk.
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
      throw new Error(
        `${MODULE_TAG} face-cpp library unavailable; build packages/native/plugins/face-cpp first.`,
      );
    }
    const ggufPath = this.cfg.modelPath ?? defaultEmbedWeightsPath();
    try {
      await fs.access(ggufPath);
    } catch {
      throw new Error(
        `${MODULE_TAG} face-embed GGUF missing at ${ggufPath} — see scripts/face_embed_to_gguf.py.`,
      );
    }
    this.handle = this.bindings.open(ggufPath);
    this.initialized = true;
    logger.info(`${MODULE_TAG} initialized`);
  }

  /**
   * Compute a 128-d L2-normalized face embedding from an RGB(A) image
   * buffer plus a detection record (bbox + BlazeFace landmarks).
   *
   * The image is decoded via sharp; pass any sharp-supported format
   * (PNG, JPEG, raw). `detection` should come from
   * `BlazeFaceGgmlDetector` so the keypoints already match the
   * BlazeFace order.
   */
  async embed(
    imageBuffer: Buffer,
    detection: MediaPipeFaceDetection,
  ): Promise<Float32Array> {
    if (!this.initialized) await this.initialize();
    if (!this.bindings || !this.handle) {
      throw new Error(`${MODULE_TAG} not initialized`);
    }

    const sharp = await getSharp();
    const meta = await sharp(imageBuffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) {
      throw new Error(`${MODULE_TAG} sharp could not determine image size`);
    }

    const { data: rgb } = await sharp(imageBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return this.bindings.embed(this.handle, rgb, w, h, w * 3, detection);
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
}

const FACE_REC_TAG = "[FaceRecognition]";

/**
 * A detected face: a native BlazeFace detection plus its 128-d ggml
 * embedding. Mirrors the fields `VisionService` reads off each result.
 * The native backend produces no expression / age-gender estimates, so
 * those attributes are left to higher layers.
 */
export interface DetectedFace {
  detection: { box: BoundingBox };
  descriptor: Float32Array;
}

/**
 * Native ggml face recognition: BlazeFace detection + 128-d embedding +
 * in-memory matching and persistence. When the native `libface` library
 * or its GGUF weights are not on disk, detection returns an empty list
 * (recognition is disabled, never faked). Matching and storage are pure
 * JS and always available.
 */
export class FaceRecognition {
  private readonly detector = new BlazeFaceGgmlDetector();
  private readonly embedder = new FaceEmbedGgmlRecognizer();
  private detectorAvailable: boolean | null = null;
  private readonly faceLibrary: FaceLibrary = {
    faces: new Map(),
    embeddings: new Map(),
  };

  // Euclidean distance threshold for a face match.
  private readonly FACE_MATCH_THRESHOLD = 0.6;
  // Minimum face size in pixels.
  private readonly MIN_FACE_SIZE = 50;

  /**
   * Detect faces in a raw RGBA frame and compute an embedding for each.
   * Returns an empty list when the native face backend is unavailable.
   */
  async detectFaces(
    imageData: Buffer,
    width: number,
    height: number,
  ): Promise<DetectedFace[]> {
    if (!imageData || imageData.length === 0 || width <= 0 || height <= 0) {
      logger.warn(
        `${FACE_REC_TAG} Invalid input parameters: dataLength=${imageData?.length ?? 0}, width=${width}, height=${height}`,
      );
      return [];
    }

    const expectedSize = width * height * 4; // RGBA
    if (imageData.length !== expectedSize) {
      logger.warn(
        `${FACE_REC_TAG} Buffer size mismatch: expected=${expectedSize}, actual=${imageData.length}, width=${width}, height=${height}`,
      );
      return [];
    }

    if (this.detectorAvailable === null) {
      this.detectorAvailable = await BlazeFaceGgmlDetector.isAvailable();
      if (!this.detectorAvailable) {
        logger.warn(
          `${FACE_REC_TAG} face recognition unavailable (native face-cpp library not built)`,
        );
      }
    }
    if (!this.detectorAvailable) return [];

    // BlazeFace + the embedder both decode via sharp, so wrap the raw
    // RGBA frame in a sharp-readable PNG once and reuse it for both.
    const sharp = await getSharp();
    const png = await sharp(imageData, {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();

    const detections = await this.detector.detect(png);

    const faces: DetectedFace[] = [];
    for (const det of detections) {
      const { width: bw, height: bh } = det.bbox;
      if (bw < this.MIN_FACE_SIZE || bh < this.MIN_FACE_SIZE) continue;
      const descriptor = await this.embedder.embed(png, det);
      faces.push({ detection: { box: det.bbox }, descriptor });
    }
    return faces;
  }

  async recognizeFace(
    descriptor: Float32Array,
  ): Promise<{ profileId: string; distance: number } | null> {
    let bestMatch: { profileId: string; distance: number } | null = null;
    let minDistance = Number.POSITIVE_INFINITY;

    for (const [profileId, embeddings] of this.faceLibrary.embeddings) {
      for (const knownEmbedding of embeddings) {
        const distance = euclideanDistance(descriptor, knownEmbedding);
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
          `Profile not found for matched profileId: ${match.profileId}`,
        );
      }
      profile.lastSeen = Date.now();
      profile.seenCount++;

      const embeddings = this.faceLibrary.embeddings.get(match.profileId);
      if (!embeddings) {
        throw new Error(
          `Embeddings not found for matched profileId: ${match.profileId}`,
        );
      }
      // Keep up to 10 embeddings per person for robustness.
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

    logger.info(`${FACE_REC_TAG} New face registered: ${profileId}`);
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
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    logger.info(`${FACE_REC_TAG} Face library saved to ${filePath}`);
  }

  async loadFaceLibrary(filePath: string): Promise<void> {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as {
      faces: [string, FaceProfile][];
      embeddings: [string, number[][]][];
    };
    this.faceLibrary.faces = new Map(data.faces);
    this.faceLibrary.embeddings = new Map(data.embeddings);
    logger.info(
      `${FACE_REC_TAG} Loaded ${this.faceLibrary.faces.size} face profiles`,
    );
  }

  async dispose(): Promise<void> {
    await this.detector.dispose();
    await this.embedder.dispose();
  }
}

function euclideanDistance(a: Float32Array, b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}
