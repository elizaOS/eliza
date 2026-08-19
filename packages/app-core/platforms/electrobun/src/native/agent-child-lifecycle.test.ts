/**
 * Embedded-runtime termination tests use deterministic subprocess handles to
 * prove graceful, escalated, and synchronous host-exit ownership.
 */

import { describe, expect, it } from "vitest";
import {
  terminateOwnedChildProcess,
  terminateOwnedChildProcessOnHostExit,
} from "./agent";

type OwnedChild = Parameters<typeof terminateOwnedChildProcess>[0];

function childProcessFixture(options: {
  exitCode?: number | null;
  exited?: Promise<number>;
}) {
  const signals: Array<number | string> = [];
  const child = {
    pid: 4242,
    exitCode: options.exitCode ?? null,
    exited: options.exited ?? Promise.resolve(0),
    kill(signal?: number | string) {
      signals.push(signal ?? "SIGTERM");
    },
  } as unknown as OwnedChild;
  return { child, signals };
}

describe("embedded runtime process ownership", () => {
  it("does not signal a child that already exited", async () => {
    const { child, signals } = childProcessFixture({ exitCode: 0 });

    await expect(terminateOwnedChildProcess(child)).resolves.toBe(
      "already-exited",
    );
    expect(signals).toEqual([]);
  });

  it("allows the child to settle after SIGTERM", async () => {
    const { child, signals } = childProcessFixture({});

    await expect(
      terminateOwnedChildProcess(child, {
        graceMs: 1,
        wait: () => new Promise(() => undefined),
      }),
    ).resolves.toBe("sigterm");
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("escalates an unresponsive child to SIGKILL", async () => {
    const { child, signals } = childProcessFixture({
      exited: new Promise(() => undefined),
    });

    await expect(
      terminateOwnedChildProcess(child, {
        graceMs: 1,
        killSettleMs: 1,
        wait: () => Promise.resolve(),
      }),
    ).resolves.toBe("sigkill");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("kills a live child synchronously when the desktop host exits", () => {
    const { child, signals } = childProcessFixture({
      exited: new Promise(() => undefined),
    });

    terminateOwnedChildProcessOnHostExit(child);

    expect(signals).toEqual(["SIGKILL"]);
  });
});
