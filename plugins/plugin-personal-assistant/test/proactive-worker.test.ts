/**
 * Covers the proactive activity worker's inbox-digest request shape: personal inbox
 * channels only, thread-grouped, missed-only, priority-sorted. Deterministic.
 */
import { describe, expect, it } from "vitest";
import { proactiveInboxDigestRequest } from "../src/activity-profile/proactive-inbox-digest.js";

describe("proactive activity worker", () => {
  it("uses only personal inbox channels for proactive digests", () => {
    const request = proactiveInboxDigestRequest();

    expect(request).toMatchObject({
      limit: 24,
      groupByThread: true,
      missedOnly: true,
      sortByPriority: true,
    });
    expect(request.channels).toEqual([
      "gmail",
      "x_dm",
      "imessage",
      "whatsapp",
      "sms",
    ]);
    expect(request.channels).not.toContain("discord");
    expect(request.channels).not.toContain("telegram");
    expect(request.channels).not.toContain("signal");
  });
});
