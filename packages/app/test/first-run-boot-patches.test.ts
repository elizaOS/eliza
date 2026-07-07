/**
 * Boot-path regression tests for the main-window first-run patches (#14382).
 *
 * PR #14444 shipped the non-destructive `?onboarding-replay=1` module but left
 * it uncalled — a dev appending the param got nothing. These tests pin the
 * actual boot wiring (`src/first-run-boot-patches.ts`, called by
 * `src/main.tsx`), not the @elizaos/ui module in isolation, under real jsdom
 * DOM/URL/storage:
 *
 *  - the replay arms from the boot path and reports fresh WITHOUT any
 *    destructive call or durable-storage write,
 *  - the arm-before-durable-patch ORDER holds (installForceFreshFirstRunClientPatch
 *    is first-install-wins, so reordering silently breaks the replay),
 *  - the `?reset` escape hatch keeps its existing semantics,
 *  - prod builds and non-main window shells stay inert,
 *  - and a static guard fails if main.tsx stops calling the wiring at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FirstRunClientLike } from "@elizaos/ui/platform/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMainWindowFirstRunBootPatches } from "../src/first-run-boot-patches";

const DURABLE_FORCE_FRESH_KEY = "elizaos:first-run:force-fresh";
const ACTIVE_SERVER_KEY = "elizaos:active-server";
const SETUP_STEP_KEY = "eliza:setup:step";
const FIRST_RUN_COMPLETE_KEY = "eliza:first-run-complete";
const REPLAY_SESSION_KEY = "elizaos:onboarding-replay:active";
const MAIN_ROUTE = { mode: "main" } as const;

/**
 * A recording client at the transport boundary: real onboarded-agent answers,
 * plus destructive-method spies that must never fire on the replay path.
 */
function makeOnboardedClient() {
  const originalGetConfig = vi.fn(async () => ({
    agentName: "Real Agent",
    meta: { firstRunComplete: true },
  }));
  const originalGetFirstRunStatus = vi.fn(async () => ({ complete: true }));
  const originalSubmitFirstRun = vi.fn(async () => ({ ok: true }));
  const deleteAgent = vi.fn(async () => ({ ok: true }));
  const resetAgent = vi.fn(async () => ({ ok: true }));
  const clearMemories = vi.fn(async () => ({ ok: true }));

  const client = {
    getConfig: originalGetConfig,
    getFirstRunStatus: originalGetFirstRunStatus,
    submitFirstRun: originalSubmitFirstRun,
    deleteAgent,
    resetAgent,
    clearMemories,
  } as unknown as FirstRunClientLike & {
    deleteAgent: typeof deleteAgent;
    resetAgent: typeof resetAgent;
    clearMemories: typeof clearMemories;
  };

  return {
    client,
    originalGetConfig,
    originalGetFirstRunStatus,
    originalSubmitFirstRun,
    deleteAgent,
    resetAgent,
    clearMemories,
  };
}

function setBootUrl(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
}

