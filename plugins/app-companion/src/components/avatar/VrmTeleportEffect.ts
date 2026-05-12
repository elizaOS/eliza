import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";

/** Three.js NodeMaterial exposes emissiveNode/opacityNode but they are not in public MeshStandardMaterial types. */
interface MeshStandardMaterialWithNodeProps {
  emissiveNode?: unknown | null;
  opacityNode?: unknown | null;
}

type TslNodeLike = {
  add(value: unknown): unknown;
  mul(value: unknown): unknown;
};

export type TeleportFallbackShader = {
  uniforms: { uTeleportProgress: { value: number } };
  isOutgoing?: boolean;
};

export type TeleportSparkleParticle = {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  baseAngle: number;
  baseRadius: number;
  height: number;
  start: number;
  duration: number;
  spin: number;
  wobble: number;
  wobbleSpeed: number;
  baseSize: number;
};

export type TeleportSparkleSystem = {
  group: THREE.Group;
  particles: TeleportSparkleParticle[];
};

const TELEPORT_DISSOLVE_START_Y = -1.2;
const TELEPORT_DISSOLVE_END_Y = 1.0;

let teleportSparkleTexture: THREE.CanvasTexture | null = null;
function getTeleportSparkleTexture(): THREE.CanvasTexture {
  if (teleportSparkleTexture) return teleportSparkleTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) {
    teleportSparkleTexture = new THREE.CanvasTexture(canvas);
    return teleportSparkleTexture;
  }

  const gradient = context.createRadialGradient(64, 64, 6, 64, 64, 64);
  gradient.addColorStop(0.0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.2, "rgba(190,245,255,0.95)");
  gradient.addColorStop(0.55, "rgba(112,214,255,0.48)");
  gradient.addColorStop(1.0, "rgba(112,214,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);

  teleportSparkleTexture = new THREE.CanvasTexture(canvas);
  teleportSparkleTexture.needsUpdate = true;
  return teleportSparkleTexture;
}

export class VrmTeleportEffect {
  private progress = 1.0;
  private completeTime = -Infinity;
  private progressUniform: { value: number } | null = null;
  private dissolvedMaterials: THREE.Material[] = [];
  private fallbackShaders: TeleportFallbackShader[] = [];
  private sparkles: TeleportSparkleSystem | null = null;
  private revealStarted = false;

  public get teleportProgress() {
    return this.progress;
  }
  public get teleportCompleteTime() {
    return this.completeTime;
  }
  public get isRevealStarted() {
    return this.revealStarted;
  }

  public resetState() {
    this.progress = 1.0;
    this.revealStarted = false;
    this.cleanupDissolve();
    this.cleanupSparkles();
  }

