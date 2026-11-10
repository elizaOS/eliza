/** Region-file parsing and resolution; mirrors the fork's eliza-file-region.h rules. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	parseFileRegion,
	readFileRegionHead,
	resolveFileRegion,
} from "./file-region";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function temp(): string {
	const root = mkdtempSync(path.join(tmpdir(), "eliza-file-region-"));
	roots.push(root);
	return root;
}

describe("parseFileRegion", () => {
	it("parses offset, length and path in any order", () => {
		expect(
			parseFileRegion(
				"eliza-file-region v1\npath=/data/app/base.apk\nlength=7\noffset=32\n",
			),
		).toEqual({ path: "/data/app/base.apk", offset: 32, length: 7 });
	});

	it.each([
		["wrong magic", "eliza-file-region v2\noffset=0\nlength=1\npath=/a\n"],
		["missing path", "eliza-file-region v1\noffset=0\nlength=1\n"],
		["relative path", "eliza-file-region v1\noffset=0\nlength=1\npath=a\n"],
		["zero length", "eliza-file-region v1\noffset=0\nlength=0\npath=/a\n"],
		["unaligned", "eliza-file-region v1\noffset=8\nlength=1\npath=/a\n"],
		["sign", "eliza-file-region v1\noffset=+16\nlength=1\npath=/a\n"],
		[
			"duplicate",
			"eliza-file-region v1\noffset=0\noffset=16\nlength=1\npath=/a\n",
		],
		[
			"unknown key",
			"eliza-file-region v1\noffset=0\nlength=1\npath=/a\nmode=x\n",
		],
		["no equals", "eliza-file-region v1\noffset\nlength=1\npath=/a\n"],
		[
			"overflow",
			"eliza-file-region v1\noffset=18446744073709551616\nlength=1\npath=/a\n",
		],
	])("rejects %s", (_name, text) => {
		expect(() => parseFileRegion(text)).toThrow();
	});
});

describe("resolveFileRegion", () => {
	it("gives a plain file as a whole", () => {
		const file = path.join(temp(), "model.gguf");
		writeFileSync(file, "GGUF plain");
		expect(resolveFileRegion(file)).toEqual({
			path: file,
			offset: 0,
			length: 10,
			indirect: false,
		});
	});

	it("reads the named bytes of the containing file", () => {
		const root = temp();
		const container = path.join(root, "base.apk");
		writeFileSync(
			container,
			Buffer.concat([
				Buffer.alloc(48, 0x6a),
				Buffer.from("GGUF in place"),
				Buffer.from("tail"),
			]),
		);
		const file = path.join(root, "model.gguf");
		writeFileSync(
			file,
			`eliza-file-region v1\noffset=48\nlength=13\npath=${container}\n`,
		);
		const region = resolveFileRegion(file);
		expect(region).toEqual({
			path: container,
			offset: 48,
			length: 13,
			indirect: true,
		});
		expect(readFileRegionHead(region, 4).toString()).toBe("GGUF");
		expect(readFileRegionHead(region, 1 << 16).toString()).toBe(
			"GGUF in place",
		);
	});

	it("passes ENOENT through for a missing model path", () => {
		expect(() => resolveFileRegion(path.join(temp(), "absent.gguf"))).toThrow(
			expect.objectContaining({ code: "ENOENT" }),
		);
	});
});