describe("installMainWindowFirstRunBootPatches (#14382 boot wiring)", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
    window.localStorage.clear();
    window.sessionStorage.clear();
    setBootUrl("");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    setBootUrl("");
  });

  it("arms the replay from the boot path with ?onboarding-replay=1 (dev) without destroying anything", async () => {
    setBootUrl("?onboarding-replay=1");
    window.localStorage.setItem(ACTIVE_SERVER_KEY, "http://127.0.0.1:31337");
    const spies = makeOnboardedClient();

    const handle = installMainWindowFirstRunBootPatches(
      spies.client,
      MAIN_ROUTE,
    );

    expect(handle.active).toBe(true);
    // The overlay makes the fully-onboarded client REPORT fresh...
    expect((await spies.client.getFirstRunStatus()).complete).toBe(false);
    expect(await spies.client.getConfig()).toEqual({});
    // ...while nothing destructive fires and no real state is touched.
    expect(spies.deleteAgent).not.toHaveBeenCalled();
    expect(spies.resetAgent).not.toHaveBeenCalled();
    expect(spies.clearMemories).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ACTIVE_SERVER_KEY)).toBe(
      "http://127.0.0.1:31337",
    );
    expect(window.localStorage.getItem(DURABLE_FORCE_FRESH_KEY)).toBeNull();
    // The session badge marks the replay for any UI that wants to show it.
    expect(window.sessionStorage.getItem(REPLAY_SESSION_KEY)).toBe("1");

    handle.uninstall();
    // Uninstalling restores the real client verbatim — agent intact.
    expect((await spies.client.getFirstRunStatus()).complete).toBe(true);
    expect(await spies.client.getConfig()).toMatchObject({
      agentName: "Real Agent",
    });
  });

  it("replay freshness comes from the replay overlay, NOT the durable localStorage flag (ordering regression)", async () => {
    // installForceFreshFirstRunClientPatch is first-install-wins. If the boot
    // wiring ever reorders armOnboardingReplay AFTER the durable patch install,
    // the durable patch owns the client and reads the (unset) durable
    // localStorage flag — so the replay would report complete:true and this
    // assertion fails. That exact misordering is the silent-breakage mode this
    // test exists to catch.
    setBootUrl("?onboarding-replay=1");
    const spies = makeOnboardedClient();

    installMainWindowFirstRunBootPatches(spies.client, MAIN_ROUTE);

    expect(window.localStorage.getItem(DURABLE_FORCE_FRESH_KEY)).toBeNull();
    expect((await spies.client.getFirstRunStatus()).complete).toBe(false);
  });

  it("keeps the ?reset escape hatch semantics (clears local session state, sets durable flag, strips the param)", async () => {
    setBootUrl("?reset");
    window.localStorage.setItem(ACTIVE_SERVER_KEY, "http://127.0.0.1:31337");
    window.localStorage.setItem(SETUP_STEP_KEY, "provider");
    window.localStorage.setItem(FIRST_RUN_COMPLETE_KEY, "1");
    const spies = makeOnboardedClient();

    const handle = installMainWindowFirstRunBootPatches(
      spies.client,
      MAIN_ROUTE,
    );

    // ?reset alone does not arm a replay — it is the separate, stateful path.
    expect(handle.active).toBe(false);
    expect(window.localStorage.getItem(ACTIVE_SERVER_KEY)).toBeNull();
    expect(window.localStorage.getItem(SETUP_STEP_KEY)).toBeNull();
    expect(window.localStorage.getItem(FIRST_RUN_COMPLETE_KEY)).toBeNull();
    expect(window.localStorage.getItem(DURABLE_FORCE_FRESH_KEY)).toBe("1");
    expect(new URLSearchParams(window.location.search).has("reset")).toBe(
      false,
    );
    // The durable patch reads the flag and reports fresh.
    expect((await spies.client.getFirstRunStatus()).complete).toBe(false);
  });

  it("passes through untouched when no query param is set", async () => {
    const spies = makeOnboardedClient();

    const handle = installMainWindowFirstRunBootPatches(
      spies.client,
      MAIN_ROUTE,
    );

    expect(handle.active).toBe(false);
    expect((await spies.client.getFirstRunStatus()).complete).toBe(true);
    expect(await spies.client.getConfig()).toMatchObject({
      agentName: "Real Agent",
    });
    expect(window.localStorage.getItem(DURABLE_FORCE_FRESH_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(REPLAY_SESSION_KEY)).toBeNull();
  });

  it("is inert in a prod build even with ?onboarding-replay=1", async () => {
    vi.stubEnv("DEV", false);
    setBootUrl("?onboarding-replay=1");
    const spies = makeOnboardedClient();

    const handle = installMainWindowFirstRunBootPatches(
      spies.client,
      MAIN_ROUTE,
    );

    expect(handle.active).toBe(false);
    expect((await spies.client.getFirstRunStatus()).complete).toBe(true);
    expect(window.sessionStorage.getItem(REPLAY_SESSION_KEY)).toBeNull();
  });

  it("installs nothing for non-main window shells", () => {
    setBootUrl("?onboarding-replay=1");
    const spies = makeOnboardedClient();

    const handle = installMainWindowFirstRunBootPatches(spies.client, {
      mode: "chat-overlay",
    });

    expect(handle.active).toBe(false);
    // Method identity unchanged — no patch was installed at all.
    expect(spies.client.getFirstRunStatus).toBe(
      spies.originalGetFirstRunStatus,
    );
    expect(spies.client.getConfig).toBe(spies.originalGetConfig);
  });
});

describe("main.tsx boot wiring (static guard)", () => {
  it("calls installMainWindowFirstRunBootPatches on the boot path", () => {
    const mainSrc = readFileSync(
      join(import.meta.dirname, "..", "src", "main.tsx"),
      "utf8",
    );
    // If the wiring call is removed from main.tsx, ?onboarding-replay=1 and
    // ?reset both silently die (the #14444 dead-code regression). Fail here.
    expect(mainSrc).toContain('from "./first-run-boot-patches"');
    expect(mainSrc).toContain(
      "installMainWindowFirstRunBootPatches(client, windowShellRoute)",
    );
  });
});
