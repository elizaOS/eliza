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
 *   NOT implemented by IWER, so app-xr automatically falls back to the getUserMedia
 *   video track (Path 3). Injecting frames via __XREmulator.injectCameraFrame() paints
 *   onto the canvas that feeds getUserMedia, making injected frames reachable by both
 *   the getUserMedia path and any code that reads the canvas directly.
 */

import { metaQuest3, XRDevice } from "iwer";
import type { EmulatorStats, XREmulatorAPI, XRPose } from "./types.ts";

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
      sessionActive: false, // updated below once session is active
      framesInjected,
      cameraStreamActive: cameraStream.active,
      wsConnected,
    };
  },

  simulateDisconnect() {
    // Force-close the WebSocket so the reconnect logic kicks in
    // The app exposes the socket via __xrTestHooks
    if (window.__xrTestHooks) {
      (
        window as unknown as { __xrForceDisconnect?: () => void }
      ).__xrForceDisconnect?.();
    }
  },

  simulateReconnect() {
    (
      window as unknown as { __xrForceReconnect?: () => void }
    ).__xrForceReconnect?.();
  },
};

window.__XREmulator = api;

console.info("[XR Emulator] installed — navigator.xr:", !!navigator.xr);
