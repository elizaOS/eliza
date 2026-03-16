/**
 * Native Module Index for Electron
 *
 * Exports all native modules and provides a unified initialization function.
 */

import { BrowserWindow } from "electron";

// Import all native modules
export * from "./whisper";
export * from "./desktop";
export * from "./gateway";
export * from "./talkmode";
export * from "./swabble";
export * from "./screencapture";
export * from "./location";
export * from "./camera";
export * from "./canvas";

// Import registration functions
import { registerDesktopIPC, getDesktopManager } from "./desktop";
import { registerGatewayIPC, getGatewayDiscovery } from "./gateway";
import { registerTalkModeIPC, getTalkModeManager } from "./talkmode";
import { registerSwabbleIPC, getSwabbleManager } from "./swabble";
import { registerScreenCaptureIPC, getScreenCaptureManager } from "./screencapture";
import { registerLocationIPC, getLocationManager } from "./location";
import { registerCameraIPC, getCameraManager } from "./camera";
import { registerCanvasIPC, getCanvasManager } from "./canvas";

/**
 * Initialize all native modules with the main window
 */
export function initializeNativeModules(mainWindow: BrowserWindow): void {
  // Set main window on all managers
  getDesktopManager().setMainWindow(mainWindow);
  getGatewayDiscovery().setMainWindow(mainWindow);
  getTalkModeManager().setMainWindow(mainWindow);
  getSwabbleManager().setMainWindow(mainWindow);
  getScreenCaptureManager().setMainWindow(mainWindow);
  getLocationManager().setMainWindow(mainWindow);
  getCameraManager().setMainWindow(mainWindow);
  getCanvasManager().setMainWindow(mainWindow);
}

/**
 * Register all IPC handlers
 * Call this once during app initialization
 */
export function registerAllIPC(): void {
  registerDesktopIPC();
  registerGatewayIPC();
  registerTalkModeIPC();
  registerSwabbleIPC();
  registerScreenCaptureIPC();
  registerLocationIPC();
  registerCameraIPC();
  registerCanvasIPC();
}

/**
 * Clean up all native modules
 */
export function disposeNativeModules(): void {
  getDesktopManager().dispose();
  getGatewayDiscovery().dispose();
  getTalkModeManager().dispose();
  getSwabbleManager().dispose();
  getScreenCaptureManager().dispose();
  getLocationManager().dispose();
  getCameraManager().dispose();
  getCanvasManager().dispose();
}
