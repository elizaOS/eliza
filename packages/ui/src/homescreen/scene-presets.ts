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
import {
  applyParams,
  createDirector,
  type Director,
  RIG_SVG,
} from "./face-rig/rigRuntime";
import { registerPreset } from "./scene-runtime";
import {
  BUILTIN_PRESETS,
  type SceneInstance,
  type SceneRenderContext,
} from "./scene-types";

type Three = typeof THREE;

// Neutral dark water/sky colors for the home surface. Keep this away from warm
// red/mauve so the screen reads as black glass instead of an orange brand wash.
const SURFACE_SKY = 0x111318;
const SURFACE_DEEP = 0x030405;

// A small glass marble set into the water. Keep it compact so the home chrome
// has room, even when the chat composer is open.
const ORB_RADIUS = 0.08;

// Lift the whole sphere clear of the surface so it reads as a full crystal ball
// resting on the water, not a half-sunk dome cut by a waterline at its equator.
const ORB_LIFT = ORB_RADIUS;

// Height of the straight-down camera above the water. Lower = the orb (and the
// face inside it) reads larger; higher = more open water around it.
const CAM_HEIGHT = 2.5;

// World-Z the camera looks straight down at. The orb sits at the origin, so a
// POSITIVE view-z pushes the orb toward the TOP of the screen (above the apps);
// larger = higher. Tuned so the orb keeps a small top margin (roughly matching
// the composer pill's bottom margin) rather than jamming against the top edge.
const ORB_VIEW_Z = 0.82;

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

  // The dark neutral sky the water mirrors: mostly black with white glints.
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

    // A soft contact shadow directly under the resting ball grounds it on the
    // water without the hard bright rim a meniscus highlight produced.
    float d = length(p);
    col *= 1.0 - smoothstep(uOrbR * 1.6, uOrbR * 0.2, d) * 0.22;

    // Melt the far edge of the plane into the sky so it reads as a horizon.
    float dist = length(uCam.xz - p);
    col = mix(col, uSky, smoothstep(12.0, 28.0, dist));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const ORB_AURA_VERT = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormal;
  void main(){
    vPos = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ORB_AURA_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uEnergy;
  varying vec3 vPos;
  varying vec3 vNormal;

  float stripe(float v, float width){
    return smoothstep(width, 0.0, abs(fract(v) - 0.5));
  }

  void main(){
    vec3 n = normalize(vNormal);
    float rim = pow(1.0 - abs(n.y), 1.55);
    float latitude = atan(vPos.z, vPos.x) / 6.2831853 + 0.5;
    float radius = length(vPos.xz);
    float swirl = latitude * 4.0 + radius * 18.0 - vPos.y * 9.0 + uTime * 0.22;
    float rings = stripe(vPos.y * 7.0 + sin(swirl) * 0.25 - uTime * 0.16, 0.21);
    float arcs = stripe(latitude * 4.0 + sin(vPos.y * 10.0 + uTime * 0.35) * 0.14 + uTime * 0.08, 0.26);
    float ember = stripe(latitude * 2.0 - radius * 8.0 + uTime * 0.12, 0.18) * smoothstep(-0.6, 0.3, -vPos.y);
    float pulse = 0.55 + 0.45 * sin(uTime * 1.8 + vPos.y * 18.0);
    float alpha = (0.16 + uEnergy * 0.46) * rim + rings * arcs * (0.32 + uEnergy * 0.42) + ember * 0.24;
    vec3 blackBlue = vec3(0.01, 0.025, 0.055);
    vec3 blue = vec3(0.06, 0.42, 1.0);
    vec3 orange = vec3(1.0, 0.42, 0.08);
    vec3 gray = vec3(0.55, 0.62, 0.68);
    vec3 cyan = vec3(0.30, 0.92, 1.0);
    vec3 white = vec3(1.0);
    vec3 color = mix(blackBlue, blue, smoothstep(-0.9, 0.6, sin(swirl)));
    color = mix(color, orange, ember * 0.75 + smoothstep(0.68, 0.98, sin(swirl * 0.7 - uTime * 0.45)) * 0.18);
    color = mix(color, gray, smoothstep(0.15, 0.9, n.y) * 0.18);
    color += cyan * rings * 0.32;
    color = mix(color, white, rings * arcs * 0.34 + pulse * 0.1);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.82));
  }
