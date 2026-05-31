/**
 * Built-in scene factories, registered into the runtime's preset registry.
 *
 * These are the trusted, shipped backgrounds. The default —
 * {@link BUILTIN_PRESETS.fresnelCrystalBall} — is a small glass orb half-sunk
 * into a full-screen sheet of water: the orb reflects a procedurally generated
 * sky and the water ripples outward from it while the agent speaks. The others
 * give the agent concrete targets when a user asks for a different vibe ("a
 * sci-fi Jarvis UI", "deep space").
 *
 * All factories render through `ctx.three` (the WebGL core namespace the host
 * passes in) with GLSL `ShaderMaterial`s. WebGL keeps the homescreen broadly
 * compatible and — unlike WebGPU — renderable under the headless swiftshader the
 * e2e suite uses, so these scenes are actually exercised in CI.
 */

import type * as THREE from "three";
import { resolveAppAssetUrl } from "../utils/asset-url";
import { registerPreset } from "./scene-runtime";
import {
  BUILTIN_PRESETS,
  type SceneInstance,
  type SceneRenderContext,
} from "./scene-types";

type Three = typeof THREE;

// The onboarding background colour. The water and glass tint lock to this fixed
// brand orange so the homescreen palette never shifts with the active theme.
const BRAND_ORANGE = 0xff5800;

// A small glass marble set into the water. Half-submerged at the origin, small
// enough that the water reads as a full, open sheet around it.
const ORB_RADIUS = 0.18;

// Height of the straight-down camera above the water. Lower = the orb (and the
// mark refracted inside it) reads larger; higher = more open water around it.
const CAM_HEIGHT = 2.5;

const WATER_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WATER_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uSpeak;   // assistant-voice energy, smoothed [0,1]
  uniform float uQuality; // perf tier [0,1]; gates the costlier ripple octave
  uniform float uOrbR;
  uniform vec3 uSky;
  uniform vec3 uDeep;
  uniform vec3 uSun;
  uniform vec3 uSunDir;
  uniform vec3 uCam;
  varying vec3 vWorld;

  // Surface height field. At rest the water is almost a mirror — a single very
  // slow, very small swell keeps it from looking dead-flat. The real ripples are
  // concentric rings radiating from the orb, gated on speak: basically nothing
  // until the agent talks, then they swell and quicken with the voice.
  float ripples(vec2 p, float t, float speak, float q){
    float h = sin((p.x + p.y) * 1.3 + t * 0.12) * 0.004;
    float d = length(p);
    float speed = t * (0.5 + speak * 2.5);
    h += sin(d * 7.0 - speed * 3.0) * exp(-d * 0.4) * speak * 0.16;
    if (q > 0.5) {
      h += sin(p.x * 9.0 - speed * 4.0) * sin(p.y * 8.0 + speed * 3.5) * speak * 0.05;
    }
    return h;
  }

  vec3 waterNormal(vec2 p, float t, float speak, float q){
    float e = 0.07;
    float hL = ripples(p - vec2(e, 0.0), t, speak, q);
    float hR = ripples(p + vec2(e, 0.0), t, speak, q);
    float hD = ripples(p - vec2(0.0, e), t, speak, q);
    float hU = ripples(p + vec2(0.0, e), t, speak, q);
    return normalize(vec3(hL - hR, 2.0 * e, hD - hU));
  }

  // The orange sky the water mirrors: a vertical gradient with a white sun.
  vec3 skyColor(vec3 dir){
    float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uSky * 0.8, uSky * 1.1 + vec3(0.05), up);
    vec3 sd = normalize(uSunDir);
    float s = max(dot(normalize(dir), sd), 0.0);
    col += uSun * pow(s, 60.0) * 1.4;
    col += uSun * pow(s, 6.0) * 0.18;
    return col;
  }

  void main(){
    vec3 p3 = vWorld;
    vec2 p = p3.xz;
    vec3 N = waterNormal(p, uTime, uSpeak, uQuality);
    vec3 V = normalize(uCam - p3);
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 refl = skyColor(R);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    fres = mix(0.06, 1.0, fres);
    vec3 col = mix(uDeep, refl, fres);

    // Glints where the surface tilts, brighter while the agent speaks.
    float slope = 1.0 - N.y;
    col += uSun * pow(slope, 2.0) * (0.25 + uSpeak * 1.1);

    // A soft meniscus where the water meets the orb.
    float d = length(p);
    col += uSun * exp(-abs(d - uOrbR) * 14.0) * 0.12;

    // Melt the far edge of the plane into the sky so it reads as a horizon.
    float dist = length(uCam.xz - p);
    col = mix(col, uSky, smoothstep(12.0, 28.0, dist));
    gl_FragColor = vec4(col, 1.0);
  }
