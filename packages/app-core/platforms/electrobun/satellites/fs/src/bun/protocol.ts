export const FILE_SATELLITE_ID = "eliza.fs" as const;

export type FileSatelliteErrorCode =
	| "FS_ROOTS_MISSING"
	| "FS_PATH_OUTSIDE_ROOT"
	| "FS_PATH_DENIED"
	| "FS_PATH_NOT_FOUND"
	| "FS_NOT_A_FILE"
	| "FS_NOT_A_DIRECTORY"
	| "FS_FILE_TOO_LARGE"
	| "FS_BINARY_FILE"
	| "FS_WRITE_DISABLED"
	| "FS_REQUEST_FAILED"
	| "FS_UNKNOWN";

export type FileSatelliteError = {
	code: FileSatelliteErrorCode;
	message: string;
	path?: string;
	details?: unknown;
};

export type FileRoot = {
	id: string;
	path: string;
	label?: string;
};

export type FileStat = {
	path: string;
	name: string;
	kind: "file" | "directory" | "symlink" | "other";
	size: number;
	modifiedAt?: string;
	isText?: boolean;
};

export type FileListParams = {
	path?: string;
	rootId?: string;
	limit?: number;
	includeHidden?: boolean;
	ignore?: string[];
};

export type FileListResult = {
	root: FileRoot;
	path: string;
	entries: FileStat[];
	truncated: boolean;
	totalAfterIgnore: number;
};

export type FileReadTextParams = {
	path: string;
	maxBytes?: number;
};

export type FileReadTextResult = {
	path: string;
	text: string;
	size: number;
	truncated: boolean;
};

export type FileSearchParams = {
	query: string;
	path?: string;
	rootId?: string;
	limit?: number;
	includeHidden?: boolean;
};

export type FileSearchMatch = {
	path: string;
	line: number;
	column?: number;
	preview: string;
};

export type FileSearchResult = {
	query: string;
	matches: FileSearchMatch[];
};

export type FileWriteTextParams = {
	path: string;
	text: string;
	createDirectories?: boolean;
	overwrite?: boolean;
};

export type FileWriteTextResult = {
	path: string;
	bytesWritten: number;
};

export type FileMethod =
	| "fs.status"
	| "fs.roots"
	| "fs.stat"
	| "fs.list"
	| "fs.readText"
	| "fs.search"
	| "fs.writeText";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| { [key: string]: JsonValue }
	| JsonValue[];

export type FileWorkerRequestMessage = {
	type: "request";
	requestId: string | number;
	method: FileMethod;
	params?: JsonValue;
};

export type FileResponsePayload =
	| FileRoot[]
	| FileStat
	| FileListResult
	| FileReadTextResult
	| FileSearchResult
	| FileWriteTextResult
	| unknown;

export type FileWorkerResponseMessage =
	| {
			type: "response";
			requestId: string | number;
			success: true;
			payload: FileResponsePayload;
	  }
	| {
			type: "response";
			requestId: string | number;
			success: false;
			error: FileSatelliteError;
	  };

export type FileWorkerReadyMessage = {
	type: "ready";
};

export type FileWorkerOutboundMessage =
	| FileWorkerResponseMessage
	| FileWorkerReadyMessage;
