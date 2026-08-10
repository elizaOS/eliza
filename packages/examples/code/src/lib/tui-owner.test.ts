/**
 * Verifies TUI owner bootstrap against the real shared Zustand store with
 * deterministic in-memory session persistence.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
