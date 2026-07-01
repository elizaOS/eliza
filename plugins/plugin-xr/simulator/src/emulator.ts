/**
 * XR Emulator — browser-side IIFE injected by Playwright via page.addInitScript().
 *
 * What it does:
 *  1. Installs IWER (immersive-web-emulation-runtime) to polyfill navigator.xr
 *     with a controllable Quest 3 device.
 *  2. Overrides navigator.mediaDevices.getUserMedia to return:
 *     - Video: a canvas-captureStream() that Playwright can paint frames onto.
 *     - Audio: a synthetic silence stream (real audio comes via __xrTestHooks).
 *  3. Exposes window.__XREmulator with a programmatic control API.
 *
 * Fork baseline: meta-quest/immersive-web-emulator
 * Additions: camera frame injection, audio stream mock, __XREmulator control API.
 *
 * rawCameraAccess simulation:
 *   The experimental WebXR rawCameraAccess path (XRWebGLBinding.getCameraImage) is
 *   outside IWER's current emulation surface, so app-xr automatically falls back to the getUserMedia
 *   video track (Path 3). Injecting frames via __XREmulator.injectCameraFrame() paints
 *   onto the canvas that feeds getUserMedia, making injected frames reachable by both
 *   the getUserMedia path and any code that reads the canvas directly.
 */

import { metaQuest3, XRDevice } from "iwer";
import type {
  AimingRay,
  DeviceRay,
  ElementTelemetry,
  EmulatorStats,
  Handedness,
  HitResult,
  InputEventRecord,
  Quat,
  TelemetrySnapshot,
  Vec3,
  XREmulatorAPI,
  XRPose,
  XRSceneBridge,
  XRSessionMode,
} from "./types.ts";

// ── Camera canvas ─────────────────────────────────────────────────────────

const cameraCanvas = document.createElement("canvas");
cameraCanvas.width = 640;
cameraCanvas.height = 480;
const cameraCtx = cameraCanvas.getContext("2d")!;

// Fill with a recognisable test pattern (grey + crosshair)
function drawTestPattern(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = "#333";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#0f0";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.fillStyle = "#0f0";
  ctx.font = "16px monospace";
  ctx.fillText("XR SIMULATOR", 12, 24);
}
drawTestPattern(cameraCtx, 640, 480);

const cameraStream = cameraCanvas.captureStream(30); // 30 fps canvas stream

// ── Audio stream (silence) ───────────────────────────────────────────────

function createSilentAudioStream(): MediaStream {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  // Connect a silent oscillator at 0 gain to keep the stream alive
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const osc = ctx.createOscillator();
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  return dest.stream;
}

let silentAudioStream: MediaStream | null = null;

// ── getUserMedia override ─────────────────────────────────────────────────

const _originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
  navigator.mediaDevices,
);

navigator.mediaDevices.getUserMedia = async (
  constraints?: MediaStreamConstraints,
): Promise<MediaStream> => {
  const hasVideo = constraints?.video;
  const hasAudio = constraints?.audio;

  if (hasVideo && !hasAudio) {
    // Camera-only: return our canvas stream
    return cameraStream;
  }

  if (hasAudio && !hasVideo) {
    // Mic-only: return synthetic silence
    if (!silentAudioStream) silentAudioStream = createSilentAudioStream();
    return silentAudioStream;
  }

  if (hasVideo && hasAudio) {
    // Combined: merge both tracks into one MediaStream
    if (!silentAudioStream) silentAudioStream = createSilentAudioStream();
    const combined = new MediaStream([
      ...cameraStream.getVideoTracks(),
      ...silentAudioStream.getAudioTracks(),
    ]);
    return combined;
  }

  // Fallback for other constraint shapes
  return _originalGetUserMedia(constraints);
};

// ── IWER XR device ────────────────────────────────────────────────────────

const xrDevice = new XRDevice(metaQuest3);
xrDevice.installRuntime();

// ── State ─────────────────────────────────────────────────────────────────

let framesInjected = 0;
let activeSession: XRSession | null = null;
const installedAt = performance.now();
const frameLog: TelemetrySnapshot[] = [];
const selectLog: InputEventRecord[] = [];
const squeezeLog: InputEventRecord[] = [];
/** Controllers we've given a default hand position (so we don't re-place them). */
const controllerPlaced = new Set<Handedness>();

function handednessOf(
  source: XRInputSource | undefined,
): Handedness | "unknown" {
  if (source?.handedness === "left" || source?.handedness === "right") {
    return source.handedness;
  }
  return "unknown";
}

/** IWER remote device id for a controller. */
function remoteDevice(handedness: Handedness): string {
  return `controller-${handedness}`;
}

