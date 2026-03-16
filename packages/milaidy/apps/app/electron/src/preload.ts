/**
 * Electron Preload Script
 *
 * Exposes native functionality to the renderer process via contextBridge.
 * This is the secure bridge between Node.js and the web context.
 */

import { contextBridge, ipcRenderer, desktopCapturer } from "electron";

// Load Capacitor runtime
require("./rt/electron-rt");

type IpcPrimitive = string | number | boolean | null | undefined;
type IpcObject = { [key: string]: IpcValue };
type IpcValue = IpcPrimitive | IpcObject | IpcValue[] | ArrayBuffer | Float32Array | Uint8Array;
type IpcListener = (...args: IpcValue[]) => void;

/**
 * IPC Renderer wrapper with type safety
 */
const electronAPI = {
  ipcRenderer: {
    invoke: (channel: string, ...args: IpcValue[]) => ipcRenderer.invoke(channel, ...args) as Promise<IpcValue>,
    send: (channel: string, ...args: IpcValue[]) => ipcRenderer.send(channel, ...args),
    on: (channel: string, listener: IpcListener) => {
      ipcRenderer.on(channel, (_event, ...args) => listener(...args));
    },
    once: (channel: string, listener: IpcListener) => {
      ipcRenderer.once(channel, (_event, ...args) => listener(...args));
    },
    removeListener: (channel: string, listener: IpcListener) => {
      ipcRenderer.removeListener(channel, listener);
    },
    removeAllListeners: (channel: string) => {
      ipcRenderer.removeAllListeners(channel);
    },
  },

  /**
   * Desktop Capturer for screen capture
   */
  desktopCapturer: {
    getSources: async (options: { types: string[]; thumbnailSize?: { width: number; height: number } }) => {
      const sources = await desktopCapturer.getSources(options);
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
        appIcon: source.appIcon?.toDataURL(),
      }));
    },
  },

  /**
   * Platform information
   */
  platform: {
    isMac: process.platform === "darwin",
    isWindows: process.platform === "win32",
    isLinux: process.platform === "linux",
    arch: process.arch,
    version: process.getSystemVersion(),
  },
};

// Expose to renderer
contextBridge.exposeInMainWorld("electron", electronAPI);

// Type declarations for renderer
declare global {
  interface Window {
    electron: typeof electronAPI;
  }
}

console.log("[Preload] Milaidy Electron bridge initialized");
console.log(`[Preload] Platform: ${process.platform} (${process.arch})`);
