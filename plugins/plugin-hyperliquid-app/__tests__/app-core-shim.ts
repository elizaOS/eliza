export interface OverlayApp {
	name: string;
	component?: unknown;
	[key: string]: unknown;
}

export const client = {};

export function registerOverlayApp(_app: OverlayApp): void {}

export function sendJson(
	res: { writeHead?: (status: number, headers?: Record<string, string>) => void; end?: (body?: string) => void },
	status: number,
	body: unknown,
): void {
	res.writeHead?.(status, { "content-type": "application/json" });
	res.end?.(JSON.stringify(body));
}

export function sendJsonError(
	res: { writeHead?: (status: number, headers?: Record<string, string>) => void; end?: (body?: string) => void },
	status: number,
	message: string,
): void {
	sendJson(res, status, { error: message });
}
