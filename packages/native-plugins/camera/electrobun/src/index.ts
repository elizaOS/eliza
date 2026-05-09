/**
 * Camera Plugin for Electrobun
 *
 * Uses the web implementation (MediaDevices API) for parity on desktop.
 */

import type { CameraPlugin } from "../../src/definitions";
import { CameraWeb } from "../../src/web";

// Export the plugin instance
export const Camera: CameraPlugin = new CameraWeb();
