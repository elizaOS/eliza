/**
 * Integration-backed coverage for binding a completed planner trajectory to its
 * immutable room continuity head, including non-replay failure reporting.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter.ts";
import {
	loadSessionSummaryContentLedger,
	parseSessionSummaryContentEnvelope,
} from "../features/advanced-memory/session-summary-content-manifest.ts";
import { buildReadSlice, buildReadView } from "../types/content.ts";
import type { Memory } from "../types/memory.ts";
import type { UUID } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { stringToUuid } from "../utils.ts";
import { persistMessageContentContinuity } from "./message-content-continuity.ts";

const agentId = stringToUuid("message-continuity-agent");
const roomId = stringToUuid("message-continuity-room");
const entityId = stringToUuid("message-continuity-entity");
const messageId = stringToUuid("message-continuity-message");

function trajectory() {
	return {
		archivedSteps: [],
		steps: [
			{
				iteration: 1,
				toolCall: { name: "FILE" },
				result: {
					success: true,
					promptData: buildReadView({
						reference: {
							kind: "file",
							ref: "opaque-message-file",
							revision: "rev-1",
						},
						slice: buildReadSlice({
							range: { unit: "byte", start: 0, end: 64, total: 128 },
							completeness: "partial-recoverable",
							sliceSha256: "a".repeat(64),
							revision: "rev-1",
						}),
					}),
				},
			},
		],
	};
}

async function harness() {
	const adapter = new InMemoryDatabaseAdapter();
	const message: Memory = {
		id: messageId,
		agentId,
		roomId,
		entityId,
		content: { text: "read the file" },
		metadata: { type: "message", topics: ["files"] },
	};
	await adapter.createMemories([{ memory: message, tableName: "messages" }]);
	const reportError = vi.fn();
	const runtime = {
		agentId,
		adapter,
		reportError,
		logger: { warn: vi.fn() },
		getMemoryById: async (id: UUID) =>
			(await adapter.getMemoriesByIds([id]))[0] ?? null,
		updateMemory: async (update: Partial<Memory> & { id: UUID }) => {
			await adapter.updateMemories([update]);
			return true;
		},
	} as unknown as IAgentRuntime;
	return { adapter, message, reportError, runtime };
}

describe("persistMessageContentContinuity", () => {
	it("publishes the complete ledger and retains concurrent dialogue metadata", async () => {
		const { message, reportError, runtime } = await harness();
		await persistMessageContentContinuity({
			runtime,
			message,
			trajectory: trajectory(),
			lastUsedAt: "2026-08-23T12:00:00.000Z",
		});

		const persisted = await runtime.getMemoryById(messageId);
		expect(persisted?.metadata).toMatchObject({ topics: ["files"] });
		const envelope = parseSessionSummaryContentEnvelope(persisted?.metadata);
		expect(envelope?.recordCount).toBe(1);
		if (!envelope) throw new Error("continuity envelope missing");
		const ledger = await loadSessionSummaryContentLedger(
			runtime,
			envelope,
			roomId,
		);
		expect(ledger.records).toMatchObject([
			{
				kind: "content-reference",
				value: {
					reference: { kind: "file", ref: "opaque-message-file" },
					rangesUsed: [{ unit: "byte", start: 0, end: 64 }],
				},
			},
		]);
		expect(reportError).not.toHaveBeenCalled();
	});

	it("reports unsupported durable publication without replaying or throwing", async () => {
		const { message, reportError, runtime } = await harness();
		(runtime as unknown as { adapter: object }).adapter = {};
		await expect(
			persistMessageContentContinuity({
				runtime,
				message,
				trajectory: trajectory(),
				lastUsedAt: "2026-08-23T12:00:00.000Z",
			}),
		).resolves.toBeUndefined();
		expect(reportError).toHaveBeenCalledWith(
			"MessageService.persistContentManifest",
			expect.anything(),
			expect.objectContaining({ messageId, roomId }),
		);
	});
});
