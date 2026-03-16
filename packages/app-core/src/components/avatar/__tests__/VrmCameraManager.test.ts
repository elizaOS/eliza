import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { VrmCameraManager } from "../VrmCameraManager";

function createVrmWithBones(options: {
  neckY?: number;
  headY?: number;
  chestY?: number;
}): VRM {
  const scene = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 2, 0.4),
    new THREE.MeshBasicMaterial(),
  );
  body.position.y = 1;
  scene.add(body);

  const bones = new Map<string, THREE.Object3D>();

  if (typeof options.neckY === "number") {
    const neck = new THREE.Object3D();
    neck.position.y = options.neckY;
    scene.add(neck);
    bones.set("neck", neck);
  }
  if (typeof options.headY === "number") {
    const head = new THREE.Object3D();
    head.position.y = options.headY;
    scene.add(head);
    bones.set("head", head);
  }
  if (typeof options.chestY === "number") {
    const chest = new THREE.Object3D();
    chest.position.y = options.chestY;
    scene.add(chest);
    bones.set("chest", chest);
  }

  return {
    scene,
    humanoid: {
      getNormalizedBoneNode: (name: string) => bones.get(name) ?? null,
    },
  } as VRM;
}

describe("VrmCameraManager", () => {
  it("frames companion_close avatars at their own neck height", () => {
    const manager = new VrmCameraManager();
    const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 20);
    const lookAtShort = new THREE.Vector3();
    const lookAtTall = new THREE.Vector3();
    const baseCameraPosition = new THREE.Vector3();

    const shortVrm = createVrmWithBones({ neckY: 1.15 });
    const tallVrm = createVrmWithBones({ neckY: 1.55 });

    manager.centerAndFrame(
      shortVrm,
      camera,
      null,
      "companion_close",
      lookAtShort,
      baseCameraPosition,
      () => {},
    );
    const shortCameraY = camera.position.y;

    manager.centerAndFrame(
      tallVrm,
      camera,
      null,
      "companion_close",
      lookAtTall,
      baseCameraPosition,
      () => {},
    );

    expect(lookAtTall.y).toBeGreaterThan(lookAtShort.y);
    expect(shortCameraY).toBeGreaterThan(lookAtShort.y);
    expect(camera.position.y).toBeGreaterThan(lookAtTall.y);
  });

  it("falls back to head/chest midpoint when neck bone is missing", () => {
    const manager = new VrmCameraManager();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    const lookAtTarget = new THREE.Vector3();

    const vrm = createVrmWithBones({ headY: 1.8, chestY: 1.2 });
    manager.centerAndFrame(
      vrm,
      camera,
      null,
      "companion",
      lookAtTarget,
      new THREE.Vector3(),
      () => {},
    );

    expect(lookAtTarget.y).toBeGreaterThan(1.1);
    expect(lookAtTarget.y).toBeLessThan(1.6);
    expect(camera.position.y).toBeGreaterThan(lookAtTarget.y);
  });

  it("normalizes the avatar so its feet rest at stage origin", () => {
    const manager = new VrmCameraManager();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    const lookAtTarget = new THREE.Vector3();

    const vrm = createVrmWithBones({ neckY: 1.4 });
    manager.centerAndFrame(
      vrm,
      camera,
      null,
      "companion",
      lookAtTarget,
      new THREE.Vector3(),
      () => {},
    );

    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    expect(bounds.min.y).toBeCloseTo(0, 5);
    expect(Math.abs(bounds.getCenter(new THREE.Vector3()).x)).toBeLessThan(
      1e-6,
    );
  });

  it("animates companion camera as a shallow front orbit around the focus point", () => {
    const manager = new VrmCameraManager();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    const lookAtTarget = new THREE.Vector3(0, 1.4, 0);
    const baseCameraPosition = new THREE.Vector3(0, 1.48, 5.1);
    const animation = {
      enabled: true,
      swayAmplitude: 0.04,
      bobAmplitude: 0.022,
      rotationAmplitude: 0.012,
      speed: 0.42,
    };

    manager.applyCameraMotion(
      camera,
      baseCameraPosition,
      lookAtTarget,
      animation,
      2,
    );
    const positionA = camera.position.clone();
    const offsetA = positionA.clone().sub(lookAtTarget);

    manager.applyCameraMotion(
      camera,
      baseCameraPosition,
      lookAtTarget,
      animation,
      18,
    );
    const positionB = camera.position.clone();
    const offsetB = positionB.clone().sub(lookAtTarget);

    expect(positionA.distanceTo(positionB)).toBeGreaterThan(0.05);
    expect(offsetA.z).toBeGreaterThan(4.7);
    expect(offsetB.z).toBeGreaterThan(4.7);
    expect(Math.abs(offsetA.x)).toBeLessThan(1.2);
    expect(Math.abs(offsetB.x)).toBeLessThan(1.2);
  });
});
