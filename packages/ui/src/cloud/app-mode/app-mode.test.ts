/** Verifies the app-mode hostname matrix and the entry-routing decision table (chat floor: any agents → chat-home, none → /join; never a pairing redirect, never a console bounce) through the package's configured test harness (jsdom, no module mocks). */
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  APP_MODE_CREATE_PATH,
  type AppModeAgent,
  decideAppModeRoute,
  isAppModeHostname,
} from "./app-mode";

function agent(
  overrides: Partial<AppModeAgent> & { id: string },
): AppModeAgent {
  return {
    agentName: overrides.id,
    status: "running",
    executionTier: "dedicated-always",
    lastHeartbeatAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isAppModeHostname — hostname matrix", () => {
  const matrix: Array<[string, boolean]> = [
    ["app.elizacloud.ai", true],
    ["app-staging.elizacloud.ai", true],
    ["APP.ELIZACLOUD.AI", true],
    ["elizacloud.ai", false],
    ["www.elizacloud.ai", false],
    ["staging.elizacloud.ai", false],
    ["api.elizacloud.ai", false],
    ["api-staging.elizacloud.ai", false],
    ["abc123def.elizacloud.ai", false],
    ["app.elizacloud.ai.evil.example", false],
    ["localhost", false],
    ["127.0.0.1", false],
  ];

  for (const [hostname, expected] of matrix) {
    it(`${hostname} → ${expected}`, () => {
      expect(isAppModeHostname(hostname, false)).toBe(expected);
    });
  }

  it("dev escape hatch turns app-mode on regardless of hostname", () => {
    expect(isAppModeHostname("localhost", true)).toBe(true);
    expect(isAppModeHostname("elizacloud.ai", false)).toBe(false);
  });

  it("dev escape hatch DOES override the apex — deliberate, pinned decision", () => {
    // VITE_FORCE_APP_MODE short-circuits BEFORE the hostname set on purpose:
    // the flag exists so `vite dev` (localhost) can exercise app-mode entry at
    // all, and a partial override that carved out the apex would make the flag
    // lie about what it forces. The apex is protected at BUILD time instead —
    // packages/app's vite config fails any production-mode build in which
    // VITE_FORCE_APP_MODE or VITE_FORCE_APEX_CONSOLE is set
    // (packages/app/scripts/forced-host-mode-guard.mjs), so the flag can never
    // reach a deployed bundle. If this test surprises you, that guard is the
    // invariant you are looking for.
    expect(isAppModeHostname("elizacloud.ai", true)).toBe(true);
  });
});

describe("decideAppModeRoute — decision table (chat floor)", () => {
  it("no agents at all → the /join deploy-first-agent flow", () => {
    expect(decideAppModeRoute([])).toEqual({
      kind: "create",
      to: APP_MODE_CREATE_PATH,
    });
  });

  it("a running dedicated agent → chat-home, NEVER an entry-time pairing redirect", () => {
    // The cold-start regression pin: `status === "running"` in the DB does not
    // mean the container is serving. The old gate minted a one-time 60s
    // pairing token and full-page-redirected here; a cold container cannot
    // consume the token inside its TTL, so entry dead-ended on the agent's
    // "Sign-in link expired" page. Entry must land in the same-origin chat
    // app; entering the agent web UI is an explicit action elsewhere.
    expect(decideAppModeRoute([agent({ id: "a1" })])).toEqual({
      kind: "chat-home",
    });
  });

  it("several running dedicated agents → still chat-home (no chooser at entry)", () => {
    const route = decideAppModeRoute([
      agent({ id: "a1", lastHeartbeatAt: "2026-08-01T00:00:00.000Z" }),
      agent({ id: "a2", lastHeartbeatAt: "2026-08-05T00:00:00.000Z" }),
    ]);
    expect(route).toEqual({ kind: "chat-home" });
  });

  it("dedicated agents exist but none running → chat-home (the app stays home; never the console)", () => {
    const route = decideAppModeRoute([
      agent({ id: "d1", status: "stopped" }),
      agent({ id: "d2", status: "sleeping" }),
    ]);
    expect(route).toEqual({ kind: "chat-home" });
  });

  it("an errored dedicated agent (failed provision) → chat-home, not a dashboard bounce", () => {
    const route = decideAppModeRoute([agent({ id: "d1", status: "error" })]);
    expect(route).toEqual({ kind: "chat-home" });
  });

  it("provisioning / pending dedicated agents (cold start in progress) → chat-home", () => {
    const route = decideAppModeRoute([
      agent({ id: "d1", status: "provisioning" }),
      agent({ id: "d2", status: "pending" }),
    ]);
    expect(route).toEqual({ kind: "chat-home" });
  });

  it("deletion_pending is not a create-worthy empty org → chat-home", () => {
    const route = decideAppModeRoute([
      agent({ id: "d1", status: "deletion_pending" }),
    ]);
    expect(route).toEqual({ kind: "chat-home" });
  });

  it("shared-tier-only org → chat-home (the same-origin chat app, unchanged)", () => {
    const route = decideAppModeRoute([
      agent({ id: "s1", executionTier: "shared" }),
      agent({ id: "s2", executionTier: "shared", status: "stopped" }),
    ]);
    expect(route).toEqual({ kind: "chat-home" });
  });

  it("mixed shared + dedicated org → chat-home", () => {
    const route = decideAppModeRoute([
      agent({ id: "s1", executionTier: "shared" }),
      agent({ id: "d1" }),
    ]);
    expect(route).toEqual({ kind: "chat-home" });
  });
});
