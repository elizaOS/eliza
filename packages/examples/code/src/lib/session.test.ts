/** Covers durable session serialization, validation, and room-identity migration using the real filesystem. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSessionIdentity } from "./identity.js";
import { loadSession, type SessionState, saveSession } from "./session.js";

const originalCwd = process.cwd();
let testCwd = "";

beforeEach(async () => {
  testCwd = await mkdtemp(join(tmpdir(), "eliza-code-session-"));
  process.chdir(testCwd);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(testCwd, { recursive: true });
});

function state(): SessionState {
  return {
    rooms: [
      {
        id: "main",
        name: "Main",
        createdAt: new Date(1_700_000_000_000),
        taskIds: [],
        elizaRoomId: ensureSessionIdentity().worldId,
        messages: [
          {
            id: "message",
            role: "user",
            content: "hello",
            timestamp: new Date(1_700_000_001_000),
            roomId: "main",
            kind: "chat",
          },
        ],
      },
    ],
    currentRoomId: "main",
    currentTaskId: null,
    cwd: testCwd,
    identity: ensureSessionIdentity(),
    focusedPane: "tasks",
    taskPaneVisibility: "shown",
    taskPaneWidthFraction: 0.55,
    showFinishedTasks: true,
    selectedSubAgentType: "codex",
  };
}

describe("session persistence", () => {
  it("round-trips messages, identity, and UI state", async () => {
    const expected = state();
    await saveSession(expected);
    const loaded = await loadSession();

    expect(loaded?.currentRoomId).toBe("main");
    expect(loaded?.rooms[0].messages[0].timestamp).toEqual(
      new Date(1_700_000_001_000),
    );
    expect(loaded?.rooms[0].messages[0].kind).toBe("chat");
    expect(loaded?.identity).toEqual(expected.identity);
    expect(loaded?.taskPaneWidthFraction).toBe(0.55);
  });

  it("returns null for missing, malformed, and empty sessions", async () => {
    expect(await loadSession()).toBeNull();
    await mkdir(".eliza-code");
    await writeFile(".eliza-code/session.json", "not json");
    expect(await loadSession()).toBeNull();
    await writeFile(
      ".eliza-code/session.json",
      JSON.stringify({ version: 1, currentRoomId: "main", rooms: [] }),
    );
    expect(await loadSession()).toBeNull();
  });

  it("repairs invalid room identities and selects an existing current room", async () => {
    await saveSession(state());
    const path = ".eliza-code/session.json";
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.currentRoomId = "missing";
    persisted.rooms[0].elizaRoomId = "not-a-uuid";
    persisted.rooms[0].messages[0].role = "invalid";
    persisted.rooms[0].messages[0].kind = "invalid";
    await writeFile(path, JSON.stringify(persisted));

    const loaded = await loadSession();
    expect(loaded?.currentRoomId).toBe("main");
    expect(loaded?.rooms[0].elizaRoomId).toMatch(/^[0-9a-f-]{36}$/);
    expect(loaded?.rooms[0].messages[0].role).toBe("system");
    expect(loaded?.rooms[0].messages[0].kind).toBeUndefined();
  });
});
