/**
 * Camera Plugin for Electron
 *
 * Uses the web implementation (MediaDevices API) for parity on desktop.
 */

import type { CameraPlugin } from "../../src/definitions";
import { CameraWeb } from "../../src/web";

export class CameraElectron extends CameraWeb implements CameraPlugin {}

// Export the plugin instance
export const Camera = new CameraElectron();
