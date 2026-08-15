#!/usr/bin/env bun
/**
 * Measures every provider registered on a real PGLite-backed core runtime.
 *
 * Each sample composes a fresh message with the full provider inventory, then
 * repeats that composition inside the same production turn context. The report
 * separates first execution from reuse, ranks providers by p95, and includes
 * aggregate wall time and observed provider-span overlap.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
	InferenceTurnTimer,
	runWithInferenceTiming,
} from "../src/inference-timing";
import { createTestRuntime } from "../src/testing/pglite-runtime";
import { runWithTrajectoryContext } from "../src/trajectory-context";
import type { Memory, UUID } from "../src/types";
import { ChannelType } from "../src/types";

const DEFAULT_SAMPLES = 30;
const DEFAULT_WARMUPS = 3;

interface Distribution {
	count: number;
	min: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	mean: number;
}

function readPositiveInteger(name: string, fallback: number): number {
	const rawValue = process.env[name];
	if (rawValue === undefined) {
		return fallback;
	}
	const value = Number(rawValue);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function rounded(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

function percentile(sorted: readonly number[], value: number): number {
	const rank = Math.ceil((value / 100) * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

function distribution(samples: readonly number[]): Distribution {
	if (samples.length === 0) {
		throw new Error("Cannot summarize an empty latency sample");
	}
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		count: sorted.length,
		min: rounded(sorted[0] as number),
		p50: rounded(percentile(sorted, 50)),
		p95: rounded(percentile(sorted, 95)),
		p99: rounded(percentile(sorted, 99)),
		max: rounded(sorted.at(-1) as number),
		mean: rounded(
			sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
		),
	};
}

async function main(): Promise<void> {
	const sampleCount = readPositiveInteger(
		"ELIZA_PROVIDER_LATENCY_SAMPLES",
		DEFAULT_SAMPLES,
	);
	const warmupCount = readPositiveInteger(
		"ELIZA_PROVIDER_LATENCY_WARMUPS",
		DEFAULT_WARMUPS,
	);
	const { runtime, cleanup } = await createTestRuntime({
		characterName: "ProviderLatencyAudit",
	});
	try {
		const worldId = randomUUID() as UUID;
		const roomId = randomUUID() as UUID;
		const entityId = randomUUID() as UUID;
		await runtime.ensureWorldExists({
			id: worldId,
			name: "Provider latency audit",
			agentId: runtime.agentId,
		});
		await runtime.ensureConnection({
			entityId,
			roomId,
			worldId,
			worldName: "Provider latency audit",
			userName: "Latency auditor",
			name: "Latency auditor",
			source: "provider_latency_audit",
			channelId: roomId,
			type: ChannelType.DM,
		});
		await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

		const providerNames = runtime.providers.map((provider) => provider.name);
		const samplesByProvider = new Map<string, number[]>(
			providerNames.map((name) => [name, []]),
		);
		const wallSamples: number[] = [];
		const cachedWallSamples: number[] = [];
		const cachedProviderCounts: number[] = [];
		const providerSpanOverlapSamples: number[] = [];
		const iterations = warmupCount + sampleCount;

		for (let iteration = 0; iteration < iterations; iteration += 1) {
			const message: Memory = {
				id: randomUUID() as UUID,
				entityId,
				roomId,
				content: {
					text: "Measure the provider composition path.",
					source: "provider_latency_audit",
					channelType: ChannelType.DM,
				},
			};
			const timer = new InferenceTurnTimer({
				turnId: `provider-audit-${iteration}`,
				label: "provider-latency-audit",
			});
			const cachedTimer = new InferenceTurnTimer({
				turnId: `provider-audit-cached-${iteration}`,
				label: "provider-latency-audit-cached",
			});
			let wallMs = 0;
			let cachedWallMs = 0;
			await runWithTrajectoryContext(
				{ turnMemo: new Map<string, Promise<unknown>>() },
				async () => {
					const startedAt = performance.now();
					await runWithInferenceTiming(timer, () =>
						runtime.composeState(message, providerNames, true),
					);
					wallMs = performance.now() - startedAt;

					const cachedStartedAt = performance.now();
					await runWithInferenceTiming(cachedTimer, () =>
						runtime.composeState(message, providerNames, true, false, []),
					);
					cachedWallMs = performance.now() - cachedStartedAt;
				},
			);
			const summary = timer.close();
			const cachedSummary = cachedTimer.close();
			if (iteration < warmupCount) continue;

			wallSamples.push(wallMs);
			cachedWallSamples.push(cachedWallMs);
			cachedProviderCounts.push(
				cachedSummary.spans.filter((span) =>
					span.name.startsWith("provider-cache:"),
				).length,
			);
			let summedProviderMs = 0;
			for (const span of summary.spans) {
				if (!span.name.startsWith("provider:")) continue;
				const providerName = span.name.slice("provider:".length);
				samplesByProvider.get(providerName)?.push(span.durationMs);
				summedProviderMs += span.durationMs;
			}
			providerSpanOverlapSamples.push(
				wallMs > 0 ? summedProviderMs / wallMs : summedProviderMs,
			);
		}

		const providers = [...samplesByProvider.entries()]
			.map(([providerName, samples]) => ({
				providerName,
				latencyMs: distribution(samples),
			}))
			.sort(
				(a, b) =>
					b.latencyMs.p95 - a.latencyMs.p95 ||
					a.providerName.localeCompare(b.providerName),
			);
		const output = {
			generatedAt: new Date().toISOString(),
			runtime: "AgentRuntime + plugin-sql/PGLite",
			execution:
				"all registered providers via parallel composeState in one production turn context per sample",
			warmups: warmupCount,
			samples: sampleCount,
			providerCount: providerNames.length,
			freshComposeWallMs: distribution(wallSamples),
			reusedComposeWallMs: distribution(cachedWallSamples),
			reusedProviderResultsPerSample: distribution(cachedProviderCounts),
			providerSpanOverlap: distribution(providerSpanOverlapSamples),
			providers,
		};
		const serialized = `${JSON.stringify(output, null, 2)}\n`;
		const reportPath = process.env.ELIZA_PROVIDER_LATENCY_REPORT;
		if (reportPath) {
			await writeFile(reportPath, serialized, "utf8");
		}
		process.stdout.write(serialized);
	} finally {
		await cleanup();
	}
}

// error-policy:J1 CLI boundary translates failure into a non-zero process.
main().catch((error: unknown) => {
	process.stderr.write(
		`Provider latency audit failed: ${
			error instanceof Error ? error.stack : String(error)
		}\n`,
	);
	process.exitCode = 1;
});