`;

const ORB_GLASS_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main(){
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const ORB_GLASS_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform float uEnergy;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  void main(){
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vViewPosition);
    float fresnel = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 2.15);
    float upperCrescent = smoothstep(0.02, 0.72, n.y) * smoothstep(-0.75, 0.12, -n.x);
    float lowerPrism = smoothstep(-0.72, -0.18, n.y) * smoothstep(-0.45, 0.55, n.x);
    float sweep = smoothstep(0.985, 1.0, sin((n.x * 2.2 + n.z * 1.4) * 3.14159 + uTime * 0.8));
    vec3 rimColor = mix(vec3(0.62, 0.92, 1.0), vec3(1.0), fresnel);
    vec3 prismColor = mix(vec3(0.36, 0.86, 1.0), vec3(0.78, 0.50, 1.0), smoothstep(-0.7, 0.5, n.z));
    vec3 color = rimColor * (fresnel * 0.9 + upperCrescent * 0.42);
    color += prismColor * (lowerPrism * 0.26 + sweep * (0.16 + uEnergy * 0.2));
    color += vec3(1.0) * smoothstep(0.94, 1.0, n.y + n.x * 0.34) * 0.5;
    float alpha = clamp(0.09 + fresnel * 0.58 + upperCrescent * 0.22 + sweep * 0.18, 0.0, 0.82);
    gl_FragColor = vec4(color, alpha);
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

  const sky = new T.Color(SURFACE_SKY);
  scene.background = new T.Color(0x060606);

  // Look down across the water at the half-sunk orb, restoring the shared
  // camera's framing on dispose.
  const camPos0 = camera.position.clone();
  const camQuat0 = camera.quaternion.clone();
  const camUp0 = camera.up.clone();
  // Look straight down onto the water so the orb sits in a top-down pond and
  // ripples read as clean concentric rings. `up` must be re-aimed first — it
  // can't stay +Y, which is now the view axis.
  camera.up.set(0, 0, -1);
  camera.position.set(0, CAM_HEIGHT, ORB_VIEW_Z);
  camera.lookAt(0, 0, ORB_VIEW_Z);

  // Generative environment: a neutral sky/glass studio with a white sun, baked
  // into a prefiltered env map so the orb reflects bright structure instead of
  // filling with the warm water color behind it.
  const envCanvas = document.createElement("canvas");
  envCanvas.width = 512;
  envCanvas.height = 256;
  const g = envCanvas.getContext("2d");
  const toHex = (c: THREE.Color) => `#${c.getHexString()}`;
  if (g) {
    const skyGlass = new T.Color(0xeaf4ff);
    const horizonGlass = new T.Color(0xffffff);
    const deepGlass = new T.Color(0x071018);
    const grad = g.createLinearGradient(0, 0, 0, envCanvas.height);
    grad.addColorStop(0.0, toHex(skyGlass));
    grad.addColorStop(0.42, toHex(horizonGlass));
    grad.addColorStop(0.52, toHex(new T.Color(0xd7e7f7)));
    grad.addColorStop(0.76, toHex(new T.Color(0x203040)));
    grad.addColorStop(1.0, toHex(deepGlass));
    g.fillStyle = grad;
    g.fillRect(0, 0, envCanvas.width, envCanvas.height);
    const sx = envCanvas.width * 0.66;
    const sy = envCanvas.height * 0.33;
    const sun = g.createRadialGradient(sx, sy, 0, sx, sy, 96);
    sun.addColorStop(0, "rgba(255,255,255,1)");
    sun.addColorStop(0.3, "rgba(230,244,255,0.85)");
    sun.addColorStop(1, "rgba(180,210,255,0)");
    g.fillStyle = sun;
    g.fillRect(0, 0, envCanvas.width, envCanvas.height);

    // Tall white panels and a thin horizon line give the small sphere crisp
    // reflection/refraction cues, like a glass object in a studio light box.
    g.fillStyle = "rgba(255,255,255,0.86)";
    g.fillRect(envCanvas.width * 0.1, 0, 18, envCanvas.height * 0.86);
    g.fillStyle = "rgba(255,255,255,0.72)";
    g.fillRect(envCanvas.width * 0.84, 8, 12, envCanvas.height * 0.72);
    g.fillStyle = "rgba(255,255,255,0.42)";
    g.fillRect(0, envCanvas.height * 0.49, envCanvas.width, 3);
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
  const ambient = new T.AmbientLight(0xffffff, 0.15);
  scene.add(ambient);

  // Eased assistant-voice level, shared by the water ripples and the face's jaw.
  let speak = 0;

  // Smoothed tilt of the face card — follows pointer drag to pivot the lens.
  let tiltX = 0; // left/right tilt (drives faceMesh rotation.z)
  let tiltY = 0; // forward/back tilt (drives faceMesh rotation.x offset)

  // The live Eliza face rig, keyed to its luminance so ONLY the white face marks
  // survive: the rig's black features (iris, glasses, brows, mouth) and the empty
  // SVG background fall to full transparency. There is no card — the glass orb
  // refracts a clean white silhouette floating in clear crystal, with the dark
  // features reading as clear cut-outs.
  const RIG_TEX = 256;
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = RIG_TEX;
  faceCanvas.height = RIG_TEX;
  const fg = faceCanvas.getContext("2d");
  const clearFaceCanvas = (): void => {
    if (!fg) return;
    fg.clearRect(0, 0, RIG_TEX, RIG_TEX);
  };
  clearFaceCanvas();
  const faceTex = new T.CanvasTexture(faceCanvas);
  faceTex.colorSpace = T.SRGBColorSpace;

  const auraUniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
  };
  const auraMat = new T.ShaderMaterial({
    vertexShader: ORB_AURA_VERT,
    fragmentShader: ORB_AURA_FRAG,
    uniforms: auraUniforms,
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
  });
  const auraGeo = new T.SphereGeometry(ORB_RADIUS * 0.76, 48, 32);
  const aura = new T.Mesh(auraGeo, auraMat);
  aura.position.y = ORB_LIFT;
  scene.add(aura);

  const glassUniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
  };
  const glassShellMat = new T.ShaderMaterial({
    vertexShader: ORB_GLASS_VERT,
    fragmentShader: ORB_GLASS_FRAG,
    uniforms: glassUniforms,
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
  });
  const glassShellGeo = new T.SphereGeometry(ORB_RADIUS * 1.035, 64, 48);
  const glassShell = new T.Mesh(glassShellGeo, glassShellMat);
  glassShell.position.y = ORB_LIFT;
  glassShell.renderOrder = 20;
  scene.add(glassShell);

  const ringMatA = new T.MeshBasicMaterial({
    color: new T.Color(0x7defff),
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    blending: T.AdditiveBlending,
  });
  const ringMatB = new T.MeshBasicMaterial({
    color: new T.Color(0xb38cff),
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: T.AdditiveBlending,
  });
  const ringGeoA = new T.TorusGeometry(
    ORB_RADIUS * 0.58,
    ORB_RADIUS * 0.012,
    8,
    96,
  );
  const ringGeoB = new T.TorusGeometry(
    ORB_RADIUS * 0.38,
    ORB_RADIUS * 0.009,
    8,
    96,
  );
  const ringA = new T.Mesh(ringGeoA, ringMatA);
  const ringB = new T.Mesh(ringGeoB, ringMatB);
  const ringC = new T.Mesh(ringGeoA.clone(), ringMatB.clone());
  for (const ring of [ringA, ringB, ringC]) {
    ring.rotation.x = Math.PI / 2;
    ring.position.y = ORB_LIFT + ORB_RADIUS * 0.08;
    scene.add(ring);
  }
  ringB.rotation.z = Math.PI / 3;
  ringC.rotation.z = -Math.PI / 4;
  ringC.scale.setScalar(0.78);

  const particleCount = 32;
  const particlePositions = new Float32Array(particleCount * 3);
  const particleColors = new Float32Array(particleCount * 3);
  const particlePhases: number[] = [];
  const particlePalette = [
    new T.Color(0x7fa7c4),
    new T.Color(0xdce7ef),
    new T.Color(0xc8793a),
    new T.Color(0x7f8892),
  ];
  for (let i = 0; i < particleCount; i += 1) {
    const a = i * 2.39996323;
    const y = -0.58 + (i / Math.max(1, particleCount - 1)) * 1.16;
    const r = Math.sqrt(Math.max(0, 1 - y * y)) * ORB_RADIUS * 0.52;
    const wobble = 0.66 + ((i * 37) % 29) / 100;
    particlePositions[i * 3] = Math.cos(a) * r * wobble;
    particlePositions[i * 3 + 1] = ORB_LIFT + y * ORB_RADIUS * 0.7;
    particlePositions[i * 3 + 2] = Math.sin(a) * r * wobble;
    const color = particlePalette[i % particlePalette.length];
    particleColors[i * 3] = color.r;
    particleColors[i * 3 + 1] = color.g;
    particleColors[i * 3 + 2] = color.b;
    particlePhases.push(a);
  }
  const particleGeo = new T.BufferGeometry();
  particleGeo.setAttribute(
    "position",
    new T.BufferAttribute(particlePositions, 3),
  );
  particleGeo.setAttribute("color", new T.BufferAttribute(particleColors, 3));
  const particleMat = new T.PointsMaterial({
    size: ORB_RADIUS * 0.028,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.34,
    vertexColors: true,
    depthWrite: false,
  });
  const particles = new T.Points(particleGeo, particleMat);
  particles.renderOrder = 12;
  scene.add(particles);

  // A detached rig DOM we drive each tick and serialise to an <img> for the
  // canvas. Throttled to ~15fps — plenty for a face and cheap on the frame.
  const rigEl = new DOMParser().parseFromString(RIG_SVG, "image/svg+xml")
    .documentElement as unknown as SVGSVGElement;
  rigEl.setAttribute("width", "423");
  rigEl.setAttribute("height", "423");
  const director: Director = createDirector();
  const rigImg = new Image();
  let rigBusy = false;
  let rigClock = 0;
  rigImg.onload = (): void => {
    if (fg) {
      clearFaceCanvas();
      fg.drawImage(rigImg, 0, 0, RIG_TEX, RIG_TEX);
      // Key to white-only: alpha := perceptual luminance, rgb := white. The rig's
      // black features and transparent background drop to alpha 0, so the orb is
      // left refracting a clean white face mark with clear cut-outs rather than an
      // opaque disk.
      const px = fg.getImageData(0, 0, RIG_TEX, RIG_TEX);
      const d = px.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum =
          (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) *
          (d[i + 3] / 255);
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = lum;
      }
      fg.putImageData(px, 0, 0);
      faceTex.needsUpdate = true;
    }
    rigBusy = false;
  };
  rigImg.onerror = (): void => {
    rigBusy = false;
  };
  const driveFace = (dt: number): void => {
    rigClock += dt;
    if (rigBusy || rigClock < 1 / 15) return;
    const frame = director.tick(rigClock, { blink: true, idle: true });
    frame.jaw = Math.max(frame.jaw, speak); // lip-sync the jaw to the voice
    rigClock = 0;
    applyParams(rigEl, frame);
    rigBusy = true;
    rigImg.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      new XMLSerializer().serializeToString(rigEl),
    )}`;
  };

  const faceMesh = new T.Mesh(
    // Stay safely inside the sphere at this height — at y=0.40×R the orb
    // cross-section radius is ~0.92×R, so 0.84×R gives comfortable clearance.
    new T.CircleGeometry(ORB_RADIUS * 0.84, 64),
    // Opaque (not transparent) so it renders in the opaque pass and is captured
    // by the glass's transmission background — that's what refracts/distorts it
    // inside the orb. alphaTest discards the keyed-out texels (everything that
    // isn't the white face) so they read as clear glass, not a black disk.
    new T.MeshBasicMaterial({ map: faceTex, alphaTest: 0.35 }),
  );
  faceMesh.rotation.x = -Math.PI / 2; // lie flat, face up at the top-down camera
  const FACE_Y = ORB_LIFT + ORB_RADIUS * 0.4;
  faceMesh.position.y = FACE_Y;
  scene.add(faceMesh);

  // The glass orb, centered at the origin so the water plane (y=0) bisects it.
  // Full transmission + dispersion makes a clear marble that refracts and
  // chromatically splits the mark suspended inside it.
  let segments = 48;
  let orbGeo = new T.SphereGeometry(ORB_RADIUS, segments, segments);
  const orbMat = new T.MeshPhysicalMaterial({
    color: new T.Color(0xf8fbff),
    metalness: 0,
    roughness: 0.012,
    transmission: 0.56,
    thickness: ORB_RADIUS * 0.28,
    ior: 1.18, // glass — enough refraction without amber fill from the water
    dispersion: 1.4,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    envMapIntensity: 4.2,
    opacity: 0.7,
    transparent: true,
  });
  const orb = new T.Mesh(orbGeo, orbMat);
  orb.position.y = ORB_LIFT;
  scene.add(orb);

  // Scratch vectors for projecting the orb to screen space each frame (reused
  // to avoid per-frame allocation in the hot update loop).
  const projCenter = new T.Vector3();
  const projEdge = new T.Vector3();

  // The full-screen water sheet. Opaque, so the orb's submerged half is hidden
  // beneath the surface and only the dome above the waterline shows.
  const waterUniforms = {
    uTime: { value: 0 },
    uSpeak: { value: 0 },
    uQuality: { value: 1 },
    uOrbR: { value: ORB_RADIUS },
    uSky: { value: sky.clone() },
    uDeep: { value: new T.Color(SURFACE_DEEP) },
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

  return {
    update(dt, time) {
      // Ease ripple strength toward the assistant's voice so rings build and
      // settle smoothly instead of snapping each frame.
      const target = ctx.inputs.audioAssistant + ctx.inputs.audioUser * 0.3;
      speak += (target - speak) * Math.min(1, dt * 6);
      waterUniforms.uTime.value = time;
      waterUniforms.uSpeak.value = speak;
      (waterUniforms.uCam.value as THREE.Vector3).copy(camera.position);
      auraUniforms.uTime.value = time;
      auraUniforms.uEnergy.value = Math.min(1, 0.25 + speak * 1.4);
      glassUniforms.uTime.value = time;
      glassUniforms.uEnergy.value = Math.min(1, 0.2 + speak * 1.6);

      // Pivot the face card toward the pointer — creates a parallax lens-shift
      // so dragging the orb dynamically changes how the glass refracts the face.
      // pointer.x/y are NDC (-1..1); scale to a gentle max tilt in radians.
      const MAX_TILT = 0.28;
      const px = ctx.inputs.pointer.x;
      const py = ctx.inputs.pointer.y;
      // While the pointer is down, chase it; when released, spring back to
      // a subtle ambient drift so the orb never looks fully static.
      const drag = ctx.inputs.pointer.down;
      const targetX = drag ? px * MAX_TILT : Math.sin(time * 0.31) * 0.04;
      const targetY = drag ? py * MAX_TILT : Math.cos(time * 0.23) * 0.03;
      const ease = Math.min(1, dt * (drag ? 7 : 2.5));
      tiltX += (targetX - tiltX) * ease;
      tiltY += (targetY - tiltY) * ease;
      faceMesh.rotation.set(-Math.PI / 2 + tiltY, 0, tiltX);

      // A faint bob while speaking; the face rides with the orb so it stays
      // centred inside the glass.
      const bob = Math.sin(time * 1.6) * ORB_RADIUS * 0.1 * speak;
      orb.position.y = ORB_LIFT + bob;
      aura.position.y = ORB_LIFT + bob * 0.8;
      aura.rotation.y = time * 0.18;
      aura.rotation.z = Math.sin(time * 0.27) * 0.18;
      glassShell.position.y = ORB_LIFT + bob;
      glassShell.rotation.y = -time * 0.08;
      ringA.position.y = ORB_LIFT + ORB_RADIUS * 0.02 + bob * 0.75;
      ringB.position.y = ORB_LIFT + ORB_RADIUS * 0.14 + bob * 0.65;
      ringC.position.y = ORB_LIFT - ORB_RADIUS * 0.08 + bob * 0.55;
      ringA.rotation.z = time * 0.45;
      ringB.rotation.z = Math.PI / 3 - time * 0.34;
      ringC.rotation.z = -Math.PI / 4 + time * 0.26;
      ringMatA.opacity = 0.46 + speak * 0.42;
      ringMatB.opacity = 0.36 + speak * 0.34;
      const pos = particleGeo.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < particleCount; i += 1) {
        const phase = particlePhases[i];
        const ix = i * 3;
        const baseX = particlePositions[ix];
        const baseY = particlePositions[ix + 1] - ORB_LIFT;
        const baseZ = particlePositions[ix + 2];
        const spin = time * (0.08 + (i % 5) * 0.012) + phase;
        const lift = Math.sin(time * 0.28 + phase) * ORB_RADIUS * 0.024;
        pos.setXYZ(
          i,
          baseX * Math.cos(spin * 0.08) - baseZ * Math.sin(spin * 0.08),
          ORB_LIFT + baseY + lift + bob * 0.45,
          baseX * Math.sin(spin * 0.08) + baseZ * Math.cos(spin * 0.08),
        );
      }
      pos.needsUpdate = true;
      particleMat.opacity = 0.26 + speak * 0.1;
      faceMesh.position.y = FACE_Y + bob;
      driveFace(dt);

      // Report the orb's projected screen position so the React layer can anchor
      // its hit target and expand animation to the actual rendered orb. Project
      // the center plus a vertical-edge point (offset along the camera's up axis)
      // to derive the on-screen radius. NDC is [-1,1] (y up); convert to canvas
      // fractions [0,1] (y down).
      projCenter.copy(orb.position).project(camera);
      projEdge
        .copy(orb.position)
        .addScaledVector(camera.up, ORB_RADIUS)
        .project(camera);
      ctx.outputs.orbAnchor = {
        x: (projCenter.x + 1) / 2,
        y: (1 - projCenter.y) / 2,
        r: Math.abs(projEdge.y - projCenter.y) / 2,
      };
    },
    optimize(tier) {
      waterUniforms.uQuality.value = tier;
      // Below the transmission tier, drop the (expensive) refraction pass but
      // keep the orb visible as a frosted semi-opaque ball instead of letting a
      // transmission=0 transparent material vanish entirely.
      if (tier < 0.4) {
        orbMat.transmission = 0;
        orbMat.opacity = 0.8;
        orbMat.roughness = 0.35;
        ringMatA.opacity = 0.24;
        ringMatB.opacity = 0.2;
      } else {
        orbMat.transmission = 0.56;
        orbMat.opacity = 0.7;
        orbMat.roughness = 0.012;
      }
      orbMat.dispersion = tier < 0.4 ? 0 : tier < 0.6 ? 1 : 3;
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
      scene.remove(
        orb,
        water,
        keyLight,
        ambient,
        faceMesh,
        aura,
        ringA,
        ringB,
        ringC,
        glassShell,
        particles,
      );
      orbGeo.dispose();
      orbMat.dispose();
      auraGeo.dispose();
      auraMat.dispose();
      glassShellGeo.dispose();
      glassShellMat.dispose();
      ringGeoA.dispose();
      ringGeoB.dispose();
      ringMatA.dispose();
      ringMatB.dispose();
      (ringC.material as THREE.Material).dispose();
      ringC.geometry.dispose();
      particleGeo.dispose();
      particleMat.dispose();
      water.geometry.dispose();
      waterMat.dispose();
      faceMesh.geometry.dispose();
      (faceMesh.material as THREE.Material).dispose();
      faceTex.dispose();
      rigImg.onload = null;
      rigImg.onerror = null;
      rigImg.src = "";
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
