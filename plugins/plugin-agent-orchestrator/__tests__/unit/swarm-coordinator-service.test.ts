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
} from "../../src/services/swarm-coordinator-service.ts";

/** Minimal AcpService stub: captures the onSessionEvent handler so the test
 *  can drive synthetic session events through the coordinator. */
function makeAcpStub(session?: Record<string, unknown>) {
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;
  return {
    onSessionEvent: vi.fn(
      (h: (sessionId: string, event: string, data: unknown) => void) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
    ),
    getSession: vi.fn(async () => session),
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

  beforeEach(() => {
    vi.clearAllMocks();
  });
});
