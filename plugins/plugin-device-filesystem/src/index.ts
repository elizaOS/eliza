import type { Plugin } from "@elizaos/core";

import { DeviceFilesystemBridge } from "./services/device-filesystem-bridge.js";

export const deviceFilesystemPlugin: Plugin = {
	name: "device-filesystem",
	description:
		"Mobile-safe filesystem bridge for canonical FILE target=device operations, routing through @capacitor/filesystem on iOS/Android and a Node fs/promises workspace under resolveStateDir() on desktop/AOSP.",
	services: [DeviceFilesystemBridge],
	actions: [],
};

export default deviceFilesystemPlugin;

export { normalizeDevicePath } from "./path.js";
export {
	DeviceFilesystemBridge,
	getDeviceFilesystemBridge,
} from "./services/device-filesystem-bridge.js";
export {
	DEVICE_FILESYSTEM_LOG_PREFIX,
	DEVICE_FILESYSTEM_SERVICE_TYPE,
	type DirectoryEntry,
	type FileEncoding,
} from "./types.js";