`;

function backgroundColor(T: Three, hex: number): THREE.Color {
  return new T.Color(hex);
}

/**
 * The default: a small glass orb half-submerged in a full-screen sheet of
 * water. The orb reflects a procedurally generated orange sky; the water
 * mirrors that same sky and ripples outward from the orb while the agent
 * speaks. Tilts the shared camera to look across the water and restores it on
 * dispose so the other presets get an untouched camera back.
 */
function fresnelCrystalBall(ctx: SceneRenderContext): SceneInstance {
  const T = ctx.three as Three;
  const scene = ctx.scene as THREE.Scene;
  const camera = ctx.camera as THREE.PerspectiveCamera;
  const renderer = ctx.renderer as THREE.WebGLRenderer;

  // Locked to the onboarding brand orange — never theme-derived — so the water
  // colour stays identical to onboarding and never changes.
  const sky = new T.Color(BRAND_ORANGE);
  scene.background = sky.clone();

  // Look down across the water at the half-sunk orb, restoring the shared
  // camera's framing on dispose.
  const camPos0 = camera.position.clone();
  const camQuat0 = camera.quaternion.clone();
  const camUp0 = camera.up.clone();
  // Look straight down onto the water so the orb sits in a top-down pond and
  // ripples read as clean concentric rings. `up` must be re-aimed first — it
  // can't stay +Y, which is now the view axis.
  camera.up.set(0, 0, -1);
  camera.position.set(0, CAM_HEIGHT, 0);
  camera.lookAt(0, 0, 0);

  // Generative environment: an orange sky gradient with a white sun, baked into
  // a prefiltered env map so the glass orb reflects something with structure.
  const envCanvas = document.createElement("canvas");
  envCanvas.width = 512;
  envCanvas.height = 256;
  const g = envCanvas.getContext("2d");
  const toHex = (c: THREE.Color) => `#${c.getHexString()}`;
  if (g) {
    const grad = g.createLinearGradient(0, 0, 0, envCanvas.height);
    grad.addColorStop(
      0.0,
      toHex(sky.clone().lerp(new T.Color(0xffffff), 0.32)),
    );
    grad.addColorStop(0.46, toHex(sky));
    grad.addColorStop(
      0.5,
      toHex(sky.clone().lerp(new T.Color(0xffffff), 0.55)),
    );
    grad.addColorStop(0.54, toHex(sky));
    grad.addColorStop(1.0, toHex(sky.clone().multiplyScalar(0.7)));
    g.fillStyle = grad;
    g.fillRect(0, 0, envCanvas.width, envCanvas.height);
    const sx = envCanvas.width * 0.66;
    const sy = envCanvas.height * 0.33;
    const sun = g.createRadialGradient(sx, sy, 0, sx, sy, 96);
    sun.addColorStop(0, "rgba(255,255,255,1)");
    sun.addColorStop(0.3, "rgba(255,243,225,0.85)");
    sun.addColorStop(1, "rgba(255,210,160,0)");
    g.fillStyle = sun;
    g.fillRect(0, 0, envCanvas.width, envCanvas.height);
  }
  const envTex = new T.CanvasTexture(envCanvas);
  envTex.mapping = T.EquirectangularReflectionMapping;
  envTex.colorSpace = T.SRGBColorSpace;
  const pmrem = new T.PMREMGenerator(renderer);
  const envRT = pmrem.fromEquirectangular(envTex);
  pmrem.dispose();
  envTex.dispose();
  scene.environment = envRT.texture;

  const sunDir = new T.Vector3(0.45, 0.72, 0.5).normalize();
  const keyLight = new T.DirectionalLight(0xffffff, 1.1);
  keyLight.position.copy(sunDir).multiplyScalar(5);
  scene.add(keyLight);
  const ambient = new T.AmbientLight(0xffffff, 0.35);
  scene.add(ambient);

  // The Eliza mark, painted (white) onto a brand-orange card that sits just
  // inside the orb facing the camera. The card is opaque so the glass refracts
  // it; dispersion then rainbow-splits it — the mark reads as projected and
  // diffracted through the marble. The SVG loads async; until then the card is
  // plain orange and simply blends into the water.
  const logoCanvas = document.createElement("canvas");
  logoCanvas.width = 256;
  logoCanvas.height = 256;
  const lg = logoCanvas.getContext("2d");
  const paintLogoCard = () => {
    if (!lg) return;
    lg.fillStyle = `#${new T.Color(BRAND_ORANGE).getHexString()}`;
    lg.fillRect(0, 0, 256, 256);
  };
  paintLogoCard();
  const logoTex = new T.CanvasTexture(logoCanvas);
  logoTex.colorSpace = T.SRGBColorSpace;
  const logoImg = new Image();
  logoImg.crossOrigin = "anonymous";
  logoImg.onload = () => {
    if (!lg) return;
    const s = 256 * 0.66;
    const o = (256 - s) / 2;
    // Bake a chromatic-aberration split into the mark (red/blue fringes) so it
    // reads as diffracted even at a small orb size, on top of whatever extra
    // dispersion the glass itself contributes.
    const channel = (tint: string, dx: number): HTMLCanvasElement => {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 256;
      const cx = c.getContext("2d");
      if (cx) {
        cx.drawImage(logoImg, o + dx, o, s, s);
        cx.globalCompositeOperation = "source-in";
        cx.fillStyle = tint;
        cx.fillRect(0, 0, 256, 256);
      }
      return c;
    };
    const mark = document.createElement("canvas");
    mark.width = 256;
    mark.height = 256;
    const mx = mark.getContext("2d");
    if (mx) {
      mx.globalCompositeOperation = "lighter";
      mx.drawImage(channel("#ff4040", -6), 0, 0);
      mx.drawImage(channel("#40ff40", 0), 0, 0);
      mx.drawImage(channel("#4040ff", 6), 0, 0);
    }
    paintLogoCard();
    lg.drawImage(mark, 0, 0);
    logoTex.needsUpdate = true;
  };
  logoImg.src = resolveAppAssetUrl("/brand/logos/logo_white_nobg.svg");
  const logoMesh = new T.Mesh(
    new T.CircleGeometry(ORB_RADIUS * 0.78, 48),
    new T.MeshBasicMaterial({ map: logoTex }),
  );
  logoMesh.rotation.x = -Math.PI / 2; // lie flat, face up at the top-down camera
  logoMesh.position.y = ORB_RADIUS * 0.45;
  scene.add(logoMesh);

  // The glass orb, centered at the origin so the water plane (y=0) bisects it.
  // Full transmission + dispersion makes a clear marble that refracts and
  // chromatically splits the mark suspended inside it.
  let segments = 48;
  let orbGeo = new T.SphereGeometry(ORB_RADIUS, segments, segments);
  const orbMat = new T.MeshPhysicalMaterial({
    color: new T.Color(0xffffff),
    metalness: 0,
    roughness: 0.02,
    transmission: 1,
    thickness: ORB_RADIUS * 0.35,
    ior: 1.05,
    dispersion: 8,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 0.85,
    transparent: true,
  });
  const orb = new T.Mesh(orbGeo, orbMat);
  scene.add(orb);

  // The full-screen water sheet. Opaque, so the orb's submerged half is hidden
  // beneath the surface and only the dome above the waterline shows.
  const waterUniforms = {
    uTime: { value: 0 },
    uSpeak: { value: 0 },
    uQuality: { value: 1 },
    uOrbR: { value: ORB_RADIUS },
    // Both flat brand orange so the water surface reads as the onboarding colour
    // at rest; the white sun only shows up as glints on ripples while speaking.
    uSky: { value: sky.clone() },
    uDeep: { value: sky.clone() },
    uSun: { value: new T.Color(0xffffff) },
    uSunDir: { value: sunDir.clone() },
    uCam: { value: new T.Vector3() },
  };
  const waterMat = new T.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: waterUniforms,
  });
  const water = new T.Mesh(new T.PlaneGeometry(60, 60), waterMat);
  water.rotation.x = -Math.PI / 2;
  scene.add(water);

  let speak = 0;

  return {
    update(dt, time) {
      // Ease ripple strength toward the assistant's voice so rings build and
      // settle smoothly instead of snapping each frame.
      const target = ctx.inputs.audioAssistant + ctx.inputs.audioUser * 0.3;
      speak += (target - speak) * Math.min(1, dt * 6);
      waterUniforms.uTime.value = time;
      waterUniforms.uSpeak.value = speak;
      (waterUniforms.uCam.value as THREE.Vector3).copy(camera.position);
      // A slow spin keeps the reflections moving; a faint bob while speaking.
      // The mark rides with the orb so it stays centred inside the glass.
      orb.rotation.y = time * 0.12;
      const bob = Math.sin(time * 1.6) * ORB_RADIUS * 0.1 * speak;
      orb.position.y = bob;
      logoMesh.position.y = ORB_RADIUS * 0.45 + bob;
    },
    optimize(tier) {
      waterUniforms.uQuality.value = tier;
      orbMat.transmission = tier < 0.4 ? 0 : 1;
      orbMat.dispersion = tier < 0.6 ? 0 : 5;
      const next = Math.max(16, Math.round(16 + tier * 40));
      if (next !== segments) {
        segments = next;
        const old = orbGeo;
        orbGeo = new T.SphereGeometry(ORB_RADIUS, segments, segments);
        orb.geometry = orbGeo;
        old.dispose();
      }
      return tier;
    },
    dispose() {
      scene.remove(orb, water, keyLight, ambient, logoMesh);
      orbGeo.dispose();
      orbMat.dispose();
      water.geometry.dispose();
      waterMat.dispose();
      logoMesh.geometry.dispose();
      (logoMesh.material as THREE.Material).dispose();
      logoTex.dispose();
      envRT.dispose();
      scene.environment = null;
      camera.position.copy(camPos0);
      camera.quaternion.copy(camQuat0);
      camera.up.copy(camUp0);
      camera.updateProjectionMatrix();
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
