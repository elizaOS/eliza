import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const sizeScratch = new THREE.Vector3();

export type CameraProfile = "chat" | "companion";
export type InteractionMode = "free" | "orbitZoom";

export type CameraAnimationConfig = {
  enabled: boolean;
  swayAmplitude: number;
  bobAmplitude: number;
  rotationAmplitude: number;
  speed: number;
};

/**
 * Handles VRM avatar framing, camera profile application, companion-mode
 * bounds-based camera fitting, subtle companion camera motion, interaction modes,
 * and VRM face-orientation correction.
 */
export class VrmCameraManager {
  private readonly tempBoundsSize = new THREE.Vector3();
  private readonly tempBoundsCenter = new THREE.Vector3();
  private readonly tempWorldPosition = new THREE.Vector3();
  private readonly tempSecondaryWorldPosition = new THREE.Vector3();
  private readonly tempTertiaryWorldPosition = new THREE.Vector3();
  private readonly tempOrbitOffset = new THREE.Vector3();
  private readonly tempOrbitSpherical = new THREE.Spherical();

  /**
   * Position and scale the VRM for the active camera profile, then place the
   * camera accordingly. Updates `lookAtTarget` and `baseCameraPosition` in place.
   */
  centerAndFrame(
    vrm: VRM,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls | null,
    cameraProfile: CameraProfile,
    lookAtTarget: THREE.Vector3,
    baseCameraPosition: THREE.Vector3,
    applyInteractionMode: (controls: OrbitControls) => void,
    skipControlUpdate = false,
  ): void {
    this.normalizeAvatarToStage(vrm, cameraProfile);
    vrm.scene.updateMatrixWorld(true);
    camera.near = 0.1;
    camera.far = 100.0;
    this.applyCameraProfileToCamera(camera, controls, cameraProfile);
    this.adjustCompanionCameraForAvatarBounds(
      vrm,
      camera,
      controls,
      cameraProfile,
      lookAtTarget,
    );
    camera.updateProjectionMatrix();
    baseCameraPosition.copy(camera.position);

    if (controls) {
      if (!skipControlUpdate) {
        controls.target.copy(lookAtTarget);
      }
      applyInteractionMode(controls);
      if (!skipControlUpdate) {
        controls.update();
      }
    }
  }

  private normalizeAvatarToStage(vrm: VRM, cameraProfile: CameraProfile): void {
    vrm.scene.scale.setScalar(1);
    vrm.scene.position.set(0, 0, 0);
    vrm.scene.updateMatrixWorld(true);

    const initialBounds = new THREE.Box3().setFromObject(vrm.scene);
    if (initialBounds.isEmpty()) return;

    const initialSize = initialBounds.getSize(this.tempBoundsSize);
    const avatarHeight = Math.max(initialSize.y, 1e-3);
    const targetHeight = cameraProfile === "chat" ? 1.62 : 1.76;
    const normalizedScale = THREE.MathUtils.clamp(
      targetHeight / avatarHeight,
      0.75,
      2.35,
    );

    vrm.scene.scale.setScalar(normalizedScale);
    vrm.scene.updateMatrixWorld(true);

    const normalizedBounds = new THREE.Box3().setFromObject(vrm.scene);
    if (normalizedBounds.isEmpty()) return;

    const feetAnchor = this.getAvatarFeetAnchor(vrm, normalizedBounds);
    normalizedBounds.getCenter(this.tempBoundsCenter);
    vrm.scene.position.set(
      -this.tempBoundsCenter.x,
      -feetAnchor.y,
      -this.tempBoundsCenter.z,
    );
    vrm.scene.updateMatrixWorld(true);
  }

