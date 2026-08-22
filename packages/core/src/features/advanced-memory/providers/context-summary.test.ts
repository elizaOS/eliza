/**
 * Verifies summarized context includes the persisted body-free content index
 * through a stub memory service; no database, model, or live capture is used.
 */

import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { Memory, State } from "../../../types/index.ts";
import type { JsonValue } from "../../../types/primitives.ts";
import { SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY } from "../session-summary-content-manifest.ts";
import { contextSummaryProvider } from "./context-summary.ts";

vi.mock("../../../utils.ts", () => ({
	addHeader: (header: string, body: string) => `${header}\n${body}`,
}));

describe("contextSummaryProvider content manifest", () => {
	it("adds bounded opaque references without rendering entry reasons", async () => {
		const memoryService = {
			getCurrentSessionSummary: async () => ({
				summary: "The user chose the review workflow.",
				messageCount: 8,
				startTime: new Date("2026-08-21T20:00:00.000Z"),
				topics: ["review"],
				metadata: {
					[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY]: {
						schemaVersion: 1,
						contentManifest: {
							schemaVersion: 1,
							contentRefs: [
								{
									reference: {
										kind: "document",
										ref: "document-opaque-1",
									},
									reason: "SOURCE BODY MUST STAY OUT OF CONTEXT",
									rangesUsed: [{ unit: "fragment", start: 2, end: 5 }],
									lastUsedAt: "2026-08-21T20:30:00.000Z",
									retained: true,
								},
							],
							modifiedFiles: [],
							pendingProcesses: [],
						},
					} as unknown as JsonValue,
					contentManifest: {
						custom: "legacy metadata must be ignored",
					} as unknown as JsonValue,
				},
			}),
		};
		const runtime = createMockRuntime({
			agentId: "agent-1",
			character: { name: "Agent" },
			getService: (name: string) =>
				name === "memory" ? (memoryService as never) : null,
		});

		const result = await contextSummaryProvider.get(
			runtime,
			{
				id: "message-1",
				entityId: "user-1",
				roomId: "room-1",
				content: { text: "continue" },
			} as Memory,
			{} as State,
		);

		expect(result.text).toContain("The user chose the review workflow.");
		expect(result.text).toContain("document:document-opaque-1");
		expect(result.text).toContain("fragment:2-5");
		expect(result.text).not.toContain("SOURCE BODY MUST STAY OUT OF CONTEXT");
		expect(result.text).not.toContain("legacy metadata must be ignored");
		expect(result.data?.contentManifestReferenceCount).toBe(1);
	});
});
