import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  activateFollowUpOrigin,
  notePendingFollowUpOrigin,
  originMessageIdFor,
  readFollowUpOrigin,
  restoreFollowUpOrigin,
} from "../services/follow-up-origin.js";
import { requestVoiceKeyForMeta } from "../services/router-loop-guard.js";

function fakeService(initial: Record<string, unknown> = {}) {
  const metadata: Record<string, unknown> = { ...initial };
  return {
    metadata,
    getSession: async () => ({ metadata }),
    updateSessionMetadata: async (
      _id: string,
      patch: Record<string, unknown>,
    ) => {
      Object.assign(metadata, patch);
    },
  };
}

describe("follow-up origin re-keys the session's voice", () => {
  it("queued then flushed: the follow-up's id becomes the request key", async () => {
    const service = fakeService({ spawnRootMessageId: "build-msg" });
    expect(requestVoiceKeyForMeta(service.metadata)).toBe("build-msg");
    await notePendingFollowUpOrigin(service, "s1", "followup-msg");
    // Still the build's turn while it is queued.
    expect(requestVoiceKeyForMeta(service.metadata)).toBe("build-msg");
    await activateFollowUpOrigin(service, "s1");
    expect(requestVoiceKeyForMeta(service.metadata)).toBe("followup-msg");
    expect(await readFollowUpOrigin(service, "s1")).toBe("followup-msg");
  });

  it("a direct send that lost the race hands the voice back", async () => {
    const service = fakeService({ spawnRootMessageId: "build-msg" });
    await activateFollowUpOrigin(service, "s1", "followup-msg");
    await restoreFollowUpOrigin(service, "s1", undefined, "followup-msg");
    expect(requestVoiceKeyForMeta(service.metadata)).toBe("build-msg");
    await activateFollowUpOrigin(service, "s1");
    expect(requestVoiceKeyForMeta(service.metadata)).toBe("followup-msg");
  });

  it("keeps the fan-out part suffix", () => {
    expect(
      requestVoiceKeyForMeta({
        spawnRootMessageId: "build-msg",
        followUpOriginMessageId: "followup-msg",
        requestVoicePart: "part:1",
      }),
    ).toBe(`followup-msg\u0000part:1`);
  });

  it("derives the connector message id of a room message", () => {
    expect(
      originMessageIdFor({
        id: "mem-1",
        metadata: { discordMessageId: "1540600000000000000" },
        content: { text: "also make it dark" },
      } as unknown as Memory),
    ).toBe("1540600000000000000");
    expect(
      originMessageIdFor({
        id: "mem-2",
        content: { text: "x" },
      } as unknown as Memory),
    ).toBe("mem-2");
  });
});
