/**
 * Camera Native Module for Electron
 *
 * Uses a hidden BrowserWindow renderer for getUserMedia / MediaRecorder access,
 * since these Web APIs require a renderer context.
 */

import { BrowserWindow, ipcMain, app } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import path from "path";
import { writeFile, mkdir } from "fs/promises";
import type { IpcValue } from "./ipc-types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
  direction: "front" | "back" | "external";
  hasFlash: boolean;
  hasZoom: boolean;
  maxZoom: number;
  supportedResolutions: Array<{ width: number; height: number }>;
  supportedFrameRates: number[];
}

export interface CameraPreviewOptions {
  deviceId?: string;
  direction?: "front" | "back" | "external";
  width?: number;
  height?: number;
  frameRate?: number;
  mirror?: boolean;
}

export interface CameraPreviewResult {
  width: number;
  height: number;
  deviceId: string;
}

export interface PhotoCaptureOptions {
  quality?: number;
  format?: "jpeg" | "png" | "webp";
  width?: number;
  height?: number;
}

export interface PhotoResult {
  base64: string;
  format: string;
  width: number;
  height: number;
  path?: string;
}

export interface VideoCaptureOptions {
  quality?: "low" | "medium" | "high" | "highest";
  maxDuration?: number;
  audio?: boolean;
  bitrate?: number;
  frameRate?: number;
}

export interface VideoRecordingState {
  isRecording: boolean;
  duration: number;
  fileSize: number;
}

export interface VideoResult {
  path: string;
  duration: number;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
}

const VIDEO_BITRATE: Record<string, number> = {
  low: 1_000_000,
  medium: 2_500_000,
  high: 5_000_000,
  highest: 8_000_000,
};

// ── Manager ─────────────────────────────────────────────────────────────────

/**
 * Camera Manager – orchestrates webcam access through a hidden renderer window.
 */
export class CameraManager {
  private mainWindow: BrowserWindow | null = null;
  private rendererWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  // ── Renderer lifecycle ──────────────────────────────────────────────────

  /** Create (or reuse) the hidden renderer that hosts the camera stream. */
  private async ensureRenderer(): Promise<BrowserWindow> {
    if (this.rendererWindow && !this.rendererWindow.isDestroyed()) {
      return this.rendererWindow;
    }

    this.rendererWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // Auto-approve media-permission requests coming from *this* hidden window
    this.rendererWindow.webContents.session.setPermissionRequestHandler(
      (_wc, permission, callback) => {
        callback(permission === "media");
      },
    );

    const html = `<!DOCTYPE html><html><head><title>CameraRenderer</title></head>
<body>
<video id="preview" autoplay playsinline muted style="display:none"></video>
<canvas id="cap" style="display:none"></canvas>
</body></html>`;

    await this.rendererWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    return this.rendererWindow;
  }

  // ── Device enumeration ──────────────────────────────────────────────────

  async getDevices(): Promise<{ devices: CameraDeviceInfo[] }> {
    const renderer = await this.ensureRenderer();

    const devices: CameraDeviceInfo[] = await renderer.webContents.executeJavaScript(`
      (async () => {
        try {
          const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
          tmp.getTracks().forEach(t => t.stop());
        } catch (_) { /* permission denied or no camera */ }

        const all = await navigator.mediaDevices.enumerateDevices();
        return all
          .filter(d => d.kind === 'videoinput')
          .map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label || 'Camera ' + (i + 1),
            direction: d.label.toLowerCase().includes('front') ? 'front'
              : d.label.toLowerCase().includes('back') ? 'back' : 'external',
            hasFlash: false,
            hasZoom: false,
            maxZoom: 1,
            supportedResolutions: [],
            supportedFrameRates: [15, 24, 30, 60],
          }));
      })()
    `);
    return { devices };
  }

  // ── Preview (stream) ───────────────────────────────────────────────────

