/**
 * Cross-app tests for the `stopRun` hook on each game plugin.
 *
 * The hook is invoked by app-manager's `invokeAppStopRunHook` when the
 * user presses Stop on a running game. It must tear down per-run
 * server-side resources (bot connections, game-loop timers, embedded
 * servers) so the game actually stops instead of just unmounting the
 * viewer iframe.
 *
 * Co-located here because app-lifeops is the only workspace package that
 * already has vitest wired up AND can reach sibling apps via relative
 * imports. Pure unit tests — no real services, no real network.
 */

import { describe, expect, test, vi } from "vitest";

// Relative imports so no workspace-dep wiring is required. Path-check:
// apps/app-lifeops/test/ → apps/app-<name>/src/routes.ts.
import { stopRun as babylonStopRun } from "../../app-babylon/src/routes.js";
import { stopRun as clawvilleStopRun } from "../../app-clawville/src/routes.js";
import { stopRun as defenseStopRun } from "../../app-defense-of-the-agents/src/routes.js";
import { stopRun as hyperscapeStopRun } from "../../app-hyperscape/src/routes.js";
import { stopRun as scapeStopRun } from "../../app-scape/src/routes.js";
import { stopRun as twoThousandFourStopRun } from "../../app-2004scape/src/routes.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

describe("app-scape stopRun", () => {
  test("calls scape_game service.stop() when registered", async () => {
    const serviceStop = vi.fn(async () => {});
    const getService = vi.fn((name: string) =>
      name === "scape_game" ? { stop: serviceStop } : null,
    );
    const runtime = { agentId: AGENT_ID, getService };
    await scapeStopRun({ runtime });
    expect(getService).toHaveBeenCalledWith("scape_game");
    expect(serviceStop).toHaveBeenCalledOnce();
  });

  test("is a no-op when scape_game service is not registered", async () => {
    const runtime = {
      agentId: AGENT_ID,
      getService: vi.fn(() => null),
    };
    await expect(scapeStopRun({ runtime })).resolves.toBeUndefined();
  });

  test("propagates service.stop errors to the app-manager boundary", async () => {
    const serviceStop = vi.fn(async () => {
      throw new Error("boom");
    });
    const runtime = {
      agentId: AGENT_ID,
      getService: vi.fn(() => ({ stop: serviceStop })),
    };
    await expect(scapeStopRun({ runtime })).rejects.toThrow("boom");
    expect(serviceStop).toHaveBeenCalledOnce();
  });

  test("is a no-op when runtime is null", async () => {
    await expect(scapeStopRun({ runtime: null })).resolves.toBeUndefined();
  });
});

describe("app-2004scape stopRun", () => {
  test("calls rs_2004scape service.stop() when registered", async () => {
    const serviceStop = vi.fn(async () => {});
    const getService = vi.fn((name: string) =>
      name === "rs_2004scape" ? { stop: serviceStop } : null,
    );
    const runtime = { agentId: AGENT_ID, getService };
    await twoThousandFourStopRun({ runtime });
    expect(getService).toHaveBeenCalledWith("rs_2004scape");
    expect(serviceStop).toHaveBeenCalledOnce();
  });

  test("is a no-op when rs_2004scape service is not registered", async () => {
    const runtime = {
      agentId: AGENT_ID,
      getService: vi.fn(() => null),
    };
    await expect(
      twoThousandFourStopRun({ runtime }),
    ).resolves.toBeUndefined();
  });

  test("is a no-op when service has no .stop method", async () => {
    const runtime = {
      agentId: AGENT_ID,
      getService: vi.fn(() => ({})),
    };
    await expect(
      twoThousandFourStopRun({ runtime }),
    ).resolves.toBeUndefined();
  });

  test("propagates service.stop errors to the app-manager boundary", async () => {
    const serviceStop = vi.fn(async () => {
      throw new Error("boom");
    });
    const runtime = {
      agentId: AGENT_ID,
      getService: vi.fn(() => ({ stop: serviceStop })),
    };
    await expect(
      twoThousandFourStopRun({ runtime }),
    ).rejects.toThrow("boom");
    expect(serviceStop).toHaveBeenCalledOnce();
  });
});

describe("app-defense-of-the-agents stopRun", () => {
  test("does not throw when no game loop is running", async () => {
    const runtime = {
      agentId: `${AGENT_ID}-defense`,
      getService: vi.fn(() => null),
      getSetting: vi.fn(() => null),
      setSetting: vi.fn(() => undefined),
    };
    await expect(defenseStopRun({ runtime })).resolves.toBeUndefined();
  });

  test("is a no-op when runtime is null", async () => {
    await expect(defenseStopRun({ runtime: null })).resolves.toBeUndefined();
  });
});

describe("stateless games (babylon / hyperscape / clawville) stopRun", () => {
  test("babylon stopRun is a safe no-op", async () => {
    await expect(babylonStopRun()).resolves.toBeUndefined();
  });

  test("hyperscape stopRun is a safe no-op", async () => {
    await expect(hyperscapeStopRun()).resolves.toBeUndefined();
  });

  test("clawville stopRun is a safe no-op", async () => {
    await expect(clawvilleStopRun()).resolves.toBeUndefined();
  });
});
