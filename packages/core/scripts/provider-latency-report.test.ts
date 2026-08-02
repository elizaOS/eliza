/**
 * Process contract for the provider latency CLI against the real PGlite-backed
 * runtime, including full-provider execution, warm-cache coverage, and observed
 * parallelism. The sample count stays minimal because distribution quality is
 * established by the operator benchmark rather than this structural gate.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface ProviderLatencyReport {
	providerCount: number;
	samples: number;
	providers: Array<{
		providerName: string;
		latencyMs: { count: number };
	}>;
	execution: string;
	reusedProviderResultsPerSample: { min: number; max: number };
	effectiveParallelism: { count: number };
	freshComposeWallMs: { count: number };
	reusedComposeWallMs: { count: number };
}

describe("provider latency report process", () => {
	it("rejects invalid sample settings instead of silently using defaults", () => {
		const script = path.resolve(
			import.meta.dirname,
			"provider-latency-report.ts",
		);
		const result = spawnSync("bun", [script], {
			cwd: path.resolve(import.meta.dirname, "../../.."),
			encoding: "utf8",
			env: {
				...process.env,
				ELIZA_PROVIDER_LATENCY_SAMPLES: "invalid",
			},
			timeout: 120_000,
		});

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"ELIZA_PROVIDER_LATENCY_SAMPLES must be a positive integer",
		);
	});

	it("executes every provider in parallel and proves the warm-cache pass", () => {
		const script = path.resolve(
			import.meta.dirname,
			"provider-latency-report.ts",
		);
		const reportDirectory = mkdtempSync(
			path.join(tmpdir(), "provider-latency-report-"),
		);
		const reportPath = path.join(reportDirectory, "report.json");
		const result = spawnSync("bun", [script], {
			cwd: path.resolve(import.meta.dirname, "../../.."),
			encoding: "utf8",
			env: {
				...process.env,
				ELIZA_LOG_LEVEL: "fatal",
				ELIZA_PROVIDER_LATENCY_REPORT: reportPath,
				ELIZA_PROVIDER_LATENCY_SAMPLES: "1",
				ELIZA_PROVIDER_LATENCY_WARMUPS: "1",
			},
			timeout: 120_000,
		});

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const jsonStart = result.stdout.indexOf('{\n  "generatedAt"');
		const jsonEnd = result.stdout.lastIndexOf("\n}");
		expect(jsonStart).toBeGreaterThanOrEqual(0);
		expect(jsonEnd).toBeGreaterThan(jsonStart);
		const report = JSON.parse(
			result.stdout.slice(jsonStart, jsonEnd + 2),
		) as ProviderLatencyReport;
		expect(
			JSON.parse(readFileSync(reportPath, "utf8")) as ProviderLatencyReport,
		).toEqual(report);
		rmSync(reportDirectory, { recursive: true });

		expect(report.samples).toBe(1);
		expect(report.providers).toHaveLength(report.providerCount);
		expect(report.providers.map((provider) => provider.providerName)).toEqual(
			expect.arrayContaining(["DOCUMENTS", "FACTS", "RELATIONSHIPS", "WORLD"]),
		);
		expect(
			report.providers.every((provider) => provider.latencyMs.count === 1),
		).toBe(true);
		expect(report.freshComposeWallMs.count).toBe(report.samples);
		expect(report.reusedComposeWallMs.count).toBe(report.samples);
		expect(report.effectiveParallelism.count).toBe(report.samples);
		expect(report.execution).toContain("production turn context");
		expect(report.reusedProviderResultsPerSample.min).toBe(
			report.providerCount,
		);
		expect(report.reusedProviderResultsPerSample.max).toBe(
			report.providerCount,
		);
	});
});
