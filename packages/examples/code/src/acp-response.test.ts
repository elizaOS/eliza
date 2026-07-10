/**
 * ACP reply publication is tested at the transport boundary with a
 * deterministic publisher, keeping raw planner envelopes out of captured text.
 */

import { describe, expect, it } from "bun:test";
import { type AcpTextUpdate, publishParsedReply } from "./acp-response.js";

describe("ACP parsed reply publication (#15814)", () => {
  it("publishes exactly one authoritative user-facing chunk", async () => {
    const updates: AcpTextUpdate[] = [];
    const parsedReply = "Created the requested application.";

    await publishParsedReply("session-1", parsedReply, async (update) => {
      updates.push(update);
    });

    expect(updates).toEqual([
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: parsedReply },
        },
      },
    ]);
    expect(JSON.stringify(updates)).not.toContain('```json {"response"');
  });

  it("does not fabricate a chunk for an empty parsed reply", async () => {
    const updates: AcpTextUpdate[] = [];

    await publishParsedReply("session-1", "   ", async (update) => {
      updates.push(update);
    });

    expect(updates).toEqual([]);
  });

  it("propagates transport failures to the ACP request boundary", async () => {
    const failure = new Error("transport closed");

    await expect(
      publishParsedReply("session-1", "done", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