  async startPreview(options?: CameraPreviewOptions): Promise<CameraPreviewResult> {
    const renderer = await this.ensureRenderer();
    const cfg = JSON.stringify({
      deviceId: options?.deviceId,
      width: options?.width,
      height: options?.height,
      frameRate: options?.frameRate,
    });

    const result: CameraPreviewResult = await renderer.webContents.executeJavaScript(`
      (async () => {
        const o = ${cfg};
        const vc = {};
        if (o.deviceId) vc.deviceId = { exact: o.deviceId };
        if (o.width)    vc.width    = { ideal: o.width };
        if (o.height)   vc.height   = { ideal: o.height };
        if (o.frameRate) vc.frameRate = { ideal: o.frameRate };

        if (window._camStream) window._camStream.getTracks().forEach(t => t.stop());
        window._camStream = await navigator.mediaDevices.getUserMedia({ video: vc });

        const vt = window._camStream.getVideoTracks()[0];
        const s = vt.getSettings();
        const vid = document.getElementById('preview');
        vid.srcObject = window._camStream;
        await vid.play();
        return { width: s.width || 640, height: s.height || 480, deviceId: s.deviceId || vt.id };
      })()
    `);
    return result;
  }

  async stopPreview(): Promise<void> {
    if (!this.rendererWindow || this.rendererWindow.isDestroyed()) return;

    await this.rendererWindow.webContents.executeJavaScript(`
      (() => {
        if (window._camStream) { window._camStream.getTracks().forEach(t => t.stop()); window._camStream = null; }
        const v = document.getElementById('preview'); if (v) v.srcObject = null;
      })()
    `);
  }

  async switchCamera(options: { deviceId?: string; direction?: string }): Promise<CameraPreviewResult> {
    return this.startPreview({ deviceId: options.deviceId });
  }

  // ── Photo capture ─────────────────────────────────────────────────────

  async capturePhoto(options?: PhotoCaptureOptions): Promise<PhotoResult> {
    const renderer = await this.ensureRenderer();
    const cfg = JSON.stringify({
      quality: options?.quality ?? 92,
      format: options?.format ?? "jpeg",
      width: options?.width,
      height: options?.height,
    });

    const result: PhotoResult = await renderer.webContents.executeJavaScript(`
      (async () => {
        const o = ${cfg};
        const vid = document.getElementById('preview');
        if (!vid || !vid.srcObject) throw new Error('No active camera stream');

        const c = document.getElementById('cap');
        const w = o.width || vid.videoWidth;
        const h = o.height || vid.videoHeight;
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(vid, 0, 0, w, h);

        const mime = o.format === 'png' ? 'image/png' : o.format === 'webp' ? 'image/webp' : 'image/jpeg';
        const url = c.toDataURL(mime, o.quality / 100);
        return { base64: url.split(',')[1], format: o.format, width: w, height: h };
      })()
    `);
    return result;
  }

  // ── Video recording ───────────────────────────────────────────────────

  async startRecording(options?: VideoCaptureOptions): Promise<void> {
    const renderer = await this.ensureRenderer();
    const bitrate = options?.bitrate ?? VIDEO_BITRATE[options?.quality ?? "medium"];
    const cfg = JSON.stringify({
      audio: options?.audio ?? false,
      bitrate,
      maxDuration: options?.maxDuration,
    });

    await renderer.webContents.executeJavaScript(`
      (async () => {
        const o = ${cfg};
        if (!window._camStream) throw new Error('No active camera stream – call startPreview first');

        let stream = window._camStream;
        if (o.audio) {
          try {
            const as = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream = new MediaStream([...stream.getVideoTracks(), ...as.getAudioTracks()]);
          } catch (_) { /* mic unavailable */ }
        }

        window._recChunks = [];
        window._recStart = Date.now();
        window._isRec = true;

        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
          ? 'video/webm;codecs=vp9' : 'video/webm';
        window._mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: o.bitrate });
        window._mr.ondataavailable = e => { if (e.data.size > 0) window._recChunks.push(e.data); };
        window._mr.start(1000);

        if (o.maxDuration) {
          window._recTimeout = setTimeout(() => {
            if (window._mr && window._mr.state === 'recording') { window._mr.stop(); window._isRec = false; }
          }, o.maxDuration * 1000);
        }
      })()
    `);
  }

