// @vitest-environment node
//
// #11294: /copy copies the last assistant reply to the clipboard (OSC 52) and
// reports it; with no assistant reply it says so. Drives the real
// App.handleSlashCommand (constructor is synchronous; terminal.write emits the
// OSC-52 to stdout harmlessly in a test).

import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
import { App } from "./App.js";
import { osc52 } from "./lib/clipboard.js";
import { useStore } from "./lib/store.js";

function makeApp() {
  const runtime = {
    agentId: "test",
    character: { name: "Eliza" },
    getService: () => null,
  } as unknown as AgentRuntime;
  const app = new App(runtime);
  const run = (cmd: string, args: string): Promise<boolean> =>
    (
      app as unknown as {
        handleSlashCommand(c: string, a: string): Promise<boolean>;
      }
    ).handleSlashCommand(cmd, args);
  // Capture terminal output so tests can assert the OSC-52 sequence is
  // actually emitted, not just that the chat message says it was.
  const written: string[] = [];
  const terminal = (
    app as unknown as { terminal: { write(data: string): void } }
  ).terminal;
  terminal.write = (data: string) => {
    written.push(data);
  };
  return { run, written };
}

function freshRoom() {
  useStore.setState({ rooms: [] });
  const room = useStore.getState().createRoom("Main");
  useStore.getState().switchRoom(room.id);
  return room.id;
}

function systemMessages(roomId: string): string[] {
  const room = useStore.getState().rooms.find((r) => r.id === roomId);
  return (room?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => m.content);
}

describe("/copy command (#11294)", () => {
  beforeEach(() => {
    freshRoom();
  });

  it("emits the OSC-52 clipboard sequence for the last assistant reply", async () => {
    const { run, written } = makeApp();
    const roomId = useStore.getState().currentRoomId;
    useStore.getState().addMessage(roomId, "user", "hi");
    useStore.getState().addMessage(roomId, "assistant", "the answer is 42");

    const handled = await run("copy", "");
    expect(handled).toBe(true);
    expect(systemMessages(roomId).some((m) => m.includes("Copied"))).toBe(true);
    // The core effect: the exact OSC-52 escape for the reply reached the
    // terminal (deleting the emission must red this test).
    expect(written).toContain(osc52("the answer is 42"));
  });

  it("says there is nothing to copy when no assistant reply exists", async () => {
    const { run, written } = makeApp();
    const roomId = useStore.getState().currentRoomId;
    useStore.getState().addMessage(roomId, "user", "hi"); // user only

    const handled = await run("copy", "");
    expect(handled).toBe(true);
    expect(
      systemMessages(roomId).some((m) => m.includes("Nothing to copy")),
    ).toBe(true);
    expect(written.filter((d) => d.includes("\x1b]52;"))).toHaveLength(0);
  });
});
