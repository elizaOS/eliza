export const COMPUTER_SATELLITE_ID = "eliza.computer" as const;

export type ComputerErrorCode =
	| "COMPUTER_SCREENSHOT_DISABLED"
	| "COMPUTER_SCREENSHOT_UNSUPPORTED"
	| "COMPUTER_COMMAND_FAILED"
	| "COMPUTER_REQUEST_FAILED"
	| "COMPUTER_UNKNOWN";

export type ComputerError = {
	code: ComputerErrorCode;
	message: string;
	details?: unknown;
};

export type ComputerCapabilityName =
	| "displays"
	| "screenshot"
	| "input"
	| "window"
	| "browser"
	| "camera"
	| "canvas";

export type ComputerCapabilityStatus = {
	available: boolean;
	reason?: string;
};

export type ComputerStatusResult = {
	id: "eliza.computer";
	ok: true;
	platform: NodeJS.Platform;
	capabilities: Record<ComputerCapabilityName, ComputerCapabilityStatus>;
	updatedAt: string;
};

export type ComputerPermissionState =
	| "available"
	| "disabled"
	| "unsupported"
	| "unknown";

export type ComputerPermissionsResult = {
	screenCapture: ComputerPermissionState;
	input: ComputerPermissionState;
	window: ComputerPermissionState;
	browser: ComputerPermissionState;
	camera: ComputerPermissionState;
	canvas: ComputerPermissionState;
};

export type ComputerDisplay = {
	id: string;
	name?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	scaleFactor?: number;
	primary: boolean;
	raw?: unknown;
};

export type ComputerDisplaysResult = {
	displays: ComputerDisplay[];
	source: "fallback" | "macos-system-profiler" | "xrandr";
	warning?: string;
};

export type ComputerScreenshotRegion = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type ComputerScreenshotParams = {
	region?: ComputerScreenshotRegion;
};

export type ComputerScreenshotResult = {
	mimeType: "image/png";
	base64: string;
	capturedAt: string;
	region?: ComputerScreenshotRegion;
};

export type ComputerMethod =
	| "computer.status"
	| "computer.permissions"
	| "computer.displays"
	| "computer.screenshot";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| { [key: string]: JsonValue }
	| JsonValue[];

export type ComputerWorkerRequestMessage = {
	type: "request";
	requestId: string | number;
	method: ComputerMethod;
	params?: JsonValue;
};

export type ComputerResponsePayload =
	| ComputerStatusResult
	| ComputerPermissionsResult
	| ComputerDisplaysResult
	| ComputerScreenshotResult;

export type ComputerWorkerResponseMessage =
	| {
			type: "response";
			requestId: string | number;
			success: true;
			payload: ComputerResponsePayload;
		}
	| {
			type: "response";
			requestId: string | number;
			success: false;
			error: ComputerError;
		};

export type ComputerWorkerReadyMessage = {
	type: "ready";
};

export type ComputerWorkerOutboundMessage =
	| ComputerWorkerResponseMessage
	| ComputerWorkerReadyMessage;
