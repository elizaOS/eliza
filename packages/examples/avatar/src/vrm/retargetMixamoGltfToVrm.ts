import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import { mixamoVRMRigMap } from "./mixamoVRMRigMap";

function normalizeMixamoRigName(name: string): string {
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

function isVrm0(vrm: VRM): boolean {
  const mv = String(vrm.meta?.metaVersion ?? "");
  return mv.startsWith("0");
}

function findNode(scene: THREE.Object3D, rawName: string, normalizedName: string): THREE.Object3D | null {
  return (
    scene.getObjectByName(rawName) ??
    scene.getObjectByName(normalizedName) ??
    // Sometimes the track name is already normalized but node is namespaced (or vice versa)
    scene.getObjectByName(rawName.includes(":") ? rawName.split(":")[1] ?? rawName : rawName) ??
    null
  );
}

/**
 * Retarget a Mixamo-style GLB animation clip onto a VRM.
 *
 * This is intended for *idle* clips; we ignore position tracks to avoid root motion.
 */
export function retargetMixamoGltfToVrm(
  animation: { scene: THREE.Group; animations: THREE.AnimationClip[] },
  vrm: VRM,
): THREE.AnimationClip {
  animation.scene.updateMatrixWorld(true);
  vrm.scene.updateMatrixWorld(true);

  const sourceClip = animation.animations[0];
  if (!sourceClip) {
    throw new Error("idle.glb contains no animation clips");
  }

  const tracks: Array<THREE.QuaternionKeyframeTrack> = [];
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const q = new THREE.Quaternion();

  for (const track of sourceClip.tracks) {
    const parts = track.name.split(".");
    const rawRigName = parts[0];
    const propertyName = parts[1];
    if (!rawRigName || !propertyName) continue;
    if (propertyName !== "quaternion") continue;
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue;

    const normalizedRigName = normalizeMixamoRigName(rawRigName);
    const vrmBoneName = mixamoVRMRigMap[normalizedRigName];
    if (!vrmBoneName) continue;

    const vrmNode = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName as VRMHumanBoneName);
    if (!vrmNode) continue;

    const mixamoRigNode = findNode(animation.scene, rawRigName, normalizedRigName);
    if (!mixamoRigNode || !mixamoRigNode.parent) continue;

    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
    mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);

    const values = track.values.slice();
    for (let i = 0; i < values.length; i += 4) {
      q.fromArray(values, i);
      q.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
      q.toArray(values, i);
    }

    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${vrmNode.name}.quaternion`,
        track.times,
        values.map((v, i) => (isVrm0(vrm) && i % 2 === 0 ? -v : v)),
      ),
    );
  }

  if (tracks.length < 10) {
    throw new Error(
      `Idle retargeting mapped too few tracks (${tracks.length}). ` +
        "Expected Mixamo bone names like mixamorigHips/mixamorigSpine... (sometimes namespaced as mixamorig:Hips).",
    );
  }

  const clip = new THREE.AnimationClip("idle", sourceClip.duration, tracks);
  clip.optimize();
  return clip;
}

