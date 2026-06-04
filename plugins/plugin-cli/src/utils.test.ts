import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
	formatBytes,
	formatCliCommand,
	formatDuration,
	parseDurationMs,
	parseTimeoutMs,
	resolveCliName,
	withProgress,
} from "./utils.js";

describe("plugin-cli utilities", () => {
	it("parses duration strings and falls back for invalid timeout values", () => {
		expect(parseDurationMs("250")).toEqual({
			ms: 250,
			original: "250",
			valid: true,
		});
		expect(parseDurationMs("1.5m")).toEqual({
			ms: 90_000,
			original: "1.5m",
			valid: true,
		});
		expect(parseDurationMs("bad")).toEqual({
			ms: 0,
			original: "bad",
			valid: false,
		});
		expect(parseTimeoutMs(undefined, 5000)).toBe(5000);
		expect(parseTimeoutMs("bad", 5000)).toBe(5000);
		expect(parseTimeoutMs("2s", 5000)).toBe(2000);
	});

	it("rejects hostile duration values that overflow safe millisecond integers", () => {
		for (const input of [
			"999999999999999999999999999999999999999999999999999999d",
			"1e309d",
			"Infinity",
			"NaN",
			"-1",
			"-1s",
		]) {
			expect(parseDurationMs(input)).toEqual({
				ms: 0,
				original: input,
				valid: false,
			});
			expect(parseTimeoutMs(input, 1234)).toBe(1234);
		}
	});

	it("fuzzes duration parsing so valid results are finite safe integers", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (input) => {
				const parsed = parseDurationMs(input);

				expect(parsed.original).toBe(input);
				if (parsed.valid) {
					expect(Number.isSafeInteger(parsed.ms)).toBe(true);
					expect(parsed.ms).toBeGreaterThanOrEqual(0);
				} else {
					expect(parsed.ms).toBe(0);
				}
			}),
			{ numRuns: 500 },
		);
	});

	it("formats command, byte, duration, and argv-derived CLI names", () => {
		expect(
			formatCliCommand("run task", {
				cliName: "agent",
				profile: "dev",
				env: "local",
			}),
		).toBe("agent --profile dev --env local run task");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatDuration(90_000)).toBe("1.5m");
		expect(resolveCliName(["node", "/usr/local/bin/elizaos.mjs"])).toBe(
			"elizaos",
		);
		expect(resolveCliName(["node", "C:\\tools\\elizaos.cmd"])).toBe("elizaos");
	});

	it("reports success and failure around async work", async () => {
		const deps = {
			log: vi.fn(),
			error: vi.fn(),
			exit: vi.fn(),
		};

		await expect(withProgress(deps, "Working", async () => 42)).resolves.toBe(
			42,
		);
		expect(deps.log).toHaveBeenCalledWith("Working");
		expect(deps.log).toHaveBeenCalledWith("✓ Working");

		await expect(
			withProgress(deps, "Failing", async () => {
				throw new Error("bad");
			}),
		).rejects.toThrow("bad");
		expect(deps.error).toHaveBeenCalledWith("✗ bad");
	});
});
