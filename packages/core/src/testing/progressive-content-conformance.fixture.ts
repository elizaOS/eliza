/** Supplies a deterministic Unicode adapter fixture with injectable conformance defects. */

import { createHash } from "node:crypto";
import { buildReadView } from "../types/content";
import {
	PROGRESSIVE_CONTENT_DELIVERY_CONTRACT,
	type ProgressiveContentConformanceAdapter,
} from "./progressive-content-conformance";

class AdapterError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

export function progressiveConformanceFixture() {
	const pattern = Buffer.from("世界🙂ABCDEF", "utf8");
	const bytes = Buffer.allocUnsafe(257 * 1024);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = pattern[index % pattern.length] ?? 0x41;
	}
	const canaries = [
		{ label: "beginning", text: "B世界🙂ABCDE", byteStart: 0 },
		{ label: "boundary", text: "D世界🙂ABCDE", byteStart: 65_536 },
		{ label: "middle", text: "M世界🙂ABCDE", byteStart: 131_072 },
		{ label: "end", text: "E世界🙂ABCDE", byteStart: bytes.length - 16 },
	].map((canary) => ({
		...canary,
		byteEnd: canary.byteStart + Buffer.byteLength(canary.text),
	}));
	for (const canary of canaries) {
		bytes.write(canary.text, canary.byteStart, "utf8");
	}
	return {
		object: {
			id: "object-1",
			family: "file" as const,
			byteLength: bytes.length,
			sourceSha256: createHash("sha256").update(bytes).digest("hex"),
			revision: "revision-1",
			authorizationScope: "room-1",
			canaries,
		},
		bytes,
	};
}

export function progressiveConformanceAdapter(): ProgressiveContentConformanceAdapter {
	const { bytes, object } = progressiveConformanceFixture();
	let present = true;
	return {
		adapterId: "deterministic-native-fixture",
		deliveryContract: PROGRESSIVE_CONTENT_DELIVERY_CONTRACT,
		async restart() {},
		async cleanup() {
			present = false;
		},
		async measureResources() {
			return { databaseBytes: present ? bytes.length : 0 };
		},
		async read(request) {
			if (!present || request.objectId !== object.id) {
				throw new AdapterError("CONTENT_NOT_FOUND");
			}
			if (request.authorizationScope !== object.authorizationScope) {
				throw new AdapterError("CONTENT_ACCESS_DENIED");
			}
			if (
				request.expectedRevision &&
				request.expectedRevision !== object.revision
			) throw new AdapterError("CONTENT_STALE_REVISION");
			const page = bytes.subarray(request.offset, request.offset + request.limit);
			const end = request.offset + page.byteLength;
			const hasMore = end < bytes.length;
			return {
				bytes: page,
				view: buildReadView({
					reference: {
						kind: "file",
						ref: "file:object-1",
						revision: object.revision,
					},
					slice: {
						range: {
							unit: "byte",
							start: request.offset,
							end,
							total: bytes.length,
						},
						hasPrevious: request.offset > 0,
						hasMore,
						...(hasMore ? { nextOffset: end } : {}),
						revision: object.revision,
						completeness: hasMore ? "partial-recoverable" : "complete",
						sliceSha256: createHash("sha256").update(page).digest("hex"),
					},
				}),
				sourceWork: {
					readCalls: 1,
					bytesRead: page.byteLength,
					rowsRead: 1,
					parentScans: 0,
				},
			};
		},
	};
}
