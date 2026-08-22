/**
 * Verifies the rolling summary processor preserves prior metadata and persists
 * validated content manifests attached to the dialogue slice, using stubs only.
 */

import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	EvaluatorRunOptions,
	Memory,
	State,
} from "../../../types/index.ts";
import type { JsonValue } from "../../../types/primitives.ts";
import {
	parseSessionSummaryContentManifest,
	SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY,
} from "../session-summary-content-manifest.ts";
import { type SummaryPrepared, summaryEvaluator } from "./memory-items.ts";

const contentManifest = {
	schemaVersion: 1,
	contentRefs: [
		{
			reference: { kind: "attachment", ref: "attachment-1", revision: "r1" },
			revision: "r1",
			reason: "tool:read_attachment",
			rangesUsed: [{ unit: "byte", start: 0, end: 128 }],
			lastUsedAt: "2026-08-21T20:00:00.000Z",
			retained: true,
		},
	],
	modifiedFiles: [],
	pendingProcesses: [],
};

function message(metadata?: Record<string, unknown>): Memory {
	return {
		id: "message-1",
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "dialogue", senderName: "User" },
		metadata,
		createdAt: 1,
	} as unknown as Memory;
}

function progressiveContentMetadata(): Record<string, unknown> {
	return {
		[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY]: {
			schemaVersion: 1,
			contentManifest,
		},
	};
}

const runtime = createMockRuntime({
	agentId: "agent-1",
	character: { name: "Agent" },
});

describe("summaryEvaluator manifest persistence", () => {
	it("an ordinary rolling update cannot erase the existing manifest or metadata", async () => {
		let updates: Record<string, unknown> | undefined;
		const memoryService = {
			updateSessionSummary: async (
				_id: string,
				_roomId: string,
				value: Record<string, unknown>,
			) => {
				updates = value;
			},
		} as unknown as SummaryPrepared["memoryService"];
		const existingMetadata = {
			custom: "preserve-me",
			...progressiveContentMetadata(),
		};
		const prepared: SummaryPrepared = {
			memoryService,
			summarizationMessages: [message()],
			existingSummary: {
				id: "summary-1",
				messageCount: 4,
				lastMessageOffset: 4,
				startTime: new Date(0),
				metadata: existingMetadata,
			} as SummaryPrepared["existingSummary"],
			lastOffset: 4,
			totalDialogueCount: 5,
			canSummarize: true,
		};

		await summaryEvaluator.processors?.[0]?.process({
			runtime,
			message: message(),
			state: {} as State,
			options: {} as EvaluatorRunOptions,
			prepared,
			output: { text: "updated", topics: ["topic"], keyPoints: ["point"] },
			evaluatorName: "summary",
		});

		const metadata = updates?.metadata as Record<string, JsonValue>;
		expect(metadata.custom).toBe("preserve-me");
		expect(metadata.keyPoints).toEqual(["point"]);
		expect(parseSessionSummaryContentManifest(metadata)).toEqual(
			contentManifest,
		);
	});

	it("persists a validated manifest attached to a newly summarized message", async () => {
		let stored: Record<string, unknown> | undefined;
		const memoryService = {
			storeSessionSummary: async (value: Record<string, unknown>) => {
				stored = value;
			},
		} as unknown as SummaryPrepared["memoryService"];
		const prepared: SummaryPrepared = {
			memoryService,
			summarizationMessages: [message(progressiveContentMetadata())],
			existingSummary: null,
			lastOffset: 0,
			totalDialogueCount: 1,
			canSummarize: true,
		};

		await summaryEvaluator.processors?.[0]?.process({
			runtime,
			message: message(),
			state: {} as State,
			options: {} as EvaluatorRunOptions,
			prepared,
			output: { text: "first", topics: [], keyPoints: [] },
			evaluatorName: "summary",
		});

		const metadata = stored?.metadata as Record<string, JsonValue>;
		expect(parseSessionSummaryContentManifest(metadata)).toEqual(
			contentManifest,
		);
	});
});
