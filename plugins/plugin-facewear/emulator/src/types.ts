export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface XRPose {
  position: Vec3;
  orientation: Quat;
}

export interface EmulatorStats {
  sessionActive: boolean;
  framesInjected: number;
  cameraStreamActive: boolean;
  wsConnected: boolean;
}

/** window.__XREmulator — set by emulator.ts, consumed by Playwright via page.evaluate() */
export interface XREmulatorAPI {
  setPose(pose: Partial<XRPose>): void;
  injectCameraFrame(jpegDataUrl: string): Promise<void>;
  getStats(): EmulatorStats;
  /** Simulate device disconnection (closes WebSocket) */
  simulateDisconnect(): void;
  /** Simulate reconnect after a disconnect */
  simulateReconnect(): void;
}

declare global {
  interface Window {
    __XREmulator: XREmulatorAPI;
    /** Set by app-xr/src/main.ts in VITE_TEST mode */
    __xrTestHooks: {
      sendAudioChunk(
        base64: string,
        sampleRate: number,
        encoding: string,
      ): void;
      getSocketState(): "CONNECTING" | "OPEN" | "CLOSING" | "CLOSED";
      sendPing?(): void;
    };
  }
}
