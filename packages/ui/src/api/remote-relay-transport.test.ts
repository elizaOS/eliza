/** Pins per-session enqueue ordering independently from terminal result polling. */
import { describe, expect, it } from "vitest";

import { remoteRelayTransportInternals } from "./remote-relay-transport";

describe("remote relay enqueue ordering", () => {
  it("does not let sequence two reach Cloud before a slow sequence one", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = remoteRelayTransportInternals.withSessionEnqueue(
      "session-1",
      async () => {
        events.push("first-created");
        await firstGate;
        events.push("first-enqueued");
      },
    );
    const second = remoteRelayTransportInternals.withSessionEnqueue(
      "session-1",
      async () => {
        events.push("second-created");
        events.push("second-enqueued");
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first-created"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first-created",
      "first-enqueued",
      "second-created",
      "second-enqueued",
    ]);
  });
});
