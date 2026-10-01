/**
 * Pins that canonical backup JSON rejects array slots that are not JSON
 * values (holes and `undefined`) instead of emitting unparseable `[a,,c]`.
 */

import { describe, expect, it } from "vitest";
import { canonicalBackupJson } from "../contracts/agent-backup-canonical-json";

describe("canonicalBackupJson arrays", () => {
	it("serializes dense arrays with sorted object keys", () => {
		expect(canonicalBackupJson(["a", { b: 1, a: [2] }, null])).toBe(
			'["a",{"a":[2],"b":1},null]',
		);
	});

	it("rejects sparse array holes", () => {
		// biome-ignore lint/suspicious/noSparseArray: the hole is the input under test
		expect(() => canonicalBackupJson(["a", , "c"])).toThrow(TypeError);
		expect(() => canonicalBackupJson(new Array(2))).toThrow(TypeError);
	});

	it("rejects undefined array members", () => {
		expect(() => canonicalBackupJson(["a", undefined, "c"])).toThrow(TypeError);
	});
});