  public async play(
    vrm: VRM,
    outgoingVrm: VRM | null,
    avatarParent: THREE.Object3D,
    renderer: THREE.WebGLRenderer | null,
    onAborted: () => boolean,
  ): Promise<void> {
    this.progress = 0.0;
    this.cleanupDissolve();
    let appliedNodeDissolve = false;

    try {
      const tsl = await import("three/tsl");
      const uProgress = tsl.uniform(0.0);
      this.progressUniform = uProgress;

      const applyTslDissolve = (targetVrm: VRM, isOutgoing: boolean) => {
        targetVrm.scene.traverse((obj: THREE.Object3D) => {
          if (!(obj instanceof THREE.Mesh)) return;
          const mats = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];
          for (const mat of mats) {
            if (!mat.isNodeMaterial || mat.userData._dissolveApplied) continue;
            appliedNodeDissolve = true;
            mat.userData._dissolveApplied = true;
            mat.userData._origOpacityNode = mat.opacityNode ?? null;
            mat.userData._origEmissiveNode =
              (mat as MeshStandardMaterialWithNodeProps).emissiveNode ?? null;
            mat.userData._origAlphaTest = mat.alphaTest;

            const worldY = tsl.positionWorld.y;
            const threshold = uProgress
              .mul(TELEPORT_DISSOLVE_END_Y - TELEPORT_DISSOLVE_START_Y)
              .add(TELEPORT_DISSOLVE_START_Y);
            const diff = worldY.sub(threshold);

            const nx = tsl.sin(
              tsl.positionWorld.x.mul(18.0).add(worldY.mul(12.0)),
            );
            const ny = tsl.cos(
              worldY.mul(15.0).add(tsl.positionWorld.z.mul(10.0)),
            );
            const nz = tsl.sin(
              tsl.positionWorld.z.mul(18.0).add(tsl.positionWorld.x.mul(10.0)),
            );
            const noise = nx.add(ny).add(nz).div(3.0).add(1.0).mul(0.5);
            const ratio = diff.div(0.3).clamp(0.0, 1.0);

            const baseAlpha = tsl.step(ratio, noise);
            const dissolveAlpha = isOutgoing
              ? tsl.float(1.0).sub(baseAlpha)
              : baseAlpha;

            const edgeDist = diff.abs();
            const glowWidth = tsl.float(0.08);
            const glowIntensity = tsl
              .float(1.0)
              .sub(edgeDist.div(glowWidth).clamp(0.0, 1.0));
            const hueShift = tsl.fract(worldY.mul(3.0).add(uProgress.mul(2.0)));
            const holoR = tsl
              .smoothstep(tsl.float(0.3), tsl.float(0.7), hueShift)
              .mul(0.8)
              .add(0.2);
            const holoG = tsl.float(0.9);
            const holoB = tsl
              .smoothstep(tsl.float(0.7), tsl.float(0.3), hueShift)
              .mul(0.8)
              .add(0.2);
            const holoColor = tsl.vec3(holoR, holoG, holoB);

            const glowActive = tsl
              .step(tsl.float(0.001), uProgress)
              .mul(tsl.float(1.0).sub(tsl.step(tsl.float(0.999), uProgress)));
            const emissiveBoost = holoColor.mul(
              glowIntensity.mul(10.0).mul(glowActive).mul(dissolveAlpha),
            );

            const nodeMaterial = mat as MeshStandardMaterialWithNodeProps &
              THREE.Material;
            const origOpacity = nodeMaterial.opacityNode as
              | TslNodeLike
              | null
              | undefined;
            nodeMaterial.opacityNode = origOpacity
              ? (origOpacity.mul(dissolveAlpha) ?? dissolveAlpha)
              : dissolveAlpha;

            const origEmissive = nodeMaterial.emissiveNode as
              | TslNodeLike
              | null
              | undefined;
            nodeMaterial.emissiveNode = origEmissive
              ? origEmissive.add(emissiveBoost)
              : emissiveBoost;

            mat.alphaTest = 0.01;
            mat.needsUpdate = true;
            this.dissolvedMaterials.push(mat);
          }
        });
      };

      applyTslDissolve(vrm, false);
      if (outgoingVrm) {
        applyTslDissolve(outgoingVrm, true);
      }
    } catch (err) {
      console.warn(
        "[VrmTeleportEffect] TSL dissolve unavailable, showing instantly:",
        err,
      );
    }

