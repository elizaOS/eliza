import { describe, expect, it } from "vitest";
import {
	MAX_RESTORABLE_AGENT_BACKUP_BYTES,
	resolveRetainableAgentBackupBytes,
} from "../src/agent-backup-limits.ts";

describe("resolveRetainableAgentBackupBytes", () => {
	it("defaults when the override is absent", () => {
		expect(resolveRetainableAgentBackupBytes(undefined)).toBe(
			MAX_RESTORABLE_AGENT_BACKUP_BYTES,
		);
	});

	it("throws on a whitespace-only override instead of silently defaulting", () => {
		expect(() => resolveRetainableAgentBackupBytes("   ")).toThrow(
			/Invalid snapshot retain budget/,
		);
		expect(() => resolveRetainableAgentBackupBytes("\t\n ")).toThrow(
			/Invalid snapshot retain budget/,
		);
	});

	it("throws on an empty-string override", () => {
		expect(() => resolveRetainableAgentBackupBytes("")).toThrow(
			/Invalid snapshot retain budget/,
		);
	});

	it("still accepts a valid override and clamps it", () => {
		expect(resolveRetainableAgentBackupBytes("1024")).toBe(1024);
		expect(
			resolveRetainableAgentBackupBytes(
				String(MAX_RESTORABLE_AGENT_BACKUP_BYTES * 2),
			),
		).toBe(MAX_RESTORABLE_AGENT_BACKUP_BYTES);
	});

	it("still throws on non-numeric input", () => {
		expect(() => resolveRetainableAgentBackupBytes("128MiB")).toThrow(
			/Invalid snapshot retain budget/,
		);
	});
});
