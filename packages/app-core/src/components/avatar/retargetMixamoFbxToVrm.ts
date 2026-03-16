import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
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

function findNode(
  scene: THREE.Object3D,
  rawName: string,
  normalizedName: string,
): THREE.Object3D | null {
  return (
    scene.getObjectByName(rawName) ??
    scene.getObjectByName(normalizedName) ??
    scene.getObjectByName(
      rawName.includes(":") ? (rawName.split(":")[1] ?? rawName) : rawName,
    ) ??
    null
  );
}

/**
 * Retarget a Mixamo FBX animation clip onto a VRM.
 * Quaternion tracks are converted into VRM space and position tracks are
 * scaled by hips height ratio.
 */
export function retargetMixamoFbxToVrm(
  sourceScene: THREE.Group,
  sourceClip: THREE.AnimationClip,
  vrm: VRM,
): THREE.AnimationClip {
  sourceScene.updateMatrixWorld(true);
  vrm.scene.updateMatrixWorld(true);

  const tracks: THREE.KeyframeTrack[] = [];
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const q = new THREE.Quaternion();

  const motionHipsNode = findNode(
    sourceScene,
    "mixamorigHips",
    "mixamorigHips",
  );
  const motionHipsHeight = Math.abs(motionHipsNode?.position.y ?? 0);
  const vrmHipsHeight = Math.abs(
    vrm.humanoid?.normalizedRestPose.hips?.position?.[1] ?? 0,
  );
  const hipsPositionScale =
    motionHipsHeight > 1e-6 && vrmHipsHeight > 1e-6
      ? vrmHipsHeight / motionHipsHeight
      : 1;

  for (const track of sourceClip.tracks) {
    const parts = track.name.split(".");
    const rawRigName = parts[0];
    const propertyName = parts[1];
    if (!rawRigName || !propertyName) continue;
    const normalizedRigName = normalizeMixamoRigName(rawRigName);
    const vrmBoneName = mixamoVRMRigMap[normalizedRigName];
    if (!vrmBoneName) continue;

    const vrmNode = vrm.humanoid?.getNormalizedBoneNode(
      vrmBoneName as VRMHumanBoneName,
    );
    if (!vrmNode) continue;

    const mixamoRigNode = findNode(sourceScene, rawRigName, normalizedRigName);
    if (!mixamoRigNode || !mixamoRigNode.parent) continue;

    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
    mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);

    if (
      propertyName === "quaternion" &&
      track instanceof THREE.QuaternionKeyframeTrack
    ) {
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
      continue;
    }

    // Keep position-track behavior aligned with Girlfie runtime.
    if (
      propertyName === "position" &&
      track instanceof THREE.VectorKeyframeTrack
    ) {
      const values = track.values.map(
        (v, i) => (isVrm0(vrm) && i % 3 !== 1 ? -v : v) * hipsPositionScale,
      );
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${vrmNode.name}.position`,
          track.times,
          values,
        ),
      );
    }
  }

  const hasHipsTrack = tracks.some((track) =>
    track.name.startsWith(
      `${vrm.humanoid?.getNormalizedBoneNode("hips" as VRMHumanBoneName)?.name ?? "__missing__"}.`,
    ),
  );
  if (!hasHipsTrack) {
    throw new Error(
      `Idle FBX retargeting failed: no hips bone track found (mapped ${tracks.length} tracks). ` +
        "Expected Mixamo bone names like mixamorigHips/mixamorigSpine...",
    );
  }

  const clip = new THREE.AnimationClip("idle", sourceClip.duration, tracks);
  clip.optimize();
  return clip;
}