    if (!appliedNodeDissolve) {
      this.applyFallbackDissolve(vrm, false, renderer);
      if (outgoingVrm) {
        this.applyFallbackDissolve(outgoingVrm, true, renderer);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    if (typeof window !== "undefined") {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    }

    if (onAborted()) return;

    this.revealStarted = true;
    this.startSparkles(vrm, avatarParent);
  }

  public update(
    stableDelta: number,
    elapsedTime: number,
    onComplete?: () => void,
  ): void {
    if (this.progress < 1.0) {
      this.progress += stableDelta * 2.8; // ~0.35 seconds duration
      if (this.progress > 1.0) this.progress = 1.0;

      if (this.progressUniform) {
        this.progressUniform.value = this.progress;
      }
      for (const shader of this.fallbackShaders) {
        shader.uniforms.uTeleportProgress.value = this.progress;
      }

      if (this.progress >= 1.0) {
        this.cleanupDissolve();
        this.cleanupSparkles();
        this.completeTime = elapsedTime;
        onComplete?.();
      }
    }
    this.updateSparkles();
  }

  public dispose(): void {
    this.resetState();
  }

  private applyFallbackDissolve(
    vrm: VRM,
    isOutgoing: boolean,
    renderer: THREE.WebGLRenderer | null,
  ): void {
    vrm.scene.traverse((obj: THREE.Object3D) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (mat.userData._dissolveApplied) continue;
        mat.userData._dissolveApplied = true;
        mat.userData._origAlphaTest = mat.alphaTest;
        mat.userData._origOnBeforeCompile = mat.onBeforeCompile;
        mat.userData._origCustomProgramCacheKey = mat.customProgramCacheKey;

        const shaderRef = {
          uniforms: { uTeleportProgress: { value: this.progress } },
          isOutgoing,
        };
        this.fallbackShaders.push(shaderRef);

        mat.alphaTest = Math.max(mat.alphaTest ?? 0, 0.01);
        mat.onBeforeCompile = (shader: {
          uniforms: Record<string, { value: unknown }>;
          vertexShader: string;
          fragmentShader: string;
        }) => {
          shader.uniforms.uTeleportProgress =
            shaderRef.uniforms.uTeleportProgress;
          shader.vertexShader = `
varying vec3 vTeleportWorldPosition;
${shader.vertexShader}
`.replace(
            "#include <project_vertex>",
            `vec4 teleportWorldPosTemp = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
teleportWorldPosTemp = instanceMatrix * teleportWorldPosTemp;
#endif
teleportWorldPosTemp = modelMatrix * teleportWorldPosTemp;
vTeleportWorldPosition = teleportWorldPosTemp.xyz;
#include <project_vertex>`,
          );
          shader.fragmentShader = `
uniform float uTeleportProgress;
varying vec3 vTeleportWorldPosition;
float teleportSmoothNoise(vec3 p) {
  float nx = sin(p.x * 18.0 + p.y * 12.0);
  float ny = cos(p.y * 15.0 + p.z * 10.0);
  float nz = sin(p.z * 18.0 + p.x * 10.0);
  return (nx + ny + nz) / 3.0 * 0.5 + 0.5;
}
${shader.fragmentShader}
`
            .replace(
              "#include <alphatest_fragment>",
              `float teleportThreshold = mix(${TELEPORT_DISSOLVE_START_Y.toFixed(1)}, ${TELEPORT_DISSOLVE_END_Y.toFixed(1)}, uTeleportProgress);
float teleportDiff = vTeleportWorldPosition.y - teleportThreshold;
float teleportRatio = clamp(teleportDiff / 0.3, 0.0, 1.0);
float teleportNoise = teleportSmoothNoise(vTeleportWorldPosition);
${isOutgoing ? "if (teleportNoise >= teleportRatio) discard;" : "if (teleportNoise < teleportRatio) discard;"}
#include <alphatest_fragment>`,
            )
            .replace(
              "#include <emissivemap_fragment>",
              `#include <emissivemap_fragment>
            float teleportGlowDist = abs(teleportDiff);
            float teleportGlowIntensity = 1.0 - clamp(teleportGlowDist / 0.08, 0.0, 1.0);
            vec3 teleportHoloColor = vec3(0.3, 0.9, 0.8);
            float teleportGlowActive = step(0.001, uTeleportProgress) * (1.0 - step(0.999, uTeleportProgress));
            float teleportDissolveAlpha = ${isOutgoing ? "1.0 - step(teleportRatio, teleportNoise)" : "step(teleportRatio, teleportNoise)"};
            totalEmissiveRadiance += teleportHoloColor * (teleportGlowIntensity * 10.0 * teleportGlowActive * teleportDissolveAlpha);`,
            );

          const originalOnBeforeCompile = mat.userData._origOnBeforeCompile;
          if (typeof originalOnBeforeCompile === "function") {
            originalOnBeforeCompile(shader, renderer);
          }
        };
        const origCacheKey = mat.userData._origCustomProgramCacheKey;
        mat.customProgramCacheKey = () => {
          const baseKey =
            typeof origCacheKey === "function" ? origCacheKey.call(mat) : "";
          return `${baseKey}:${mat.type}:teleport-dissolve-fallback:${isOutgoing ? "out" : "in"}`;
        };
        mat.needsUpdate = true;
        this.dissolvedMaterials.push(mat);
      }
    });
  }

  private startSparkles(vrm: VRM, parent: THREE.Object3D): void {
    this.cleanupSparkles();

    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const sparkleGroup = new THREE.Group();
    sparkleGroup.position.set(center.x, bounds.min.y + 0.06, center.z);
    parent.add(sparkleGroup);

    const texture = getTeleportSparkleTexture();
    const particleHeight = THREE.MathUtils.clamp(size.y * 0.82, 0.95, 1.75);
    const particles: TeleportSparkleParticle[] = [];

    const flashMaterial = new THREE.SpriteMaterial({
      map: texture,
      color: new THREE.Color().setHSL(0.55, 0.95, 0.65),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const flashSprite = new THREE.Sprite(flashMaterial);
    flashSprite.visible = false;
    flashSprite.renderOrder = 9999;
    sparkleGroup.add(flashSprite);
    particles.push({
      sprite: flashSprite,
      material: flashMaterial,
      baseAngle: 0,
      baseRadius: 0,
      height: size.y * 0.5,
      start: 0,
      duration: 0.3,
      spin: 0,
      wobble: 0,
      wobbleSpeed: 0,
      baseSize: 1.8,
    });

    for (let index = 0; index < 60; index += 1) {
      const hue = 0.52 + Math.random() * 0.08;
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: new THREE.Color().setHSL(hue, 0.95, 0.8),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 9999;
      sparkleGroup.add(sprite);

      particles.push({
        sprite,
        material,
        baseAngle: Math.random() * Math.PI * 2,
        baseRadius: Math.random() * 0.4 + 0.05,
        height: particleHeight * (1.1 + Math.random() * 0.5),
        start: Math.random() * 0.3,
        duration: 0.2 + Math.random() * 0.25,
        spin: (Math.random() - 0.5) * 0.5,
        wobble: 0,
        wobbleSpeed: 0,
        baseSize: 0.02 + Math.random() * 0.05,
      });
    }

    this.sparkles = {
      group: sparkleGroup,
      particles,
    };
    this.updateSparkles();
  }

  private updateSparkles(): void {
    if (!this.sparkles) return;
    const currentProgress = THREE.MathUtils.clamp(this.progress, 0, 1);
    let anyVisible = false;

    for (const particle of this.sparkles.particles) {
      const localProgress = THREE.MathUtils.clamp(
        (currentProgress - particle.start) / particle.duration,
        0,
        1,
      );

      if (localProgress <= 0 || localProgress >= 1) {
        particle.material.opacity = 0;
        particle.sprite.visible = false;
        continue;
      }

      anyVisible = true;
      const opacity = Math.sin(localProgress * Math.PI) * 1.5;

      if (particle.baseSize > 1.0) {
        const scale = particle.baseSize * (1.0 + localProgress * 2.0);
        particle.sprite.position.set(0, particle.height, 0);
        particle.sprite.scale.setScalar(scale);
        particle.sprite.visible = opacity > 0.01;
        particle.material.opacity = Math.min(opacity, 1.0) * 0.45;
      } else {
        const rise = localProgress ** 1.5;
        const angle = particle.baseAngle + currentProgress * particle.spin;
        const radial = particle.baseRadius * (1.0 + rise * 0.6);
        const x = Math.cos(angle) * radial;
        const z = Math.sin(angle) * radial;
        const y = particle.height * rise;

        const width = particle.baseSize * 0.6;
        const height = particle.baseSize * (8.0 + localProgress * 6.0);

        particle.sprite.position.set(x, y, z);
        particle.sprite.scale.set(width, height, 1);
        particle.sprite.visible = opacity > 0.01;
        particle.material.opacity = Math.min(opacity, 1.0);
      }
    }

    if (!anyVisible && currentProgress >= 1) {
      this.cleanupSparkles();
    }
  }

  private cleanupDissolve(): void {
    for (const mat of this.dissolvedMaterials) {
      if (mat.userData._dissolveApplied) {
        if (mat.userData._origOpacityNode !== undefined) {
          (mat as MeshStandardMaterialWithNodeProps).opacityNode =
            mat.userData._origOpacityNode ?? null;
        }
        if (mat.userData._origEmissiveNode !== undefined) {
          (mat as MeshStandardMaterialWithNodeProps).emissiveNode =
            mat.userData._origEmissiveNode ?? null;
        }
        mat.alphaTest = mat.userData._origAlphaTest ?? 0;
        mat.onBeforeCompile =
          mat.userData._origOnBeforeCompile ?? mat.onBeforeCompile;
        mat.customProgramCacheKey =
          mat.userData._origCustomProgramCacheKey ?? mat.customProgramCacheKey;
        delete mat.userData._dissolveApplied;
        delete mat.userData._origOpacityNode;
        delete mat.userData._origEmissiveNode;
        delete mat.userData._origAlphaTest;
        delete mat.userData._origOnBeforeCompile;
        delete mat.userData._origCustomProgramCacheKey;
        mat.needsUpdate = true;
      }
    }
    this.dissolvedMaterials = [];
    this.progressUniform = null;
    this.fallbackShaders = [];
  }

  private cleanupSparkles(): void {
    if (!this.sparkles) return;
    for (const particle of this.sparkles.particles) {
      particle.sprite.parent?.remove(particle.sprite);
      particle.material.dispose();
    }
    this.sparkles.group.parent?.remove(this.sparkles.group);
    this.sparkles = null;
  }
}
