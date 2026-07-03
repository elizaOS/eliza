/**
 * Regression guard for the SWARM_COORDINATOR service-wiring fix.
 *
 * The plugin-acpx -> plugin-agent-orchestrator consolidation deleted the
 * service that registered SWARM_COORDINATOR, but three consumers still discover
 * it via runtime.getService("SWARM_COORDINATOR") and expect a `subscribe()` +
 * the chat / ws / agent-decision / swarm-complete setter surface:
 *   - packages/agent/src/api/coordinator-wiring.ts (wireCoordinatorBridgesWhenReady)
 *   - packages/agent/src/api/server-helpers-swarm.ts (getCoordinatorFromRuntime)
 *   - plugins/plugin-app-control/src/services/verification-room-bridge.ts (subscribe)
 *
 * These tests pin: the service is discoverable by its serviceType, exposes a
 * working subscribe(), relays AcpService session events to subscribers and the
 * ws-broadcast callback, exposes every setter the bridges call, and fires the
 * swarm-complete callback on terminal session events.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../../src/services/acp-service.ts";
import {
  SWARM_COORDINATOR_SERVICE_TYPE,
  SwarmCoordinatorService,
  type SwarmEvent,
  sessionHasRouterOrigin,
} from "../../src/services/swarm-coordinator-service.ts";

/** Minimal AcpService stub: captures the onSessionEvent handler so the test
 *  can drive synthetic session events through the coordinator. */
function makeAcpStub(session?: Record<string, unknown>) {
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;
  let currentSession = session;
  return {
    onSessionEvent: vi.fn(
      (h: (sessionId: string, event: string, data: unknown) => void) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
    ),
    getSession: vi.fn(async () => currentSession),
    setSession(nextSession?: Record<string, unknown>) {
      currentSession = nextSession;
    },
    emit(sessionId: string, event: string, data: unknown) {
      handler?.(sessionId, event, data);
    },
    get hasHandler() {
      return handler !== null;
    },
  };
}

function makeRuntime(services: Record<string, unknown>): IAgentRuntime {
  return {
    getService: vi.fn((key: string) => services[key] ?? null),
  } as unknown as IAgentRuntime;
}

/** The sub-agent-router serviceType the coordinator looks up to decide whether
 *  the router is live enough to own an origin session's completion. */
const SUB_AGENT_ROUTER_SERVICE_TYPE = "ACPX_SUB_AGENT_ROUTER";

/** Minimal SubAgentRouter stub exposing only the `isActive()` accessor the
 *  coordinator duck-types. `active: false` mimics a disabled / unbound router. */
function makeRouterStub(active: boolean) {
  return { isActive: vi.fn(() => active) };
}

