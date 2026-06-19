export const DEVICE_FILESYSTEM_SERVICE_TYPE = "device_filesystem" as const;
export const DEVICE_FILESYSTEM_LOG_PREFIX = "[device-filesystem]" as const;

export type FileEncoding = "utf8" | "base64";

export interface DirectoryEntry {
	name: string;
	type: "file" | "directory";
}
