/**
 * Regression coverage for the notice-block fallbacks in `buildConversation`.
 * Drives the real exported helper with event records whose `summary` /
 * `eventType` are missing at runtime — a shape the DTO forbids but a stream
 * replay can still deliver — and asserts the renderer degrades to a labelled
 * notice instead of throwing. Deterministic and offline; no network, no DOM.
 */
import type { CodingAgentTaskEventRecord } from "@elizaos/ui/api/client-types-cloud";
import { describe, expect, it } from "vitest";
import { buildConversation } from "./orchestrator-stream.helpers";

function noticeEvent(
  overrides: Partial<CodingAgentTaskEventRecord> & { id: string },
): CodingAgentTaskEventRecord {
  return {
    threadId: "thread-1",
    sessionId: "session-1",
    turnId: null,
    eventType: "session_started",
    timestamp: 1_000,
    summary: "started",
    data: {},
    createdAt: new Date(1_000).toISOString(),
    ...overrides,
  } as CodingAgentTaskEventRecord;
}

function render(events: CodingAgentTaskEventRecord[]) {
  return buildConversation([], events, () => "sender", new Set<string>());
}

describe("buildConversation notice fallbacks", () => {
  it("labels a notice from its event type when the summary is missing", () => {
    // `summary` is typed as required, so a replayed record that omits it used
    // to reach `.trim()` on undefined and take down the whole conversation.
    const blocks = render([
      noticeEvent({
        id: "evt-1",
        eventType: "session_idle_timeout",
        summary: undefined as unknown as string,
      }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("notice");
    expect(blocks[0]).toMatchObject({ text: "session idle timeout" });
  });

  it("falls back to a generic notice when the event type is missing too", () => {
    const blocks = render([
      noticeEvent({
        id: "evt-2",
        eventType: undefined as unknown as string,
        summary: undefined as unknown as string,
      }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: "notice" });
  });

  it("still prefers a present summary over the fallback label", () => {
    const blocks = render([
      noticeEvent({ id: "evt-3", eventType: "error", summary: "  boom  " }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: "boom" });
  });
});