describe("SwarmCoordinatorService", () => {
  it("registers under the SWARM_COORDINATOR serviceType", () => {
    expect(SwarmCoordinatorService.serviceType).toBe("SWARM_COORDINATOR");
    expect(SWARM_COORDINATOR_SERVICE_TYPE).toBe("SWARM_COORDINATOR");
  });

  it("is discoverable via runtime.getService and exposes subscribe()", async () => {
    const acp = makeAcpStub();
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });

    const coordinator = await SwarmCoordinatorService.start(runtime);
    // Register it the way the runtime services map would.
    const services = { [SWARM_COORDINATOR_SERVICE_TYPE]: coordinator };
    const lookupRuntime = makeRuntime(services);

    const found = lookupRuntime.getService(SWARM_COORDINATOR_SERVICE_TYPE);
    expect(found).toBe(coordinator);
    expect(typeof (found as SwarmCoordinatorService).subscribe).toBe(
      "function",
    );
    await coordinator.stop();
  });

  it("subscribes to the ACP session-event stream on start", async () => {
    const acp = makeAcpStub();
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);
    expect(acp.onSessionEvent).toHaveBeenCalledTimes(1);
    expect(acp.hasHandler).toBe(true);
    await coordinator.stop();
  });

  it("relays AcpService events to subscribers as SwarmEvents", async () => {
    const acp = makeAcpStub();
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const received: SwarmEvent[] = [];
    const unsub = coordinator.subscribe((e) => received.push(e));

    acp.emit("sess-1", "tool_running", { toolCall: { title: "Bash" } });
    // event loop flush (handler invokes async path)
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "tool_running",
      sessionId: "sess-1",
    });
    expect(typeof received[0].timestamp).toBe("number");

    unsub();
    acp.emit("sess-1", "ready", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1); // unsubscribed: no further delivery
    await coordinator.stop();
  });

  it("relays events to the ws-broadcast callback", async () => {
    const acp = makeAcpStub();
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const broadcasts: SwarmEvent[] = [];
    coordinator.setWsBroadcast((e) => broadcasts.push(e));

    acp.emit("sess-2", "message", { text: "working" });
    await new Promise((r) => setTimeout(r, 0));

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: "message",
      sessionId: "sess-2",
    });
    await coordinator.stop();
  });

  it("exposes every setter the server bridges call", async () => {
    const acp = makeAcpStub();
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    expect(typeof coordinator.setChatCallback).toBe("function");
    expect(typeof coordinator.setWsBroadcast).toBe("function");
    expect(typeof coordinator.setAgentDecisionCallback).toBe("function");
    expect(typeof coordinator.setSwarmCompleteCallback).toBe("function");
    expect(typeof coordinator.getTaskThread).toBe("function");
    expect("sourceRoomId" in coordinator).toBe(true);
    await coordinator.stop();
  });

  it("makes the server's wireCodingAgent*Bridge helpers return true", async () => {
    // Inline the discovery + wiring logic the server helpers use, against the
    // real coordinator, to prove the wiring succeeds (the bridges return true
    // iff the matching setter is present on the discovered coordinator).
    const acp = makeAcpStub();
    const coordinator = await SwarmCoordinatorService.start(
      makeRuntime({ [AcpService.serviceType]: acp }),
    );

    const wireChat = Boolean(
      (coordinator as { setChatCallback?: unknown }).setChatCallback,
    );
    const wireWs = Boolean(
      (coordinator as { setWsBroadcast?: unknown }).setWsBroadcast,
    );
    const wireEventRouting = Boolean(
      (coordinator as { setAgentDecisionCallback?: unknown })
        .setAgentDecisionCallback,
    );
    const wireSynthesis = Boolean(
      (coordinator as { setSwarmCompleteCallback?: unknown })
        .setSwarmCompleteCallback,
    );

    expect(wireChat).toBe(true);
    expect(wireWs).toBe(true);
    expect(wireEventRouting).toBe(true);
    expect(wireSynthesis).toBe(true);
    await coordinator.stop();
  });

  it("runs app-verification validators before notifying subscribers", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        initialTask: "build the landing page",
        roomId: "task-room-7",
        originRoomId: "origin-room-7",
        originConnectorMessageId: "discord-msg-7",
        validator: {
          service: "app-verification",
          method: "verifyApp",
          params: { appName: "demo-app", profile: "full" },
        },
      },
    });
    const verification = {
      verifyApp: vi.fn(async () => ({ verdict: "pass", checks: [] })),
    };
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      "app-verification": verification,
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const received: SwarmEvent[] = [];
    coordinator.subscribe((event) => received.push(event));

    acp.emit("sess-3", "task_complete", { response: "deployed" });
    await new Promise((r) => setTimeout(r, 0));

    expect(verification.verifyApp).toHaveBeenCalledWith({
      appName: "demo-app",
      profile: "full",
      workdir: "/tmp/wd",
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "task_complete",
      sessionId: "sess-3",
      data: {
        originRoomId: "origin-room-7",
        label: "build-site",
        workdir: "/tmp/wd",
        verification: {
          source: "custom-validator",
          validator: { service: "app-verification", method: "verifyApp" },
          params: { appName: "demo-app", profile: "full", workdir: "/tmp/wd" },
          verdict: "pass",
        },
      },
    });
    expect(coordinator.tasks.get("sess-3")).toMatchObject({
      sessionId: "sess-3",
      status: "completed",
      label: "build-site",
      workdir: "/tmp/wd",
    });
    await coordinator.stop();
  });

  it("fires swarm-complete synthesis after app-verification passes", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        initialTask: "build the landing page",
        originRoomId: "origin-room-7",
        originConnectorMessageId: "discord-msg-7",
        validator: {
          service: "app-verification",
          method: "verifyApp",
          params: { appName: "demo-app" },
        },
      },
    });
    const verification = {
      verifyApp: vi.fn(async () => ({ verdict: "pass", checks: [] })),
    };
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      "app-verification": verification,
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-validated", "task_complete", { response: "deployed" });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0]).toMatchObject({
      total: 1,
      completed: 1,
      tasks: [
        {
          sessionId: "sess-validated",
          label: "build-site",
          status: "completed",
          completionSummary: "deployed",
          roomId: "origin-room-7",
          replyToExternalMessageId: "discord-msg-7",
        },
      ],
    });
    await coordinator.stop();
  });

  it("emits a custom-validator escalation when app-verification is unavailable", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        validator: {
          service: "app-verification",
          method: "verifyApp",
          params: { appName: "demo-app" },
        },
      },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const received: SwarmEvent[] = [];
    coordinator.subscribe((event) => received.push(event));

    acp.emit("sess-missing-verifier", "task_complete", {});
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "escalation",
      sessionId: "sess-missing-verifier",
      data: {
        summary: "App verification service unavailable.",
        verification: {
          source: "custom-validator",
          validator: { service: "app-verification", method: "verifyApp" },
          params: { appName: "demo-app" },
          verdict: "fail",
        },
      },
    });
    expect(coordinator.tasks.get("sess-missing-verifier")).toMatchObject({
      sessionId: "sess-missing-verifier",
      status: "escalation",
      label: "build-site",
    });
    await coordinator.stop();
  });

  it("invokes the agent-decision callback for blocking events", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "fix-login",
        initialTask: "fix auth",
        roomId: "room-9",
      },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const decisionCb = vi.fn(async () => ({ action: "ignore" }));
    coordinator.setAgentDecisionCallback(decisionCb);

    acp.emit("sess-blocked", "blocked", { message: "needs input" });
    await new Promise((r) => setTimeout(r, 0));

    expect(decisionCb).toHaveBeenCalledTimes(1);
    expect(decisionCb.mock.calls[0][0]).toContain("fix-login");
    expect(decisionCb.mock.calls[0][1]).toBe("sess-blocked");
    expect(decisionCb.mock.calls[0][2]).toMatchObject({
      sessionId: "sess-blocked",
      agentType: "codex",
      label: "fix-login",
      originalTask: "fix auth",
      workdir: "/tmp/wd",
      status: "blocked",
    });
    await coordinator.stop();
  });

  it("does not fire swarm-complete for non-terminal events", async () => {
    const acp = makeAcpStub({ metadata: {} });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-4", "tool_running", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("maintains the legacy tasks map for Discord timeout suppression", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        initialTask: "build the landing page",
        originConnectorMessageId: "discord-msg-11",
        roomId: "task-room-11",
      },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    acp.emit("sess-live", "tool_running", {});
    await new Promise((r) => setTimeout(r, 0));

    expect(coordinator.tasks).toBeInstanceOf(Map);
    expect(coordinator.tasks.get("sess-live")).toMatchObject({
      sessionId: "sess-live",
      label: "build-site",
      status: "tool_running",
      agentType: "codex",
      originalTask: "build the landing page",
      workdir: "/tmp/wd",
      originMetadata: {
        messageId: "discord-msg-11",
        roomId: "task-room-11",
        replyToExternalMessageId: "discord-msg-11",
      },
    });
    await coordinator.stop();
  });

  it("fires swarm-complete synthesis for terminal task_complete events", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        initialTask: "build the landing page",
        originRoomId: "origin-room-11",
        originConnectorMessageId: "discord-msg-11",
      },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-done", "task_complete", { response: "deployed" });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0]).toMatchObject({
      total: 1,
      completed: 1,
      stopped: 0,
      errored: 0,
      tasks: [
        {
          sessionId: "sess-done",
          label: "build-site",
          agentType: "codex",
          originalTask: "build the landing page",
          status: "completed",
          completionSummary: "deployed",
          workdir: "/tmp/wd",
          roomId: "origin-room-11",
          replyToExternalMessageId: "discord-msg-11",
        },
      ],
    });
    await coordinator.stop();
  });

  it("sanitizes captured tool-output envelopes out of completionSummary (#11578)", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: { label: "leaky-task", originRoomId: "origin-room-leak" },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    // The ACP turn finalText carries the orchestrator's own captured
    // `[tool output: …]` envelope blocks; they must NOT reach the payload.
    const leakyResponse =
      "Deployed the site.\n" +
      "[tool output: bash]\n$ npm run build\n… lots of raw log …\n[/tool output]\n" +
      "Live at https://example.com/app/";
    acp.emit("sess-leak", "task_complete", { response: leakyResponse });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    const summary = fired.mock.calls[0][0].tasks[0].completionSummary;
    expect(summary).toContain("Deployed the site.");
    expect(summary).toContain("https://example.com/app/");
    expect(summary).not.toContain("[tool output:");
    expect(summary).not.toContain("[/tool output]");
    expect(summary).not.toContain("npm run build");
    await coordinator.stop();
  });

  it("falls back to the default summary when the response was ONLY tool output (#11578)", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: { label: "dump-only", originRoomId: "origin-room-dump" },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-dump", "task_complete", {
      response: "[tool output: bash]\nonly a raw dump\n[/tool output]",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0].tasks[0].completionSummary).toBe(
      "Task completed.",
    );
    await coordinator.stop();
  });

  it("caches session metadata per session so streaming events do not re-hit getSession", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: { label: "build-site", originRoomId: "origin-room-20" },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const received: SwarmEvent[] = [];
    coordinator.subscribe((e) => received.push(e));

    // First enrichable event populates the cache with exactly one lookup.
    acp.emit("sess-cache", "tool_running", { toolCall: { title: "Bash" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(acp.getSession).toHaveBeenCalledTimes(1);

    // Later enrichable events reuse the cache: no further getSession calls.
    acp.emit("sess-cache", "tool_running", { toolCall: { title: "Read" } });
    acp.emit("sess-cache", "usage_update", { tokens: 10 });
    await new Promise((r) => setTimeout(r, 0));
    expect(acp.getSession).toHaveBeenCalledTimes(1);

    // Cached metadata still enriches later events.
    expect(received.at(-1)?.data).toMatchObject({
      originRoomId: "origin-room-20",
      label: "build-site",
      workdir: "/tmp/wd",
      agentType: "codex",
    });
    await coordinator.stop();
  });

  it("does not cache a session miss (event racing session persistence)", async () => {
    const acp = makeAcpStub(undefined);
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const received: SwarmEvent[] = [];
    coordinator.subscribe((e) => received.push(e));

    // Event arrives before the session is persisted: no metadata available.
    acp.emit("sess-race", "tool_running", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(received.at(-1)?.data).not.toHaveProperty("label");

    // Session shows up. The next event must retry the lookup (miss not pinned).
    acp.setSession({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: { label: "late-session", originRoomId: "origin-room-30" },
    });
    acp.emit("sess-race", "tool_running", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(received.at(-1)?.data).toMatchObject({
      label: "late-session",
      originRoomId: "origin-room-30",
      workdir: "/tmp/wd",
    });
    await coordinator.stop();
  });

  it("skips getSession enrichment for high-frequency streaming events", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      metadata: { label: "build-site" },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const received: SwarmEvent[] = [];
    coordinator.subscribe((e) => received.push(e));

    acp.emit("sess-stream", "message", { text: "chunk 1" });
    acp.emit("sess-stream", "reasoning", { text: "thinking" });
    acp.emit("sess-stream", "plan", { entries: [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(acp.getSession).not.toHaveBeenCalled();
    expect(received).toHaveLength(3);
    // Raw payloads pass through untouched.
    expect(received[0].data).toEqual({ text: "chunk 1" });
    await coordinator.stop();
  });

  it("evicts legacy task state after the post-terminal grace window", async () => {
    vi.useFakeTimers();
    try {
      const acp = makeAcpStub({
        agentType: "codex",
        workdir: "/tmp/wd",
        metadata: { label: "build-site", initialTask: "build it" },
      });
      const runtime = makeRuntime({ [AcpService.serviceType]: acp });
      const coordinator = await SwarmCoordinatorService.start(runtime);

      acp.emit("sess-evict", "tool_running", {});
      await vi.advanceTimersByTimeAsync(0);
      expect(coordinator.tasks.has("sess-evict")).toBe(true);

      acp.emit("sess-evict", "task_complete", { response: "done" });
      await vi.advanceTimersByTimeAsync(0);
      // Terminal context stays visible through the grace window so Discord
      // timeout suppression + synthesis consumers can still read it.
      expect(coordinator.tasks.get("sess-evict")).toMatchObject({
        status: "completed",
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(coordinator.tasks.has("sess-evict")).toBe(false);
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the pending eviction and refreshes metadata when the session resumes within the grace window", async () => {
    vi.useFakeTimers();
    try {
      const acp = makeAcpStub({
        agentType: "codex",
        workdir: "/tmp/wd",
        metadata: { label: "build-site", initialTask: "build it" },
      });
      const runtime = makeRuntime({ [AcpService.serviceType]: acp });
      const coordinator = await SwarmCoordinatorService.start(runtime);

      const received: SwarmEvent[] = [];
      coordinator.subscribe((e) => received.push(e));

      // Turn 1 completes and schedules the 60s eviction. task_complete fires at
      // the end of every prompt turn; it is NOT the end of the session.
      acp.emit("sess-resume", "task_complete", { response: "turn 1 done" });
      await vi.advanceTimersByTimeAsync(0);
      expect(coordinator.tasks.has("sess-resume")).toBe(true);
      expect(received.at(-1)?.data).toMatchObject({ label: "build-site" });
      expect(acp.getSession).toHaveBeenCalledTimes(1);

      // A follow-up turn reuses the same session WITHIN the grace window. Its
      // persisted metadata may have changed since the first turn, so canceling
      // the eviction must also drop the old enrichment snapshot.
      acp.setSession({
        agentType: "codex",
        workdir: "/tmp/wd",
        metadata: { label: "build-site-turn-2", initialTask: "build it again" },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      acp.emit("sess-resume", "tool_running", { toolCall: { title: "Bash" } });
      await vi.advanceTimersByTimeAsync(0);

      expect(received.at(-1)?.data).toMatchObject({
        label: "build-site-turn-2",
        initialTask: "build it again",
      });
      expect(acp.getSession).toHaveBeenCalledTimes(2);

      // Past the original 60s deadline the live task state must survive. Without
      // the cancel it is evicted mid-turn, blinding Discord suppression + routing.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(coordinator.tasks.has("sess-resume")).toBe(true);
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("eviction does not fire a duplicate swarm-complete for the session", async () => {
    vi.useFakeTimers();
    try {
      const acp = makeAcpStub({
        agentType: "codex",
        metadata: { label: "build-site" },
      });
      const runtime = makeRuntime({ [AcpService.serviceType]: acp });
      const coordinator = await SwarmCoordinatorService.start(runtime);

      const fired = vi.fn(async () => {});
      coordinator.setSwarmCompleteCallback(fired);

      acp.emit("sess-dup", "task_complete", { response: "done" });
      await vi.advanceTimersByTimeAsync(0);
      expect(fired).toHaveBeenCalledTimes(1);

      // After eviction clears synthesizedCompletionSessions, a straggler
      // duplicate terminal event may synthesize again (state was released),
      // but the eviction itself must not fire anything.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fired).toHaveBeenCalledTimes(1);
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries ACP binding when ACP is not yet registered, then binds", async () => {
    vi.useFakeTimers();
    try {
      const acp = makeAcpStub();
      // Start with NO acp service registered.
      const services: Record<string, unknown> = {};
      const runtime = makeRuntime(services);
      const coordinator = await SwarmCoordinatorService.start(runtime);

      // No handler yet — ACP absent.
      expect(acp.onSessionEvent).not.toHaveBeenCalled();

      // ACP comes online; the retry timer should pick it up.
      services[AcpService.serviceType] = acp;
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      expect(acp.onSessionEvent).toHaveBeenCalledTimes(1);
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Ownership rule (#11634): the sub-agent-router owns the completion→chat post
  // for origin-routed sessions. Swarm synthesis must NOT double-post those.
  // A router-routed session stamps a valid UUID roomId + taskRoomId + source.
  const ROUTER_ROOM_ID = "11111111-1111-4111-8111-111111111111";
  const ROUTER_TASK_ROOM_ID = "22222222-2222-4222-8222-222222222222";

  it("does NOT fire swarm-complete for a router-origin session when the router is active (task_complete)", async () => {
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        initialTask: "build the landing page",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
        originConnectorMessageId: "discord-msg-11",
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-router", "task_complete", { response: "deployed" });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("STILL fires swarm-complete for a router-origin session when the router is DISABLED/unbound", async () => {
    // ACPX_SUB_AGENT_ROUTER_DISABLED (or router failed to bind): the router
    // will not post, so synthesis must remain the completion poster or the
    // terminal completion goes silent.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(false),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-router-off", "task_complete", { response: "deployed" });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });

  it("STILL fires when router room UUIDs are ONLY in the event data, not session metadata", async () => {
    // readOrigin(session) reads session.metadata only. If the UUIDs live solely
    // in the terminal event payload, the router returns "no origin" and posts
    // nothing — so synthesis must remain the poster (no silent drop).
    const acp = makeAcpStub({
      agentType: "codex",
      metadata: { label: "payload-only" }, // NO room UUIDs in session metadata
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    // UUIDs present in the EVENT data only.
    acp.emit("sess-payload-only", "task_complete", {
      response: "deployed",
      originRoomId: ROUTER_ROOM_ID,
      taskRoomId: ROUTER_TASK_ROOM_ID,
      source: "discord",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });

  it("a router-owned task_complete does NOT consume the session's synthesis slot (later stopped still fires)", async () => {
    // ACP sessions are reused across turns. A router-owned task_complete is
    // skipped here, but must NOT mark the session synthesized — otherwise a
    // later `stopped` (which the router never posts) would be swallowed by the
    // dedupe guard and go silent.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    // Turn 1: router-owned completion — skipped, slot NOT consumed.
    acp.emit("sess-reuse", "task_complete", { response: "deployed" });
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).not.toHaveBeenCalled();

    // Turn 2: same session stops — router does not post this, so synthesis must.
    acp.emit("sess-reuse", "stopped", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0]).toMatchObject({
      stopped: 1,
      tasks: [{ sessionId: "sess-reuse", status: "stopped" }],
    });
    await coordinator.stop();
  });

  it("STILL fires swarm-complete for a router-origin `stopped` event even when the router is active", async () => {
    // The router injects task_complete / error but NOT stopped, so synthesis
    // remains the only poster for a stop/cancel/no-output terminal event.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-router-stopped", "stopped", {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0]).toMatchObject({
      total: 1,
      stopped: 1,
      tasks: [{ sessionId: "sess-router-stopped", status: "stopped" }],
    });
    await coordinator.stop();
  });

  it("does NOT synthesize a `stopped` for a session handed off to a successor (#11711)", async () => {
    // The router's verify-retry / state-lost-respawn / account-failover paths
    // re-dispatch a fresh session and tear down the old one — its teardown
    // `stopped` is plumbing, not a user-facing terminal. The router stamps
    // `handedOffToSuccessorSessionId` on the old session before teardown, so
    // synthesis must skip it: the successor session posts the real completion.
    // Without this, one task yielded one post per lineage generation (3 for a
    // 2-retry lineage).
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
        handedOffToSuccessorSessionId: "sess-retry-2",
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-handed-off", "stopped", {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("STILL synthesizes a genuine user `stopped` (no handoff marker) — the #11689 invariant", async () => {
    // A real cancel / no-output stop carries NO handoff marker, so it must NOT
    // be swallowed by the #11711 skip — synthesis stays its only poster.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-user-stop", "stopped", {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0]).toMatchObject({
      total: 1,
      stopped: 1,
      tasks: [{ sessionId: "sess-user-stop", status: "stopped" }],
    });
    await coordinator.stop();
  });

  it("re-reads the store for a `stopped` when the cached snapshot pre-dates the handoff stamp (#11711 residual)", async () => {
    // Cache-staleness race: the earlier same-session `task_complete` (the one
    // that triggered the verify-retry) warms the enrichment cache from the
    // store BEFORE the router stamps `handedOffToSuccessorSessionId`. So the
    // snapshot the following `stopped` reads from the cache lacks the marker.
    // Without a fresh re-read, the teardown-stop is mistaken for a user stop
    // and synthesized — the exact residual left after #11720. The `stopped`
    // must re-read the store once, see the freshly-stamped marker, and skip.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
        // Pre-stamp snapshot: NO handoff marker yet.
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    // Warm the cache with the pre-stamp snapshot (mirrors the task_complete that
    // triggered the retry populating the enrichment cache from the store).
    acp.emit("sess-stale", "task_complete", { response: "turn done" });
    await new Promise((r) => setTimeout(r, 0));
    fired.mockClear();

    // The router now stamps the marker on the store AFTER the cache was warmed.
    acp.setSession({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
        handedOffToSuccessorSessionId: "sess-stale-retry-2",
      },
    });

    // The teardown `stopped` reads the STALE cache (no marker) first, then
    // re-reads the store and finds the stamp — so it must NOT synthesize.
    acp.emit("sess-stale", "stopped", {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("a fresh-re-read miss on a `stopped` fails open and still synthesizes (#11711 residual)", async () => {
    // Fail-open guard: if the store re-read returns no session (miss/error),
    // `getFreshSessionMetadata` yields `{}` — an unknown session must be treated
    // as "not superseded" so a genuine user stop is never silenced.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    // Warm the cache, then drop the session from the store so the re-read misses.
    acp.emit("sess-openmiss", "task_complete", { response: "turn done" });
    await new Promise((r) => setTimeout(r, 0));
    fired.mockClear();
    acp.setSession(undefined);

    acp.emit("sess-openmiss", "stopped", {});
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0]).toMatchObject({
      total: 1,
      stopped: 1,
      tasks: [{ sessionId: "sess-openmiss", status: "stopped" }],
    });
    await coordinator.stop();
  });

  it("STILL fires swarm-complete for a custom-validator task_complete on a router-origin active session", async () => {
    // The app-verification / custom-validator result is synthesized by the
    // coordinator (dispatchCustomValidatorResult); the router never receives or
    // posts it, so synthesis must remain its poster even on a router-owned
    // active session, or the validated verdict would vanish.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    // A validated completion carries the custom-validator marker.
    acp.emit("sess-validated", "task_complete", {
      summary: "App verification passed.",
      response: "App verification passed.",
      verification: {
        source: "custom-validator",
        validator: { service: "app-verification", method: "verifyApp" },
        verdict: "pass",
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0]).toMatchObject({
      total: 1,
      completed: 1,
      tasks: [{ sessionId: "sess-validated", status: "completed" }],
    });
    await coordinator.stop();
  });

  it("STILL fires swarm-complete for a router-origin session when NO router service is registered", async () => {
    // Fail-safe: missing router service is treated as "router not active".
    const acp = makeAcpStub({
      agentType: "codex",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
      },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-no-router", "task_complete", { response: "deployed" });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });

  it("does NOT fire swarm-complete for a router-origin session on suppressed state-lost error (source optional)", async () => {
    // No `source` here on purpose: readOrigin still owns this session, so the
    // suppressed-error leak must be prevented even for connector-less origins.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    // The router deliberately suppresses this (it respawns the session under
    // cap); synthesis must not leak the "state was lost" scare to the channel.
    acp.emit("sess-router-err", "error", {
      failureKind: "session_state_lost",
      message: "Sub-agent state was lost (process exited without persisting).",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("STILL fires swarm-complete for a session with NO router origin (task_complete)", async () => {
    // Dashboard / API-spawned swarm task: no router origin metadata
    // (non-UUID room, no source). Synthesis remains the completion poster —
    // this is the gap synthesis exists to cover.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "dashboard-task",
        initialTask: "nightly report",
        originRoomId: "origin-room-11",
      },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-dashboard", "task_complete", { response: "deployed" });
    await new Promise((r) => setTimeout(r, 0));

    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0]).toMatchObject({
      total: 1,
      completed: 1,
      tasks: [{ sessionId: "sess-dashboard", status: "completed" }],
    });
    await coordinator.stop();
  });

  // A microtask/macrotask flush deep enough to drain the per-session terminal
  // completion chain (each event is 2+ awaits deep: chain .then + metadata
  // await + eviction scheduling).
  const flushChains = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("fires swarm-complete ONCE when two terminal events for the same non-router session race the metadata await", async () => {
    // Regression (codex review, #11634): AcpService invokes listeners
    // synchronously without awaiting them, so two terminal events emitted
    // back-to-back for one session (e.g. error then stopped on a single exit)
    // both enter the handler and suspend on the getEnrichmentMetadata await.
    // Per-session serialization makes the second observe the first's completed
    // dedupe decision, so the completion callback fires exactly ONCE.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: { label: "dashboard-race", initialTask: "nightly report" },
    });
    const runtime = makeRuntime({ [AcpService.serviceType]: acp });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    acp.emit("sess-race-dedupe", "error", { message: "boom" });
    acp.emit("sess-race-dedupe", "stopped", {});
    await flushChains();

    expect(fired).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });

  it("still fires the `stopped` when it races a router-owned terminal on the same session (no swallow)", async () => {
    // Regression (codex review, #11634): a router-owned task_complete/error and
    // a `stopped` emitted back-to-back for one router-origin session. The
    // router owns (and skips synthesis for) the task_complete but NEVER posts
    // `stopped`, so synthesis must still deliver the stop. Per-session
    // serialization guarantees the router-owned skip does not consume the slot
    // AND the `stopped` is not swallowed by a claim/release race.
    const acp = makeAcpStub({
      agentType: "codex",
      workdir: "/tmp/wd",
      metadata: {
        label: "build-site",
        originRoomId: ROUTER_ROOM_ID,
        taskRoomId: ROUTER_TASK_ROOM_ID,
        source: "discord",
      },
    });
    const runtime = makeRuntime({
      [AcpService.serviceType]: acp,
      [SUB_AGENT_ROUTER_SERVICE_TYPE]: makeRouterStub(true),
    });
    const coordinator = await SwarmCoordinatorService.start(runtime);

    const fired = vi.fn(async () => {});
    coordinator.setSwarmCompleteCallback(fired);

    // Router-owned task_complete (skipped) immediately followed by a stopped
    // (must post) — same tick, racing the metadata await.
    acp.emit("sess-race-router", "task_complete", { response: "deployed" });
    acp.emit("sess-race-router", "stopped", {});
    await flushChains();

    expect(fired).toHaveBeenCalledTimes(1);
    expect(fired.mock.calls[0][0]).toMatchObject({
      stopped: 1,
      tasks: [{ sessionId: "sess-race-router", status: "stopped" }],
    });
    await coordinator.stop();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
});

describe("sessionHasRouterOrigin", () => {
  const ROOM = "11111111-1111-4111-8111-111111111111";
  const TASK_ROOM = "22222222-2222-4222-8222-222222222222";

  // The predicate takes ONLY the session metadata — the exact input
  // readOrigin(session) reads (session.metadata). It must NOT consult the
  // terminal event's data record, or it would judge a session router-owned
  // that readOrigin would reject, silently dropping its completion.

  it("is true for a valid UUID roomId + taskRoomId + source (router-owned)", () => {
    expect(
      sessionHasRouterOrigin({
        originRoomId: ROOM,
        taskRoomId: TASK_ROOM,
        source: "discord",
      }),
    ).toBe(true);
  });

  it("derives taskRoomId from roomId when taskRoomId is absent", () => {
    // readOrigin: taskRoomId = taskRoomId ?? roomId; roomId falls back to it.
    expect(sessionHasRouterOrigin({ roomId: ROOM, source: "discord" })).toBe(
      true,
    );
  });

  it("is true when source is missing (source is optional, mirrors readOrigin)", () => {
    // readOrigin returns a non-null origin without a source, so the router owns
    // the session and synthesis must skip it regardless of source presence.
    expect(
      sessionHasRouterOrigin({ originRoomId: ROOM, taskRoomId: TASK_ROOM }),
    ).toBe(true);
  });

  it("is true when originRoomId is non-UUID but taskRoomId is a valid UUID (fallthrough)", () => {
    // Mirrors readOrigin's pickUuid(originRoomId) ?? ... ?? taskRoomId: a
    // present-but-invalid earlier field must NOT short-circuit the fallback.
    expect(
      sessionHasRouterOrigin({
        originRoomId: "dashboard-origin",
        taskRoomId: TASK_ROOM,
        source: "discord",
      }),
    ).toBe(true);
  });

  it("is false when a taskRoomId cannot be derived (no taskRoomId, roomId not a UUID)", () => {
    // roomId can come from originRoomId, but taskRoomId only derives from
    // taskRoomId ?? roomId — with neither a valid UUID, readOrigin returns null.
    expect(
      sessionHasRouterOrigin({
        originRoomId: ROOM,
        roomId: "not-a-uuid",
        source: "discord",
      }),
    ).toBe(false);
  });

  it("is false when the roomId is not a valid UUID", () => {
    expect(
      sessionHasRouterOrigin({
        originRoomId: "origin-room-11",
        source: "discord",
      }),
    ).toBe(false);
  });

  it("is false for empty metadata", () => {
    expect(sessionHasRouterOrigin({})).toBe(false);
  });
});