  /**
   * For the companion profile, adapt camera distance so the full avatar
   * body stays in frame regardless of model dimensions.
   */
  adjustCompanionCameraForAvatarBounds(
    vrm: VRM,
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls | null,
    cameraProfile: CameraProfile,
    lookAtTarget: THREE.Vector3,
  ): void {
    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    if (bounds.isEmpty()) return;

    const size = this.tempBoundsSize;
    const center = this.tempBoundsCenter;
    bounds.getSize(size);
    bounds.getCenter(center);

    if (
      !Number.isFinite(size.x) ||
      !Number.isFinite(size.y) ||
      !Number.isFinite(size.z)
    ) {
      return;
    }

    const verticalPadding = cameraProfile === "chat" ? 1.18 : 1.1;
    const horizontalPadding = cameraProfile === "chat" ? 1.18 : 1.08;
    const halfHeight = Math.max((size.y * verticalPadding) / 2, 0.58);
    const halfWidth = Math.max((size.x * horizontalPadding) / 2, 0.4);

    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov =
      2 * Math.atan(Math.max(1e-4, Math.tan(verticalFov / 2) * camera.aspect));

    const distanceByHeight =
      halfHeight / Math.max(1e-4, Math.tan(verticalFov / 2));
    const distanceByWidth =
      halfWidth / Math.max(1e-4, Math.tan(horizontalFov / 2));
    const fitDistance = Math.max(distanceByHeight, distanceByWidth);
    const neckY = this.getAvatarNeckHeight(vrm, bounds);
    let lookAtY = neckY;
    let distance = fitDistance;
    let cameraY = neckY + Math.min(size.y * 0.08, 0.18);

    if (cameraProfile === "companion") {
      lookAtY = neckY;
      distance = Math.max(9.6, fitDistance * 1.35);
      cameraY = neckY + Math.min(size.y * 0.1, 0.18);
    } else {
      lookAtY = THREE.MathUtils.clamp(
        neckY - size.y * 0.08,
        bounds.min.y + size.y * 0.38,
        bounds.max.y - size.y * 0.16,
      );
      distance = Math.max(5.6, fitDistance * 1.02);
      cameraY = lookAtY + Math.min(size.y * 0.12, 0.24);
    }

    lookAtTarget.set(center.x, lookAtY, center.z);
    camera.position.set(center.x, cameraY, center.z + distance);

    if (controls) {
      controls.minDistance = Math.max(2.8, distance * 0.7);
      controls.maxDistance = Math.max(12.8, distance * 1.8);
    }
  }

  private getAvatarFeetAnchor(vrm: VRM, bounds: THREE.Box3): THREE.Vector3 {
    const leftFoot = vrm.humanoid?.getNormalizedBoneNode("leftFoot");
    const rightFoot = vrm.humanoid?.getNormalizedBoneNode("rightFoot");
    if (leftFoot && rightFoot) {
      leftFoot.getWorldPosition(this.tempWorldPosition);
      rightFoot.getWorldPosition(this.tempSecondaryWorldPosition);
      return this.tempTertiaryWorldPosition
        .copy(this.tempWorldPosition)
        .add(this.tempSecondaryWorldPosition)
        .multiplyScalar(0.5);
    }

    const center = bounds.getCenter(this.tempTertiaryWorldPosition);
    return center.set(center.x, bounds.min.y, center.z);
  }

  private getAvatarNeckHeight(vrm: VRM, bounds: THREE.Box3): number {
    const neckNode = vrm.humanoid?.getNormalizedBoneNode("neck");
    if (neckNode) {
      neckNode.getWorldPosition(this.tempWorldPosition);
      if (Number.isFinite(this.tempWorldPosition.y)) {
        return this.tempWorldPosition.y;
      }
    }

    const headNode = vrm.humanoid?.getNormalizedBoneNode("head");
    const chestNode =
      vrm.humanoid?.getNormalizedBoneNode("upperChest") ??
      vrm.humanoid?.getNormalizedBoneNode("chest") ??
      vrm.humanoid?.getNormalizedBoneNode("spine");
    if (headNode && chestNode) {
      headNode.getWorldPosition(this.tempWorldPosition);
      chestNode.getWorldPosition(this.tempSecondaryWorldPosition);
      const averagedY =
        (this.tempWorldPosition.y + this.tempSecondaryWorldPosition.y) / 2;
      if (Number.isFinite(averagedY)) {
        return averagedY;
      }
    }

    return bounds.min.y + Math.max(bounds.getSize(sizeScratch).y * 0.72, 0.9);
  }

  /**
   * Apply preset camera position, FOV and orbit constraints for the given
   * camera profile.
   */
  applyCameraProfileToCamera(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls | null,
    _cameraProfile: CameraProfile,
  ): void {
    camera.fov = 12;
    camera.near = 2.5;
    if (controls) {
      controls.minDistance = 4.0;
      controls.maxDistance = 10.0;
      controls.minPolarAngle = Math.PI * 0.06;
      controls.maxPolarAngle = Math.PI * 0.94;
      controls.minAzimuthAngle = -Infinity;
      controls.maxAzimuthAngle = Infinity;
    }
  }