  async stopRecording(): Promise<VideoResult> {
    const renderer = await this.ensureRenderer();
    const tempDir = path.join(app.getPath("temp"), "openclaw-camera");
    await mkdir(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `recording-${Date.now()}.webm`);

    const result = await renderer.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        if (!window._mr) { reject(new Error('No active recording')); return; }
        if (window._recTimeout) { clearTimeout(window._recTimeout); window._recTimeout = null; }

        window._mr.onstop = () => {
          const blob = new Blob(window._recChunks, { type: window._mr.mimeType });
          const reader = new FileReader();
          reader.onloadend = () => {
            const b64 = reader.result.split(',')[1];
            const dur = (Date.now() - window._recStart) / 1000;
            const vid = document.getElementById('preview');
            resolve({
              base64: b64,
              duration: dur,
              width: vid ? vid.videoWidth : 0,
              height: vid ? vid.videoHeight : 0,
              fileSize: blob.size,
              mimeType: window._mr.mimeType,
            });
            window._recChunks = []; window._mr = null; window._isRec = false;
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        };
        window._mr.stop();
      })
    `);

    const buffer = Buffer.from(result.base64 as string, "base64");
    await writeFile(filePath, buffer);

    return {
      path: filePath,
      duration: result.duration as number,
      width: result.width as number,
      height: result.height as number,
      fileSize: result.fileSize as number,
      mimeType: result.mimeType as string,
    };
  }

  async getRecordingState(): Promise<VideoRecordingState> {
    if (!this.rendererWindow || this.rendererWindow.isDestroyed()) {
      return { isRecording: false, duration: 0, fileSize: 0 };
    }

    return this.rendererWindow.webContents.executeJavaScript(`
      (() => {
        const on = !!window._isRec;
        const dur = on ? (Date.now() - (window._recStart || Date.now())) / 1000 : 0;
        const sz = (window._recChunks || []).reduce((s, c) => s + c.size, 0);
        return { isRecording: on, duration: dur, fileSize: sz };
      })()
    `);
  }

  // ── Permissions ───────────────────────────────────────────────────────

  async checkPermissions(): Promise<{ camera: string; microphone: string }> {
    const renderer = await this.ensureRenderer();
    return renderer.webContents.executeJavaScript(`
      (async () => {
        try {
          const cam = await navigator.permissions.query({ name: 'camera' });
          const mic = await navigator.permissions.query({ name: 'microphone' });
          return { camera: cam.state, microphone: mic.state };
        } catch (_) { return { camera: 'prompt', microphone: 'prompt' }; }
      })()
    `);
  }

  async requestPermissions(): Promise<{ camera: string; microphone: string }> {
    const renderer = await this.ensureRenderer();
    return renderer.webContents.executeJavaScript(`
      (async () => {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          s.getTracks().forEach(t => t.stop());
          return { camera: 'granted', microphone: 'granted' };
        } catch (_) { return { camera: 'denied', microphone: 'denied' }; }
      })()
    `);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private sendToRenderer(channel: string, data?: IpcValue): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  dispose(): void {
    if (this.rendererWindow && !this.rendererWindow.isDestroyed()) {
      this.rendererWindow.webContents
        .executeJavaScript(`
          if (window._camStream) window._camStream.getTracks().forEach(t => t.stop());
          if (window._mr && window._mr.state !== 'inactive') window._mr.stop();
        `)
        .catch(() => {});
      this.rendererWindow.close();
      this.rendererWindow = null;
    }
  }
}

// ── Singleton & IPC ─────────────────────────────────────────────────────────

let cameraManager: CameraManager | null = null;

export function getCameraManager(): CameraManager {
  if (!cameraManager) {
    cameraManager = new CameraManager();
  }
  return cameraManager;
}

export function registerCameraIPC(): void {
  const m = getCameraManager();

  ipcMain.handle("camera:getDevices", async () => m.getDevices());
  ipcMain.handle("camera:startPreview", async (_e: IpcMainInvokeEvent, opts?: CameraPreviewOptions) => m.startPreview(opts));
  ipcMain.handle("camera:stopPreview", async () => m.stopPreview());
  ipcMain.handle("camera:switchCamera", async (_e: IpcMainInvokeEvent, opts: { deviceId?: string; direction?: string }) => m.switchCamera(opts));
  ipcMain.handle("camera:capturePhoto", async (_e: IpcMainInvokeEvent, opts?: PhotoCaptureOptions) => m.capturePhoto(opts));
  ipcMain.handle("camera:startRecording", async (_e: IpcMainInvokeEvent, opts?: VideoCaptureOptions) => m.startRecording(opts));
  ipcMain.handle("camera:stopRecording", async () => m.stopRecording());
  ipcMain.handle("camera:getRecordingState", async () => m.getRecordingState());
  ipcMain.handle("camera:checkPermissions", async () => m.checkPermissions());
  ipcMain.handle("camera:requestPermissions", async () => m.requestPermissions());
}
