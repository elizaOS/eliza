import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const deviceTurn = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@elizaos/plugin-assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/plugin-assistant")>()),
  getDeviceActionTurn: () => deviceTurn.current,
}));

import { ownerAlarmsAction } from "./owner-surfaces.js";

const runtime = {
  agentId: "00000000-0000-0000-0000-0000000000a0",
  getRoom: vi.fn(async () => null),
} as unknown as IAgentRuntime;
const message = {
  entityId: "00000000-0000-0000-0000-0000000000a1",
  roomId: "00000000-0000-0000-0000-0000000000a2",
  content: { text: "wake me up at 6:30 tomorrow" },
} as unknown as Memory;

function onDeviceTurn(capabilities: readonly string[]): void {
  deviceTurn.current = {
    active: true,
    runtime,
    credential: {
      subjectUserId: "owner",
      installationId: "install",
      deviceKey: "key",
      capabilities,
    },
  };
}

afterEach(() => {
  deviceTurn.current = undefined;
});

describe("OWNER_ALARMS validate", () => {
  it("is false on a device turn that offers the Clock handoff", async () => {
    onDeviceTurn(["clock.handoff.v1"]);
    expect(await ownerAlarmsAction.validate?.(runtime, message)).toBe(false);
  });

  it("is false on a device turn that manages Clock alarms", async () => {
    onDeviceTurn(["clock.alarms.v1"]);
    expect(await ownerAlarmsAction.validate?.(runtime, message)).toBe(false);
  });

  it("is true with no device turn", async () => {
    expect(await ownerAlarmsAction.validate?.(runtime, message)).toBe(true);
  });

  it("is true on a device turn without a Clock capability", async () => {
    onDeviceTurn(["notes.query.v1"]);
    expect(await ownerAlarmsAction.validate?.(runtime, message)).toBe(true);
  });

  it("says it saves an in-app reminder that does not ring", () => {
    expect(ownerAlarmsAction.description).toContain(
      "it does not ring a device alarm",
    );
  });
});
