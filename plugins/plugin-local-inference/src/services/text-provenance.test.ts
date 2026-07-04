/** Covers reading the GGUF `general.architecture` bytes and the Gemma-4 strict-release architecture blockers. Deterministic, synthetic GGUF headers. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectTextArchitectureBlockers,
	readBundleTextArchitectureBlockers,
	readGgufArchitecture,
} from "./text-provenance";

// ---- minimal GGUF v3 header writer (mirrors the gguf spec) ----
function u32(n: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(n >>> 0);
	return b;
}
function u64(n: number): Buffer {
	const b = Buffer.alloc(8);
	b.writeBigUInt64LE(BigInt(n));
	return b;
}
function gstr(s: string): Buffer {
	const bytes = Buffer.from(s, "utf8");
	return Buffer.concat([u64(bytes.length), bytes]);
}
function kvString(key: string, value: string): Buffer {
	return Buffer.concat([gstr(key), u32(8), gstr(value)]);
}
function kvU32(key: string, value: number): Buffer {
	return Buffer.concat([gstr(key), u32(4), u32(value)]);
}
function kvArrayU32(key: string, values: number[]): Buffer {
	// type 9 (array): elem-type u32, count u64, then the elements.
	return Buffer.concat([
		gstr(key),
		u32(9),
		u32(4),
		u64(values.length),
		...values.map(u32),
	]);
}
function gguf(kvs: Buffer[]): Buffer {
	return Buffer.concat([
		u32(0x4655_4747),
		u32(3),
		u64(0),
		u64(kvs.length),
		...kvs,
	]);
}

function writeGguf(arch: string | null): string {
	const dir = mkdtempSync(path.join(tmpdir(), "text-provenance-"));
	const file = path.join(dir, "model.gguf");
	// Put non-target KVs (a scalar + an array) before the architecture so the
	// reader's skip-value paths are exercised, not just a happy first-KV hit.
	const kvs: Buffer[] = [
		kvU32("general.quantization_version", 2),
		kvArrayU32("tokenizer.ggml.scores", [1, 2, 3]),
	];
	if (arch !== null) kvs.push(kvString("general.architecture", arch));
	kvs.push(kvString("general.name", "test"));
	writeFileSync(file, gguf(kvs));
	return file;
}

describe("readGgufArchitecture", () => {
	it("reads gemma4 past preceding scalar + array KVs", () => {
		expect(readGgufArchitecture(writeGguf("gemma4"))).toBe("gemma4");
	});
	it("reads a Qwen architecture", () => {
		expect(readGgufArchitecture(writeGguf("qwen35"))).toBe("qwen35");
	});
	it("returns null when the architecture key is absent", () => {
		expect(readGgufArchitecture(writeGguf(null))).toBeNull();
	});
	it("returns null for a non-GGUF file (fails closed)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "text-provenance-"));
		const file = path.join(dir, "not.gguf");
		writeFileSync(file, Buffer.from("not a gguf file at all"));
		expect(readGgufArchitecture(file)).toBeNull();
	});
	it("returns null for a missing file (fails closed)", () => {
		expect(readGgufArchitecture("/nonexistent/model.gguf")).toBeNull();
	});
});

describe("collectTextArchitectureBlockers", () => {
	it("passes a Gemma-4 text GGUF", () => {
		expect(collectTextArchitectureBlockers(writeGguf("gemma4"))).toEqual([]);
	});
	it("blocks a Qwen text GGUF and names Qwen", () => {
		const blockers = collectTextArchitectureBlockers(writeGguf("qwen35"));
		expect(blockers).toHaveLength(1);
		expect(blockers[0]).toMatch(/Qwen stand-in/);
		expect(blockers[0]).toMatch(/qwen35/);
	});
	it("blocks any non-Gemma architecture", () => {
		const blockers = collectTextArchitectureBlockers(writeGguf("llama"));
		expect(blockers).toHaveLength(1);
		expect(blockers[0]).toMatch(/expected gemma/);
	});
	it("does not manufacture a blocker from an unreadable GGUF", () => {
		expect(collectTextArchitectureBlockers("/nonexistent.gguf")).toEqual([]);
	});
});

describe("readBundleTextArchitectureBlockers", () => {
	function bundleWith(arch: string): string {
		const root = mkdtempSync(path.join(tmpdir(), "bundle-"));
		mkdirSync(path.join(root, "text"));
		writeFileSync(
			path.join(root, "text", `eliza-1-2b-128k.gguf`),
			gguf([kvString("general.architecture", arch)]),
		);
		return root;
	}
	it("passes a Gemma-4 bundle", () => {
		expect(readBundleTextArchitectureBlockers(bundleWith("gemma4"))).toEqual(
			[],
		);
	});
	it("blocks a Qwen bundle", () => {
		expect(
			readBundleTextArchitectureBlockers(bundleWith("qwen35")),
		).toHaveLength(1);
	});
	it("is empty when no text/ directory exists", () => {
		const root = mkdtempSync(path.join(tmpdir(), "bundle-"));
		expect(readBundleTextArchitectureBlockers(root)).toEqual([]);
	});
});
