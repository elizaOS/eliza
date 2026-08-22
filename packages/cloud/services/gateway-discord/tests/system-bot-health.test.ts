/** Verifies public gateway health reports the leader-owned Eliza App system bot truthfully. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GatewayManager } from "../src/gateway-manager";

const originalEnabled = process.env.ELIZA_APP_DISCORD_BOT_ENABLED;
const originalToken = process.env.ELIZA_APP_DISCORD_BOT_TOKEN;

type MutableManagerState = {
  consecutivePollFailures: number;
  lastSuccessfulPoll: Date | null;
  redis: object | null;
  isElizaAppLeader: boolean;
  elizaAppClient: { isReady: () => boolean } | null;
};

function createReadyManager(): GatewayManager {
  const manager = new GatewayManager({
    podName: "system-bot-health-test",
    elizaCloudUrl: "https://api.test",
    gatewayBootstrapSecret: "bootstrap-secret",
    project: "test",
  });
  Object.assign(manager as unknown as MutableManagerState, {
    consecutivePollFailures: 0,
    lastSuccessfulPoll: new Date("2026-08-21T00:00:00.000Z"),
  });
  return manager;
}

function setSystemBotState(
  manager: GatewayManager,
  state: Pick<
    MutableManagerState,
    "redis" | "isElizaAppLeader" | "elizaAppClient"
  >,
): void {
  Object.assign(manager as unknown as MutableManagerState, state);
}

describe("Eliza App system-bot health", () => {
  beforeEach(() => {
    process.env.ELIZA_APP_DISCORD_BOT_ENABLED = "true";
    process.env.ELIZA_APP_DISCORD_BOT_TOKEN = "test-system-bot-token";
  });

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env.ELIZA_APP_DISCORD_BOT_ENABLED;
    } else {
      process.env.ELIZA_APP_DISCORD_BOT_ENABLED = originalEnabled;
    }
    if (originalToken === undefined) {
      delete process.env.ELIZA_APP_DISCORD_BOT_TOKEN;
    } else {
      process.env.ELIZA_APP_DISCORD_BOT_TOKEN = originalToken;
    }
  });

  test("fails readiness when the system bot is enabled but not configured", () => {
    const manager = createReadyManager();
    setSystemBotState(manager, {
      redis: null,
      isElizaAppLeader: false,
      elizaAppClient: null,
    });

    const health = manager.getHealth();

    expect(health.systemBot).toEqual({
      enabled: true,
      configured: false,
      leader: false,
      connected: false,
    });
    expect(health.status).toBe("degraded");
    expect(manager.isReady(health)).toBeFalse();
  });

  test("reports a configured standby without claiming a local connection", () => {
    const manager = createReadyManager();
    setSystemBotState(manager, {
      redis: {},
      isElizaAppLeader: false,
      elizaAppClient: null,
    });

    const health = manager.getHealth();

    expect(health.systemBot).toEqual({
      enabled: true,
      configured: true,
      leader: false,
      connected: false,
    });
    expect(health.status).toBe("healthy");
    expect(manager.isReady(health)).toBeTrue();
  });

  test("degrades a leader until its provider client is ready", () => {
    const manager = createReadyManager();
    setSystemBotState(manager, {
      redis: {},
      isElizaAppLeader: true,
      elizaAppClient: { isReady: () => false },
    });

    const health = manager.getHealth();

    expect(health.systemBot).toMatchObject({
      configured: true,
      leader: true,
      connected: false,
    });
    expect(health.status).toBe("degraded");
    expect(manager.isReady(health)).toBeFalse();
  });

  test("reports and exports a connected leader independently of generic bot counts", () => {
    const manager = createReadyManager();
    setSystemBotState(manager, {
      redis: {},
      isElizaAppLeader: true,
      elizaAppClient: { isReady: () => true },
    });

    const health = manager.getHealth();

    expect(health.totalBots).toBe(0);
    expect(health.systemBot).toEqual({
      enabled: true,
      configured: true,
      leader: true,
      connected: true,
    });
    expect(health.status).toBe("healthy");
    expect(manager.isReady(health)).toBeTrue();
    expect(manager.getStatus()).toMatchObject({ systemBot: health.systemBot });
    expect(manager.getMetrics()).toContain(
      'discord_gateway_system_bot_connected{pod="system-bot-health-test"} 1',
    );
  });
});
