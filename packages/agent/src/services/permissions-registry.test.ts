/**
 * Behavioural coverage for the PermissionRegistry singleton: the default state
 * returned for unknown ids, prober registration and check()/request() state
 * transitions, openSettings delegation, recordBlock stamping, the pending()
 * filter, subscriber notify/unsubscribe, and persistence hydrate round-trips.
 * Runs against an in-memory persistence double and vi.fn-backed mock probers (no
 * real native permission dialogs), with a real tmpdir standing in for
 * ELIZA_STATE_DIR.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type { PermissionId, PermissionState } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionRegistry, type Prober } from "./permissions-registry.ts";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    character: { name: "test" },
  } as unknown as IAgentRuntime;
}

class InMemoryPersistence {
  data: PermissionState[] | null = null;
  reads = 0;
  writes = 0;
  read(): PermissionState[] | null {
    this.reads += 1;
    return this.data;
  }
  write(states: PermissionState[]): void {
    this.writes += 1;
    this.data = states.map((s) => ({ ...s }));
  }
}

function makeProber(
  id: PermissionId,
  initial: Partial<PermissionState> = {},
): Prober & {
  checkMock: ReturnType<typeof vi.fn>;
  requestMock: ReturnType<typeof vi.fn>;
  state: PermissionState;
} {
  const state: PermissionState = {
    id,
    status: "not-determined",
    canRequest: true,
    lastChecked: Date.now(),
    platform: "darwin",
    ...initial,
  };
  const checkMock = vi.fn(async () => ({ ...state }));
  const requestMock = vi.fn(async () => {
    state.status = "granted";
    state.lastChecked = Date.now();
    return { ...state };
  });
  return {
    id,
    state,
    checkMock,
    requestMock,
    check: checkMock,
    request: requestMock,
  };
}

function makeRegistry(persistence: InMemoryPersistence): PermissionRegistry {
  return new PermissionRegistry(makeRuntime(), {
    persistence,
    persistDebounceMs: 0,
  });
}

describe("PermissionRegistry", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "perm-registry-"));
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ELIZA_STATE_DIR;
  });

  it("starts empty and returns a default state for unknown ids", () => {
    const persistence = new InMemoryPersistence();
    const registry = makeRegistry(persistence);
    const state = registry.get("camera");
    expect(state.id).toBe("camera");
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it("registers a prober and updates state on check()", async () => {
    const persistence = new InMemoryPersistence();
    const registry = makeRegistry(persistence);
    const prober = makeProber("microphone", { status: "denied" });
    registry.registerProber(prober);

    const result = await registry.check("microphone");
    expect(result.status).toBe("denied");
    expect(prober.checkMock).toHaveBeenCalledOnce();

    const stored = registry.get("microphone");
    expect(stored.status).toBe("denied");
  });

  // website-blocking is covered alongside calendar because its prober is
  // supplied only by @elizaos/plugin-personal-assistant (#12660): with the
  // central stub gone, an unloaded plugin means no prober, and check/request
  // must throw here rather than silently reporting the old "granted".
  it.each([
    "calendar",
    "website-blocking",
  ] as const)("throws for check() / request() when no prober is registered (%s)", async (id) => {
    const persistence = new InMemoryPersistence();
    const registry = makeRegistry(persistence);
    const pattern = new RegExp(`no prober registered for ${id}`);
    await expect(registry.check(id)).rejects.toThrow(pattern);
    await expect(
      registry.request(id, {
        reason: "x",
        feature: { app: "app", action: "act" },
      }),
    ).rejects.toThrow(pattern);
  });

  it("updates state and stamps lastRequested + lastBlockedFeature on request()", async () => {
    const persistence = new InMemoryPersistence();
    const registry = makeRegistry(persistence);
    const prober = makeProber("contacts");
    registry.registerProber(prober);

    const before = Date.now();
    const result = await registry.request("contacts", {
      reason: "Need access",
      feature: { app: "address-book", action: "list" },
    });
    expect(result.status).toBe("granted");
    expect(result.lastRequested).toBeGreaterThanOrEqual(before);
    expect(result.lastBlockedFeature).toMatchObject({
      app: "address-book",
      action: "list",
    });
    expect(prober.requestMock).toHaveBeenCalledWith({ reason: "Need access" });
  });

  it("delegates openSettings() to a registered prober when available", async () => {
    const persistence = new InMemoryPersistence();
    const registry = makeRegistry(persistence);
    const prober = makeProber("website-blocking");
    const openSettings = vi.fn(async () => true);
    registry.registerProber({ ...prober, openSettings });

    await expect(registry.openSettings("website-blocking")).resolves.toBe(true);

    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("returns false for openSettings() when no hook is registered", async () => {
    const persistence = new InMemoryPersistence();
    const registry = makeRegistry(persistence);
    registry.registerProber(makeProber("website-blocking"));

    await expect(registry.openSettings("website-blocking")).resolves.toBe(
      false,
    );
    await expect(registry.openSettings("camera")).resolves.toBe(false);
  });

  it("recordBlock() updates lastBlockedFeature without a prober and persists", () => {
    const persistence = new InMemoryPersistence();
    const registry = makeRegistry(persistence);

    registry.recordBlock("notifications", {
      app: "lifeops",
      action: "remind",
    });

    const state = registry.get("notifications");
    expect(state.lastBlockedFeature).toMatchObject({
      app: "lifeops",
      action: "remind",
    });
    expect(persistence.writes).toBeGreaterThan(0);
    expect(persistence.data?.[0]?.id).toBe("notifications");
  });

  it("pending() returns not-determined states and recently-blocked ones", async () => {
    const persistence = new InMemoryPersistence();
    const registry = makeRegistry(persistence);

    const grantedProber = makeProber("camera", { status: "granted" });
    registry.registerProber(grantedProber);
    await registry.check("camera");

    const undetermined = makeProber("microphone", { status: "not-determined" });
    registry.registerProber(undetermined);
    await registry.check("microphone");

    registry.recordBlock("notifications", { app: "x", action: "y" });

    const oldProber = makeProber("location", { status: "granted" });
    registry.registerProber(oldProber);
    await registry.check("location");
    const old = registry.get("location");
    (
      old as { lastBlockedFeature?: PermissionState["lastBlockedFeature"] }
    ).lastBlockedFeature = {
      app: "x",
      action: "y",
      at: Date.now() - 25 * 60 * 60 * 1000,
    };

    const ids = registry.pending().map((s) => s.id);
    expect(ids).toContain("microphone");
    expect(ids).toContain("notifications");
    expect(ids).not.toContain("camera");
    expect(ids).not.toContain("location");
  });

  it("notifies subscribers on mutation and supports unsubscribe", () => {
    const persistence = new InMemoryPersistence();
    const registry = makeRegistry(persistence);
    const cb = vi.fn();
    const unsubscribe = registry.subscribe(cb);

    registry.recordBlock("calendar", { app: "a", action: "b" });
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    registry.recordBlock("reminders", { app: "a", action: "b" });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("round-trips state through persistence on hydrate", async () => {
    const persistence = new InMemoryPersistence();
    const first = makeRegistry(persistence);
    first.hydrate();
    const prober = makeProber("health", { status: "granted" });
    first.registerProber(prober);
    await first.check("health");

    expect(persistence.data?.find((s) => s.id === "health")?.status).toBe(
      "granted",
    );

    const second = makeRegistry(persistence);
    second.hydrate();
    expect(second.get("health").status).toBe("granted");
  });
});
