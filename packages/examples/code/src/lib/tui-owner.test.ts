/**
 * Verifies TUI owner bootstrap against the real shared Zustand store with
 * deterministic in-memory session persistence.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UUID } from "@elizaos/core";
import { useStore } from "./store.js";
import { resolveTuiOwnerUserId } from "./tui-owner.js";

const ORIGINAL_STATE = useStore.getState();

describe("resolveTuiOwnerUserId", () => {
  beforeEach(() => {
    process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE = "1";
  });

  afterEach(() => {
    useStore.setState(ORIGINAL_STATE, true);
    delete process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE;
  });

  it("returns the identity from the same store after loading it", async () => {
    const userId = "11111111-1111-4111-8111-111111111111" as UUID;
    const identity = { ...ORIGINAL_STATE.identity, userId };
    useStore.setState({ identity, sessionLoaded: false });

    await expect(resolveTuiOwnerUserId()).resolves.toBe(userId);
    expect(useStore.getState().sessionLoaded).toBe(true);
    expect(useStore.getState().identity).toBe(identity);
  });

  it("does not reload and replace an already resolved store identity", async () => {
    const userId = "22222222-2222-4222-8222-222222222222" as UUID;
    const identity = { ...ORIGINAL_STATE.identity, userId };
    useStore.setState({ identity, sessionLoaded: true });

    await expect(resolveTuiOwnerUserId()).resolves.toBe(userId);
    expect(useStore.getState().identity).toBe(identity);
  });
});

describe("resolveTuiOwnerUserId persisted session file", () => {
  const originalCwd = process.cwd();
  let fixtureRoot = "";

  beforeEach(async () => {
    delete process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE;
    fixtureRoot = await mkdtemp(join(tmpdir(), "eliza-code-owner-"));
    process.chdir(fixtureRoot);
    useStore.setState({ ...ORIGINAL_STATE, sessionLoaded: false }, true);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(fixtureRoot, { recursive: true, force: true });
    useStore.setState(ORIGINAL_STATE, true);
    delete process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE;
  });

  it("returns the persisted identity from a real session file", async () => {
    const sessionDir = join(fixtureRoot, ".eliza-code");
    const identity = {
      projectId: "10000000-0000-4000-8000-000000000001" as UUID,
      userId: "10000000-0000-4000-8000-000000000002" as UUID,
      worldId: "10000000-0000-4000-8000-000000000003" as UUID,
      messageServerId: "10000000-0000-4000-8000-000000000004" as UUID,
    };

    await mkdir(sessionDir);
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        currentRoomId: "default-main-room",
        currentTaskId: null,
        rooms: [
          {
            id: "default-main-room",
            name: "Main",
            messages: [],
            createdAt: Date.now(),
            taskIds: [],
            elizaRoomId: "20000000-0000-4000-8000-000000000001",
          },
        ],
        cwd: fixtureRoot,
        ...identity,
      }),
    );

    await expect(resolveTuiOwnerUserId()).resolves.toBe(identity.userId);
    expect(useStore.getState().identity).toEqual(identity);
    expect(useStore.getState().sessionLoaded).toBe(true);
  });
});