/** Run a remote dispatch with a timeout guard so input never hangs the test. */
async function dispatchGuarded(
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  await Promise.race([
    xrDevice.remote.dispatch(method, params).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

// ── Pinhole projection (ray ↔ screen) ──────────────────────────────────────
// "XR" is currently flat 2D DOM (see WEBXR_STATUS in CLAUDE.md), so a device's
// real world-space forward ray is projected onto the viewport with a fixed
// symmetric FOV. project() and quatFromCenter() are exact inverses, so aiming a
// controller at an element's center makes that element the computed hit.

const HALF_FOV = Math.PI / 4; // 90° total field of view

/** The device's forward (-Z) rotated by its orientation quaternion. */
function forward(q: Quat): Vec3 {
  return {
    x: -2 * (q.x * q.z + q.w * q.y),
    y: -2 * (q.y * q.z - q.w * q.x),
    z: -(1 - 2 * (q.x * q.x + q.y * q.y)),
  };
}

/** Project a unit forward direction to a screen-space reticle (CSS px). */
function project(dir: Vec3): { x: number; y: number } {
  const yaw = Math.atan2(dir.x, -dir.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  const nx = 0.5 + (0.5 * yaw) / HALF_FOV;
  const ny = 0.5 - (0.5 * pitch) / HALF_FOV;
  return { x: nx * window.innerWidth, y: ny * window.innerHeight };
}

/** qYaw(around Y) * qPitch(around X). */
function quatFromYawPitch(yaw: number, pitch: number): Quat {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}

/** Orientation whose forward ray projects to the given screen point. */
function quatFromCenter(cx: number, cy: number): Quat {
  const nx = cx / window.innerWidth;
  const ny = cy / window.innerHeight;
  const yaw = (nx - 0.5) * 2 * HALF_FOV;
  const pitch = -(ny - 0.5) * 2 * HALF_FOV;
  return quatFromYawPitch(-yaw, pitch);
}

function vec3(v: { x: number; y: number; z: number }): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}
function quat(q: { x: number; y: number; z: number; w: number }): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function controller(handedness: Handedness) {
  return xrDevice.controllers?.[handedness];
}

function elementIdOf(el: Element | null): string | null {
  if (!el) return null;
  const tagged = el.closest("[data-agent-id]") as HTMLElement | null;
  if (tagged?.dataset.agentId) return tagged.dataset.agentId;
  return el.id || null;
}

// ── 3D scene bridge ─────────────────────────────────────────────────────────
// When an XRSpatialScene (@elizaos/ui/spatial) is mounted it publishes
// window.__elizaXRScene. In that case the emulator drives REAL 3D hit-tests
// (ray ↔ panel-plane in world space) instead of the flat pinhole projection.

function scene(): XRSceneBridge | undefined {
  return window.__elizaXRScene;
}

/** A connected controller's world-space ray (origin + unit forward). */
function controllerRay(handedness: Handedness): DeviceRay | null {
  const c = controller(handedness);
  if (!c?.connected) return null;
  return { origin: vec3(c.position), direction: forward(quat(c.quaternion)) };
}

/** The headset's world-space ray. */
function headRay(): DeviceRay {
  return {
    origin: vec3(xrDevice.position),
    direction: forward(quat(xrDevice.quaternion)),
  };
}

/** Resolve a CSS selector to an agent/element id the scene can address. */
function selectorToElementId(selector: string): string | null {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  return el.dataset.agentId ?? el.id ?? null;
}

/** Place a controller at a natural hand offset from the head (once), if unset. */
function ensureControllerPlaced(handedness: Handedness): void {
  const c = controller(handedness);
  if (!c) return;
  c.connected = true;
  if (controllerPlaced.has(handedness)) return;
  const lateral = handedness === "left" ? -0.2 : 0.2;
  const off = rotateByQuat(quat(xrDevice.quaternion), {
    x: lateral,
    y: -0.25,
    z: -0.15,
  });
  c.position.set(
    xrDevice.position.x + off.x,
    xrDevice.position.y + off.y,
    xrDevice.position.z + off.z,
  );
  controllerPlaced.add(handedness);
}

/** Rotate a vector by a quaternion (shared convention with the scene math). */
function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const qv = { x: q.x, y: q.y, z: q.z };
  const t = {
    x: 2 * (qv.y * v.z - qv.z * v.y),
    y: 2 * (qv.z * v.x - qv.x * v.z),
    z: 2 * (qv.x * v.y - qv.y * v.x),
  };
  return {
    x: v.x + q.w * t.x + (qv.y * t.z - qv.z * t.y),
    y: v.y + q.w * t.y + (qv.z * t.x - qv.x * t.z),
    z: v.z + q.w * t.z + (qv.x * t.y - qv.y * t.x),
  };
}

// ── Control API ───────────────────────────────────────────────────────────

const api: XREmulatorAPI = {
  setPose(pose: Partial<XRPose>) {
    if (pose.position) {
      xrDevice.position.set(pose.position.x, pose.position.y, pose.position.z);
    }
    if (pose.orientation) {
      xrDevice.quaternion.set(
        pose.orientation.x,
        pose.orientation.y,
        pose.orientation.z,
        pose.orientation.w,
      );
    }
  },

  async injectCameraFrame(jpegDataUrl: string): Promise<void> {
    // createImageBitmap is more reliable than new Image() in headless contexts
    const resp = await fetch(jpegDataUrl);
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);
    cameraCtx.drawImage(bmp, 0, 0, cameraCanvas.width, cameraCanvas.height);
    bmp.close();
    framesInjected++;
  },

  getStats(): EmulatorStats {
    const wsConnected =
      typeof window.__xrTestHooks !== "undefined" &&
      window.__xrTestHooks.getSocketState() === "OPEN";
    return {
      sessionActive: activeSession !== null,
      framesInjected,
      cameraStreamActive: cameraStream.active,
      wsConnected,
    };
  },

  async startSession(mode: XRSessionMode = "immersive-vr"): Promise<boolean> {
    if (!navigator.xr) return false;
    if (activeSession) return true;
    const session = await navigator.xr.requestSession(mode);
    session.addEventListener("end", () => {
      activeSession = null;
    });
    session.addEventListener("select", (event) => {
      selectLog.push({
        handedness: handednessOf((event as XRInputSourceEvent).inputSource),
        t: performance.now() - installedAt,
      });
    });
    session.addEventListener("squeeze", (event) => {
      squeezeLog.push({
        handedness: handednessOf((event as XRInputSourceEvent).inputSource),
        t: performance.now() - installedAt,
      });
    });
    activeSession = session;
    return true;
  },

  async endSession(): Promise<void> {
    await activeSession?.end();
    activeSession = null;
  },

  setControllerPose(handedness: Handedness, pose: Partial<XRPose>): void {
    const c = controller(handedness);
    if (!c) return;
    c.connected = true;
    if (pose.position)
      c.position.set(pose.position.x, pose.position.y, pose.position.z);
    if (pose.orientation) {
      c.quaternion.set(
        pose.orientation.x,
        pose.orientation.y,
        pose.orientation.z,
        pose.orientation.w,
      );
    }
  },

  setHandPose(handedness: Handedness, poseId: string): void {
    const h = xrDevice.hands?.[handedness];
    if (!h) return;
    h.connected = true;
    h.poseId = poseId;
    h.updateHandPose?.();
  },

  aimControllerAt(handedness: Handedness, selector: string): boolean {
    const s = scene();
    if (s) {
      // 3D mode: aim the controller's world ray at the element's world position.
      const elementId = selectorToElementId(selector);
      if (!elementId) return false;
      ensureControllerPlaced(handedness);
      const c = controller(handedness);
      if (!c) return false;
      const q = s.aimFor(vec3(c.position), elementId);
      if (!q) return false;
      c.quaternion.set(q.x, q.y, q.z, q.w);
      return true;
    }
    // Flat mode: aim the pinhole reticle at the element's screen center.
    const el = document.querySelector(selector);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const q = quatFromCenter(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    this.setControllerPose(handedness, { orientation: q });
    return true;
  },

  async pressSelect(handedness: Handedness): Promise<void> {
    const c = controller(handedness);
    if (!c) return;
    c.connected = true;
    // In 3D-scene mode, resolve the controller ray to a DOM element and click it
    // so the authored view's real handler fires (the SpatialSurface dispatches
    // the `press` SpatialAction). This is the actual user-facing press path.
    const s = scene();
    const ray = controllerRay(handedness);
    if (s && ray) s.pressRay(ray);
    // Also drive IWER's input: `select` is a session action processed in capture
    // mode (it self-drives the frame queue), firing selectstart→select→selectend.
    await dispatchGuarded("select", { device: remoteDevice(handedness) });
  },

  async pressSqueeze(handedness: Handedness): Promise<void> {
    const c = controller(handedness);
    if (!c) return;
    c.connected = true;
    await dispatchGuarded("set_select_value", {
      device: remoteDevice(handedness),
      value: 1,
    });
    await dispatchGuarded("set_select_value", {
      device: remoteDevice(handedness),
      value: 0,
    });
  },

  getElementTelemetry(selector = "[data-agent-id]"): TelemetrySnapshot {
    const s = scene();
    const elements: ElementTelemetry[] = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const rect = el.getBoundingClientRect();
      const id = (el as HTMLElement).dataset?.agentId ?? el.id;
      if (!id) continue;
      const world = s?.worldPositionOf(id) ?? undefined;
      elements.push({
        elementId: id,
        rect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
        center: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        },
        ...(world ? { world } : {}),
      });
    }

    const rays: AimingRay[] = [];
    const hits: HitResult[] = [];

    if (s) {
      // ── 3D-scene mode: cast world rays, intersect panel planes in world space.
      const addSceneRay = (source: "headset" | Handedness, ray: DeviceRay) => {
        const hit = s.hitTest(ray);
        const reticle = hit ? hit.screen : project(ray.direction);
        rays.push({
          source,
          origin: ray.origin,
          direction: ray.direction,
          reticle,
        });
        hits.push({
          source,
          elementId: hit?.elementId ?? null,
          point: reticle,
          ...(hit ? { world: hit.world, panelId: hit.panelId } : {}),
        });
      };
      addSceneRay("headset", headRay());
      for (const handedness of ["left", "right"] as Handedness[]) {
        const ray = controllerRay(handedness);
        if (ray) addSceneRay(handedness, ray);
      }
    } else {
      // ── Flat mode: pinhole-project the device forward ray to a screen reticle.
      const addRay = (
        source: "headset" | Handedness,
        q: Quat,
        origin: Vec3,
      ) => {
        const direction = forward(q);
        const reticle = project(direction);
        rays.push({ source, origin, direction, reticle });
        const el = document.elementFromPoint(reticle.x, reticle.y);
        hits.push({ source, elementId: elementIdOf(el), point: reticle });
      };
      addRay("headset", quat(xrDevice.quaternion), vec3(xrDevice.position));
      for (const handedness of ["left", "right"] as Handedness[]) {
        const c = controller(handedness);
        if (c?.connected)
          addRay(handedness, quat(c.quaternion), vec3(c.position));
      }
    }

    const snapshot: TelemetrySnapshot = {
      t: performance.now() - installedAt,
      sessionActive: activeSession !== null,
      mode: s ? "scene" : "flat",
      headset: {
        position: vec3(xrDevice.position),
        orientation: quat(xrDevice.quaternion),
      },
      controllers: {
        left: controller("left")?.connected
          ? {
              position: vec3(controller("left")!.position),
              orientation: quat(controller("left")!.quaternion),
            }
          : undefined,
        right: controller("right")?.connected
          ? {
              position: vec3(controller("right")!.position),
              orientation: quat(controller("right")!.quaternion),
            }
          : undefined,
      },
      hands: {
        left: xrDevice.hands?.left?.connected
          ? xrDevice.hands.left.poseId
          : undefined,
        right: xrDevice.hands?.right?.connected
          ? xrDevice.hands.right.poseId
          : undefined,
      },
      elements,
      rays,
      hits,
    };
    frameLog.push(snapshot);
    return snapshot;
  },

  getHeadPose(): XRPose {
    return {
      position: vec3(xrDevice.position),
      orientation: quat(xrDevice.quaternion),
    };
  },

  getControllerPose(handedness: Handedness): XRPose | null {
    const c = controller(handedness);
    if (!c?.connected) return null;
    return { position: vec3(c.position), orientation: quat(c.quaternion) };
  },

  getControllerRay(handedness: Handedness): DeviceRay | null {
    return controllerRay(handedness);
  },

  hasScene(): boolean {
    return scene() !== undefined;
  },

  dragController(handedness: Handedness, delta: Vec3): Vec3 | null {
    const s = scene();
    const ray = controllerRay(handedness);
    if (!s || !ray) return null;
    const hit = s.hitTest(ray);
    if (!hit) return null;
    return s.dragPanel(hit.panelId, delta);
  },

  getFrameLog(): TelemetrySnapshot[] {
    return frameLog;
  },

  getSelectLog(): InputEventRecord[] {
    return selectLog;
  },

  getSqueezeLog(): InputEventRecord[] {
    return squeezeLog;
  },

  simulateDisconnect() {
    // Force-close the WebSocket so the reconnect logic kicks in
    // The app exposes the socket via __xrTestHooks
    if (window.__xrTestHooks) {
      (window as { __xrForceDisconnect?: () => void }).__xrForceDisconnect?.();
    }
  },

  simulateReconnect() {
    (window as { __xrForceReconnect?: () => void }).__xrForceReconnect?.();
  },
};

window.__XREmulator = api;

console.info("[XR Emulator] installed — navigator.xr:", !!navigator.xr);
