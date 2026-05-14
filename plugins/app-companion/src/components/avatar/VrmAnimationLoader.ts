import type { VRM } from "@pixiv/three-vrm";
import type * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { retargetMixamoFbxToVrm } from "./retargetMixamoFbxToVrm";
import { retargetMixamoGltfToVrm } from "./retargetMixamoGltfToVrm";

/**
 * Context needed by the animation loader to check whether the owning engine
 * is still alive / relevant for the load request.
 */
export type AnimationLoaderContext = {
  /** Returns `true` if the loading sequence was aborted (engine disposed). */
  isAborted: () => boolean;
  /** Returns `true` if `vrm` is still the active model in the engine. */
  isCurrentVrm: (vrm: VRM) => boolean;
};

function isGzipBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 2) return false;
  const bytes = new Uint8Array(buffer, 0, 2);
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function decompressGzipBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof DecompressionStream !== "function") {
    throw new Error(
      "This runtime does not support gzip-compressed animation assets.",
    );
  }

  const stream = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

async function fetchAnimationBuffer(path: string): Promise<ArrayBuffer> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to fetch animation asset: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  return isGzipBuffer(buffer) ? await decompressGzipBuffer(buffer) : buffer;
}

function getAssetResourcePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? path;
  const lastSlash = withoutQuery.lastIndexOf("/");
  return lastSlash >= 0 ? withoutQuery.slice(0, lastSlash + 1) : "./";
}

function isFbxAsset(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.endsWith(".fbx") || normalized.endsWith(".fbx.gz");
}

/**
 * Load and return an idle {@link THREE.AnimationClip} for the given VRM.
 *
 * Loads the GLB idle animation and retargets it to VRM bones.
 * Returns `null` when the load was aborted (engine disposed / VRM replaced).
 * Throws when the idle clip cannot be loaded.
 */
export async function loadIdleClip(
  vrm: VRM,
  idleGlbUrl: string,
  ctx: AnimationLoaderContext,
): Promise<THREE.AnimationClip | null> {
  if (ctx.isAborted() || !ctx.isCurrentVrm(vrm)) return null;

  const gltfLoader = new GLTFLoader();
  const gltf = await gltfLoader.parseAsync(
    await fetchAnimationBuffer(idleGlbUrl),
    getAssetResourcePath(idleGlbUrl),
  );
  if (ctx.isAborted() || !ctx.isCurrentVrm(vrm)) return null;

  gltf.scene.updateMatrixWorld(true);
  vrm.scene.updateMatrixWorld(true);
  const clip = retargetMixamoGltfToVrm(
    { scene: gltf.scene, animations: gltf.animations },
    vrm,
  );

  if (!clip) {
    throw new Error("No usable idle animation (idle.glb)");
  }

  if (ctx.isAborted() || !ctx.isCurrentVrm(vrm)) return null;
  return clip;
}

/**
 * Load a single emote animation clip (GLB/FBX) and retarget it to
 * the supplied VRM. Returns `null` when the load was aborted or the file
 * format could not be processed.
 *
 * Supports both `.glb` / `.gltf` files (retargeted via retargetMixamoGltfToVrm)
 * and Mixamo `.fbx` files (retargeted via retargetMixamoFbxToVrm).
 */
export async function loadEmoteClip(
  path: string,
  vrm: VRM,
  ctx: AnimationLoaderContext,
): Promise<THREE.AnimationClip | null> {
  try {
    if (!ctx.isCurrentVrm(vrm)) return null;

    const isFbx = isFbxAsset(path);

    if (isFbx) {
      const fbxLoader = new FBXLoader();
      const fbx = fbxLoader.parse(
        await fetchAnimationBuffer(path),
        getAssetResourcePath(path),
      );
      if (!ctx.isCurrentVrm(vrm)) return null;

      const sourceClip = fbx.animations[0];
      if (!sourceClip) {
        console.warn(`[VrmEngine] FBX has no animations: ${path}`);
        return null;
      }
      const retargeted = retargetMixamoFbxToVrm(fbx, sourceClip, vrm);
      return retargeted;
    }

    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(
      await fetchAnimationBuffer(path),
      getAssetResourcePath(path),
    );
    if (!ctx.isCurrentVrm(vrm)) return null;

    gltf.scene.updateMatrixWorld(true);
    vrm.scene.updateMatrixWorld(true);
    return retargetMixamoGltfToVrm(
      { scene: gltf.scene, animations: gltf.animations },
      vrm,
    );
  } catch (err) {
    console.error(`[VrmEngine] Failed to load emote: ${path}`, err);
    return null;
  }
}
