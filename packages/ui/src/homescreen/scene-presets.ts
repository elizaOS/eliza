/**
 * Built-in scene factories, registered into the runtime's preset registry.
 *
 * These are the trusted, shipped backgrounds. The default —
 * {@link BUILTIN_PRESETS.fresnelCrystalBall} — is a white Fresnel crystal ball
 * over orange with the eliza mark suspended inside, pulsing and rippling with
 * voice energy. The others give the agent concrete targets when a user asks for
 * a different vibe ("a sci-fi Jarvis UI", "deep space").
 *
 * All factories render through `ctx.three` (the WebGL core namespace the host
 * passes in) with GLSL `ShaderMaterial`s. WebGL keeps the homescreen broadly
 * compatible and — unlike WebGPU — renderable under the headless swiftshader the
 * e2e suite uses, so these scenes are actually exercised in CI.
 */

import type * as THREE from "three";
import { registerPreset } from "./scene-runtime";
import {
  BUILTIN_PRESETS,
  type SceneInstance,
  type SceneRenderContext,
} from "./scene-types";

type Three = typeof THREE;

/** Draw the lowercase "eliza" wordmark to a canvas texture for the orb's core. */
function makeLogoTexture(T: Three): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const g = canvas.getContext("2d");
  if (g) {
    g.clearRect(0, 0, 512, 512);
    const halo = g.createRadialGradient(256, 256, 0, 256, 256, 150);
    halo.addColorStop(0, "rgba(255,255,255,0.35)");
    halo.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = halo;
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = "rgba(255,255,255,0.92)";
    g.font = "600 96px ui-sans-serif, system-ui, -apple-system, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("eliza", 256, 256);
  }
  const tex = new T.CanvasTexture(canvas);
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

