/**
 * Overflow coverage for {@link readCappedSkillPackage}: an oversize install
 * body must be rejected before the full payload is retained, and a body at
 * the cap must still be accepted.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_SKILL_PACKAGE_BYTES,
	readCappedSkillPackage,
	readCappedSkillText,
} from "./skill-package-bytes";

function streamOf(bytes: Uint8Array, chunkSize = 64 * 1024): Response {
	let offset = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.byteLength) {
					controller.close();
					return;
				}
				const end = Math.min(offset + chunkSize, bytes.byteLength);
				controller.enqueue(bytes.subarray(offset, end));
				offset = end;
			},
		}),
	);
}

describe("readCappedSkillPackage", () => {
	it("accepts a package at the 10MB cap", async () => {
		const body = new Uint8Array(MAX_SKILL_PACKAGE_BYTES);
		body[0] = 80;
		body[1] = 75;
		const got = await readCappedSkillPackage(streamOf(body));
		expect(got.byteLength).toBe(MAX_SKILL_PACKAGE_BYTES);
		expect(got[0]).toBe(80);
		expect(got[1]).toBe(75);
	});

	it("rejects one byte past the cap without retaining the overflow", async () => {
		const body = new Uint8Array(MAX_SKILL_PACKAGE_BYTES + 1);
		await expect(readCappedSkillPackage(streamOf(body))).rejects.toThrow(
			"Package too large (max 10MB)",
		);
	});

	it("decodes a capped SKILL.md body as UTF-8", async () => {
		const text = await readCappedSkillText(
			new Response("name: demo\n", { headers: { "content-type": "text/markdown" } }),
		);
		expect(text).toBe("name: demo\n");
	});
});