  /**
   * Animate the camera in a shallow front-facing orbit around the avatar's
   * look target so companion mode feels alive without breaking the framing.
   */
  applyCameraMotion(
    camera: THREE.PerspectiveCamera,
    baseCameraPosition: THREE.Vector3,
    lookAtTarget: THREE.Vector3,
    cameraAnimation: CameraAnimationConfig,
    elapsedTime: number,
  ): void {
    const baseOffset = this.tempOrbitOffset
      .copy(baseCameraPosition)
      .sub(lookAtTarget);
    if (baseOffset.lengthSq() < 1e-6) {
      camera.position.copy(baseCameraPosition);
      return;
    }

    const spherical = this.tempOrbitSpherical.setFromVector3(baseOffset);
    const t = elapsedTime * Math.max(cameraAnimation.speed, 1e-3);

    // Layered low-frequency motion keeps the camera drifting without ever
    // swinging wide enough to leave the avatar's front hemisphere.
    const yawSeed =
      Math.sin(t * 0.21 + 0.35) * 0.58 +
      Math.sin(t * 0.11 + 1.8) * 0.29 +
      Math.sin(t * 0.37 + 2.6) * 0.13;
    const pitchSeed =
      Math.sin(t * 0.17 + 0.9) * 0.55 +
      Math.sin(t * 0.31 + 2.1) * 0.3 +
      Math.sin(t * 0.07 + 0.2) * 0.15;
    const radiusSeed =
      Math.sin(t * 0.13 + 1.2) * 0.62 + Math.sin(t * 0.23 + 2.7) * 0.38;

    const yawRange = THREE.MathUtils.clamp(
      cameraAnimation.swayAmplitude * 4.2 +
        cameraAnimation.rotationAmplitude * 3.8,
      0.05,
      0.22,
    );
    const pitchRange = THREE.MathUtils.clamp(
      cameraAnimation.bobAmplitude * 1.8 +
        cameraAnimation.rotationAmplitude * 1.4,
      0.015,
      0.085,
    );
    const radiusRange = THREE.MathUtils.clamp(
      cameraAnimation.swayAmplitude * 2.4 + cameraAnimation.bobAmplitude * 1.1,
      0.025,
      0.18,
    );

    spherical.theta += yawSeed * yawRange;
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi + pitchSeed * pitchRange,
      0.42,
      Math.PI - 0.42,
    );
    spherical.radius = Math.max(
      0.5,
      spherical.radius + radiusSeed * radiusRange,
    );

    camera.position
      .copy(lookAtTarget)
      .add(baseOffset.setFromSpherical(spherical));
  }

  /** Configure OrbitControls for the given interaction mode. */
  applyInteractionMode(
    controls: OrbitControls,
    interactionMode: InteractionMode,
  ): void {
    if (interactionMode === "orbitZoom") {
      controls.enablePan = false;
      controls.enableRotate = true;
      controls.enableZoom = true;
      controls.screenSpacePanning = false;
      controls.rotateSpeed = 1.15;
      controls.zoomSpeed = 0.85;
      return;
    }

    controls.enablePan = true;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.screenSpacePanning = true;
    controls.rotateSpeed = 0.75;
    controls.zoomSpeed = 0.9;
  }

  /**
   * Detect whether the VRM is facing away from the camera using eye-bone
   * heuristics, and rotate it 180 degrees if needed.
   */
  ensureFacingCamera(vrm: VRM, camera: THREE.PerspectiveCamera): void {
    vrm.scene.updateMatrixWorld(true);

    const forward = new THREE.Vector3();
    const leftEye = vrm.humanoid?.getNormalizedBoneNode("leftEye");
    const rightEye = vrm.humanoid?.getNormalizedBoneNode("rightEye");

    if (leftEye && rightEye) {
      const left = new THREE.Vector3();
      const right = new THREE.Vector3();
      leftEye.getWorldPosition(left);
      rightEye.getWorldPosition(right);

      const eyeRight = right.sub(left);
      if (eyeRight.lengthSq() > 1e-6) {
        // Up x Right best matches this VRM rig orientation in our current scene setup.
        forward
          .copy(new THREE.Vector3(0, 1, 0))
          .cross(eyeRight)
          .normalize();
      }
    }

    if (forward.lengthSq() < 1e-6) {
      // Fallback when eye bones are unavailable.
      vrm.scene.getWorldDirection(forward);
    }

    const anchor =
      vrm.humanoid?.getNormalizedBoneNode("head") ??
      vrm.humanoid?.getNormalizedBoneNode("hips") ??
      vrm.scene;
    const anchorPos = new THREE.Vector3();
    anchor.getWorldPosition(anchorPos);
    const toCamera = new THREE.Vector3().subVectors(camera.position, anchorPos);

    forward.y = 0;
    toCamera.y = 0;
    if (forward.lengthSq() < 1e-6 || toCamera.lengthSq() < 1e-6) return;

    forward.normalize();
    toCamera.normalize();

    if (forward.dot(toCamera) < 0) {
      vrm.scene.rotateY(Math.PI);
      vrm.scene.updateMatrixWorld(true);
    }
  }
}
