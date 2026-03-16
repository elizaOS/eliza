import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { VRMHumanBoneName } from "@pixiv/three-vrm";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { mixamoVRMRigMap } from "./mixamoVRMRigMap";

function isVrm0(vrm: VRM): boolean {
  const mv = String(vrm.meta?.metaVersion ?? "");
  // three-vrm may report "0", "0.0", or similar for VRM0
  return mv.startsWith("0");
}

function normalizeMixamoRigName(name: string): string {
  // Common Mixamo namespaces:
  // - "mixamorigHips"
  // - "mixamorig:Hips"  -> "mixamorigHips"
  // - "Armature|mixamorigHips" (rare in some exports)
  const pipe = name.lastIndexOf("|");
  const base = pipe >= 0 ? name.slice(pipe + 1) : name;
  const colon = base.indexOf(":");
  if (colon >= 0) {
    const ns = base.slice(0, colon);
    const rest = base.slice(colon + 1);
    if (ns === "mixamorig") return `mixamorig${rest}`;
    return rest;
  }
  return base;
}

function findObjectByNameVariants(asset: THREE.Object3D, rawName: string): THREE.Object3D | null {
  const candidates = new Set<string>([
    rawName,
    normalizeMixamoRigName(rawName),
    // If we normalized to "mixamorigHips", also try "mixamorig:Hips"
    rawName.includes(":") ? rawName.split(":")[1] ?? rawName : rawName,
  ]);

  // Fast path
  for (const name of candidates) {
    const obj = asset.getObjectByName(name);
    if (obj) return obj;
  }

  // Slow path: traverse and match by suffix (handles nested names like "Armature|mixamorigHips")
  let found: THREE.Object3D | null = null;
  asset.traverse((obj) => {
    if (found) return;
    for (const name of candidates) {
      if (obj.name === name || obj.name.endsWith(`|${name}`)) {
        found = obj;
        return;
      }
    }
  });
  return found;
}

function getHipsHeightFromFbx(asset: THREE.Group): number {
  const hips =
    findObjectByNameVariants(asset, "mixamorigHips") ??
    findObjectByNameVariants(asset, "mixamorig:Hips") ??
    findObjectByNameVariants(asset, "Hips");
  if (!hips) return 1;
  const hipsPos = new THREE.Vector3();
  const rootPos = new THREE.Vector3();
  hips.getWorldPosition(hipsPos);
  asset.getWorldPosition(rootPos);
  return Math.max(0.001, Math.abs(hipsPos.y - rootPos.y));
}

function getHipsHeightFromVrm(vrm: VRM): number {
  const hipsNode = vrm.humanoid?.getNormalizedBoneNode("hips");
  if (!hipsNode) return 1;
  const hipsPos = new THREE.Vector3();
  const rootPos = new THREE.Vector3();
  hipsNode.getWorldPosition(hipsPos);
  vrm.scene.getWorldPosition(rootPos);
  return Math.max(0.001, Math.abs(hipsPos.y - rootPos.y));
}

/**
 * Load Mixamo-style FBX animation, retarget for three-vrm, and return a VRM-compatible clip.
 */
export async function loadMixamoAnimation(url: string, vrm: VRM): Promise<THREE.AnimationClip> {
  const loader = new FBXLoader();
  const asset = await loader.loadAsync(url);
  const sourceClip =
    THREE.AnimationClip.findByName(asset.animations, "mixamo.com") ?? asset.animations[0];
  if (!sourceClip) {
    throw new Error("FBX contains no animation clips");
  }

  const motionHipsHeight = getHipsHeightFromFbx(asset);
  const vrmHipsHeight = getHipsHeightFromVrm(vrm);
  const hipsPositionScale = vrmHipsHeight / motionHipsHeight;

  const tracks: Array<THREE.QuaternionKeyframeTrack | THREE.VectorKeyframeTrack> = [];
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const q = new THREE.Quaternion();

  const rigNodeCache = new Map<string, THREE.Object3D | null>();

  for (const track of sourceClip.tracks) {
    const splitted = track.name.split(".");
    const rawRigName = splitted[0];
    const propertyName = splitted[1];
    if (!rawRigName || !propertyName) continue;

    const mixamoRigName = normalizeMixamoRigName(rawRigName);
    const vrmBoneName = mixamoVRMRigMap[mixamoRigName];
    if (!vrmBoneName) continue;

    const vrmNode = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName as VRMHumanBoneName);
    if (!vrmNode) continue;

    const vrmNodeName = vrmNode.name;
    if (!rigNodeCache.has(mixamoRigName)) {
      rigNodeCache.set(mixamoRigName, findObjectByNameVariants(asset, rawRigName));
    }
    const mixamoRigNode = rigNodeCache.get(mixamoRigName);
    if (!mixamoRigNode || !mixamoRigNode.parent) continue;

    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
    mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i);
        q.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        q.toArray(values, i);
      }

      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${vrmNodeName}.${propertyName}`,
          track.times,
          values.map((v, i) => (isVrm0(vrm) && i % 2 === 0 ? -v : v)),
        ),
      );
      continue;
    }

    if (track instanceof THREE.VectorKeyframeTrack) {
      const values = track.values.map((v, i) => {
        const signFixed = isVrm0(vrm) && i % 3 !== 1 ? -v : v;
        return signFixed * hipsPositionScale;
      });
      tracks.push(new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, track.times, values));
      continue;
    }
  }

  // If we didn't map enough tracks, the skeleton probably doesn't match Mixamo naming.
  // Surface a real error so the caller can show/log it.
  if (tracks.length < 10) {
    throw new Error(
      `Idle retargeting mapped too few tracks (${tracks.length}). ` +
        "Expected Mixamo bone names like mixamorigHips/mixamorigSpine... (sometimes namespaced as mixamorig:Hips).",
    );
  }

  return new THREE.AnimationClip("idle", sourceClip.duration, tracks);
}

