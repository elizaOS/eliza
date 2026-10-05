/** Exercises real browser dispatch routing so native effects never replay against another session. */
import { describe, expect, it } from "vitest";
import { BrowserService } from "./browser-service";
import { BrowserDispatchFailure } from "./dispatch-types";

describe("native browser dispatch", () => {
  it("classifies an interrupted native navigation as uncertain without opening a server browser", async () => {
    const service = new BrowserService();
    let serverCalls = 0;
    service.registerTarget({
      id: "workspace",
      name: "workspace",
      description: "server session",
      available: async () => true,
      execute: async () => {
        serverCalls++;
        return { mode: "desktop", subaction: "navigate" };
      },
    });
    const cause = new Error("reply lost");
    service.setNativeClientTransport({
      readPage: async () => {
        throw new Error("not a read");
      },
      navigate: async () => {
        throw cause;
      },
    });
    await expect(
      service.execute(
        { subaction: "navigate", url: "https://example.com" },
        undefined,
        "phone",
      ),
    ).rejects.toMatchObject({
      kind: "UNCERTAIN_OUTCOME",
      targetId: "native-client",
      cause,
    });
    expect(serverCalls).toBe(0);
  });

  it("routes a snapshot-bound click only to the requesting client", async () => {
    const service = new BrowserService();
    const calls: unknown[] = [];
    service.setNativeClientTransport({
      readPage: async () => {
        throw new Error("not a read");
      },
      navigate: async () => {},
      executeCommand: async (clientId, command) => {
        calls.push({ clientId, command });
        return {
          mode: "web",
          subaction: command.subaction,
          value: { dispatched: true, completed: false, requiresReadback: true },
        };
      },
    });
    const command = { subaction: "click" as const, selector: "snapshot:ax-4" };
    const result = await service.execute(command, undefined, "phone");
    expect(calls).toEqual([{ clientId: "phone", command }]);
    expect(result.value).toMatchObject({
      completed: false,
      requiresReadback: true,
    });
  });

  it("preserves a native stale-reference rejection", async () => {
    const service = new BrowserService();
    const failure = new BrowserDispatchFailure(
      "STALE_REF",
      "Read a fresh snapshot.",
      { targetId: "native-client" },
    );
    service.setNativeClientTransport({
      readPage: async () => null,
      navigate: async () => {},
      executeCommand: async () => {
        throw failure;
      },
    });
    await expect(
      service.execute(
        { subaction: "click", selector: "stale" },
        undefined,
        "phone",
      ),
    ).rejects.toBe(failure);
  });
});