const FRESNEL_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  uniform float uPulse;
  varying vec3 vN;
  varying vec3 vView;
  // cheap value noise for surface ripple
  float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
  void main(){
    vec3 pos = position;
    float ripple = sin(pos.y*8.0 + uTime*2.0) * 0.012
                 + sin(pos.x*6.0 - uTime*1.6) * 0.010;
    float pulse = (uPulse*0.04 + uEnergy*0.06);
    pos += normal * (ripple + pulse);
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRESNEL_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uRim;
  uniform vec3 uAccent;
  uniform float uEnergy;
  uniform float uPulse;
  varying vec3 vN;
  varying vec3 vView;
  void main(){
    float ndv = max(dot(vN, vView), 0.0);
    float rimF = pow(1.0 - ndv, 4.0);
    float rim = smoothstep(0.35, 1.0, rimF) + rimF * 0.35;
    float inner = pow(1.0 - ndv, 1.6) * 0.10;
    float body = (1.0 - ndv) * 0.05;
    vec3 col = mix(uRim, uAccent, uEnergy * 0.6);
    float a = clamp(rim * (0.85 + uPulse*0.15 + uEnergy*0.4) + inner + body, 0.0, 1.0);
    gl_FragColor = vec4(col, a);
  }
`;

function backgroundColor(T: Three, hex: number): THREE.Color {
  return new T.Color(hex);
}

/** The default: white Fresnel crystal ball over orange, eliza mark inside. */
function fresnelCrystalBall(ctx: SceneRenderContext): SceneInstance {
  const T = ctx.three as Three;
  const scene = ctx.scene as THREE.Scene;
  scene.background = backgroundColor(T, ctx.theme.background);

  let segments = 64;
  let geometry = new T.IcosahedronGeometry(1, segments);
  const uniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uPulse: { value: 0 },
    uRim: { value: new T.Color(0xffffff) },
    uAccent: {
      value: new T.Color().setRGB(
        ctx.theme.accent[0],
        ctx.theme.accent[1],
        ctx.theme.accent[2],
      ),
    },
  };
  const material = new T.ShaderMaterial({
    vertexShader: FRESNEL_VERT,
    fragmentShader: FRESNEL_FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
  });
  const shell = new T.Mesh(geometry, material);
  scene.add(shell);

  const logoTex = makeLogoTexture(T);
  const logoMat = new T.MeshBasicMaterial({
    map: logoTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.9,
  });
  const logo = new T.Mesh(new T.PlaneGeometry(1.1, 1.1), logoMat);
  logo.position.z = -0.25;
  scene.add(logo);

  return {
    update(_dt, time) {
      const e = ctx.inputs.energy;
      uniforms.uTime.value = time;
      uniforms.uEnergy.value = e;
      uniforms.uPulse.value = 0.5 + Math.sin(time * 1.4) * 0.5;
      shell.rotation.y = time * 0.15;
      shell.scale.setScalar(1 + e * 0.05 + Math.sin(time * 1.4) * 0.01);
      logo.material.opacity = 0.75 + e * 0.2;
    },
    optimize(tier) {
      // Drop tessellation as the tier falls; rebuild the icosahedron.
      const next = Math.max(8, Math.round(16 + tier * 48));
      if (next !== segments) {
        segments = next;
        const old = geometry;
        geometry = new T.IcosahedronGeometry(1, segments);
        shell.geometry = geometry;
        old.dispose();
      }
      return tier;
    },
    dispose() {
      scene.remove(shell);
      scene.remove(logo);
      geometry.dispose();
      material.dispose();
      logo.geometry.dispose();
      logoMat.dispose();
      logoTex.dispose();
    },
  };
}

/** A sci-fi HUD: wireframe core + spinning rings reacting to energy. */
function jarvis(ctx: SceneRenderContext): SceneInstance {
  const T = ctx.three as Three;
  const scene = ctx.scene as THREE.Scene;
  scene.background = backgroundColor(T, 0x04070d);
  const cyan = new T.Color(0x35e3ff);

  const core = new T.Mesh(
    new T.IcosahedronGeometry(0.9, 1),
    new T.MeshBasicMaterial({ color: cyan, wireframe: true }),
  );
  scene.add(core);

  const rings: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ring = new T.Mesh(
      new T.TorusGeometry(1.3 + i * 0.25, 0.006, 8, 96),
      new T.MeshBasicMaterial({ color: cyan, transparent: true, opacity: 0.6 }),
    );
    ring.rotation.x = Math.PI / 2 + i * 0.4;
    rings.push(ring);
    scene.add(ring);
  }

  return {
    update(_dt, time) {
      const e = ctx.inputs.energy;
      core.rotation.x = time * 0.3;
      core.rotation.y = time * 0.45;
      core.scale.setScalar(1 + e * 0.15);
      rings.forEach((ring, i) => {
        ring.rotation.z = time * (0.2 + i * 0.15) * (i % 2 ? -1 : 1);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.4 + e * 0.5;
      });
    },
    dispose() {
      core.geometry.dispose();
      (core.material as THREE.Material).dispose();
      scene.remove(core);
      for (const ring of rings) {
        ring.geometry.dispose();
        (ring.material as THREE.Material).dispose();
        scene.remove(ring);
      }
    },
  };
}

/** A calm starfield with a faint nebula sphere. */
function deepSpace(ctx: SceneRenderContext): SceneInstance {
  const T = ctx.three as Three;
  const scene = ctx.scene as THREE.Scene;
  scene.background = backgroundColor(T, 0x05060d);

  let count = 1400;
  const buildStars = (n: number): THREE.Points => {
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 12;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 12;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 12;
    }
    const geom = new T.BufferGeometry();
    geom.setAttribute("position", new T.BufferAttribute(positions, 3));
    const mat = new T.PointsMaterial({
      color: 0xffffff,
      size: 0.02,
      transparent: true,
      opacity: 0.8,
    });
    return new T.Points(geom, mat);
  };
  let stars = buildStars(count);
  scene.add(stars);

  const nebula = new T.Mesh(
    new T.SphereGeometry(4, 24, 24),
    new T.MeshBasicMaterial({
      color: 0x2a3a6a,
      transparent: true,
      opacity: 0.08,
      side: T.BackSide,
    }),
  );
  scene.add(nebula);

  return {
    update(_dt, time) {
      stars.rotation.y = time * 0.02;
      nebula.rotation.y = -time * 0.01;
    },
    optimize(tier) {
      const next = Math.max(300, Math.round(400 + tier * 1000));
      if (next !== count) {
        count = next;
        scene.remove(stars);
        stars.geometry.dispose();
        (stars.material as THREE.Material).dispose();
        stars = buildStars(count);
        scene.add(stars);
      }
      return tier;
    },
    dispose() {
      scene.remove(stars);
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      scene.remove(nebula);
      nebula.geometry.dispose();
      (nebula.material as THREE.Material).dispose();
    },
  };
}

let registered = false;

/** Register the built-in presets once. Idempotent. */
export function registerBuiltinPresets(): void {
  if (registered) return;
  registered = true;
  registerPreset(BUILTIN_PRESETS.fresnelCrystalBall, fresnelCrystalBall);
  registerPreset("jarvis", jarvis);
  registerPreset("deep-space", deepSpace);
}

export { deepSpace, fresnelCrystalBall, jarvis };
