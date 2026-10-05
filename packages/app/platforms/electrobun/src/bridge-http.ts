import type http from "node:http";

export async function readJsonBody<T>(
	req: http.IncomingMessage,
	maxBytes: number,
): Promise<T | null> {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBytes) {
			throw new Error("request body too large");
		}
		chunks.push(buffer);
	}

	if (chunks.length === 0) {
		return null;
	}

	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
