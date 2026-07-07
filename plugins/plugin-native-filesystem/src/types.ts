/**
 * Shared constants and wire types for the device filesystem bridge: the service-type
 * identifier plugins resolve against (`getDeviceFilesystemBridge`), the shared log
 * prefix, and the read/write/list types common to both the Capacitor and Node backends
 * in `services/device-filesystem-bridge.ts`.
 */
export const DEVICE_FILESYSTEM_SERVICE_TYPE = "device_filesystem" as const;
export const DEVICE_FILESYSTEM_LOG_PREFIX = "[device-filesystem]" as const;

export type FileEncoding = "utf8" | "base64";

export interface DirectoryEntry {
	name: string;
	type: "file" | "directory";
}
