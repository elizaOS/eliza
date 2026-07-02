// @vitest-environment node
//
// #11294: /copy copies the last assistant reply to the clipboard (OSC 52) and
// reports it; with no assistant reply it says so. Drives the real
// App.handleSlashCommand and intercepts terminal.write to verify the OSC-52
// payload without emitting it to stdout.

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
  const terminal = (
    app as unknown as { terminal: { write(data: string): void } }
  ).terminal;
  const writes: string[] = [];
  terminal.write = (data: string) => {
    writes.push(data);
  };
  const run = (cmd: string, args: string): Promise<boolean> =>
    (
      app as unknown as {
        handleSlashCommand(c: string, a: string): Promise<boolean>;
      }
    ).handleSlashCommand(cmd, args);
  return { run, writes };
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

function clipboardWrites(writes: string[]): string[] {
  return writes.filter((write) => write.startsWith("\x1b]52;c;"));
}

describe("/copy command (#11294)", () => {
  beforeEach(() => {
    freshRoom();
  });

  it("reports success when there is an assistant reply to copy", async () => {
    const { run, writes } = makeApp();
    const roomId = useStore.getState().currentRoomId;
    useStore.getState().addMessage(roomId, "user", "hi");
    useStore.getState().addMessage(roomId, "assistant", "the answer is 42");

    const handled = await run("copy", "");
    expect(handled).toBe(true);
    expect(clipboardWrites(writes)).toEqual([osc52("the answer is 42")]);
    expect(systemMessages(roomId).some((m) => m.includes("Copied"))).toBe(true);
  });

  it("says there is nothing to copy when no assistant reply exists", async () => {
    const { run, writes } = makeApp();
    const roomId = useStore.getState().currentRoomId;
    useStore.getState().addMessage(roomId, "user", "hi"); // user only

    const handled = await run("copy", "");
    expect(handled).toBe(true);
    expect(clipboardWrites(writes)).toEqual([]);
    expect(
      systemMessages(roomId).some((m) => m.includes("Nothing to copy")),
    ).toBe(true);
  });
});
