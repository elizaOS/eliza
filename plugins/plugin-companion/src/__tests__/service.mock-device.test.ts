import { afterEach, describe, expect, it } from "vitest";
import { getCompanionStatusAction } from "../actions/get-status";
import { setCompanionMoodAction } from "../actions/set-mood";
import { CompanionClient, CompanionClientError } from "../companion-client";
import { CompanionService } from "../companion-service";
import { COMPANION_SERVICE_TYPE } from "../protocol";
import { companionDeviceProvider } from "../providers/companion-device";
import { type MockDevice, startMockDevice, TEST_DEVICE_ID, TEST_TOKEN } from "./mock-device";

function runtimeFor(service: CompanionService) {
  return {
    getService: (type: string) => (type === COMPANION_SERVICE_TYPE ? service : null),
    getSetting: () => null,
  } as never;
}

describe("companion service mock device", () => {
  let device: MockDevice | undefined;
  let service: CompanionService | undefined;

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    await device?.close();
    device = undefined;
  });

  it("handshakes, SET_MOOD round-trips, GET_STATUS, and records touch", async () => {
    device = await startMockDevice();
    const client = new CompanionClient({ commandTimeoutMs: 2000, handshakeTimeoutMs: 2000 });
    service = new CompanionService(undefined, client);
    const snapshot = await service.connect(device.url, TEST_TOKEN);

    expect(snapshot.connected).toBe(true);
    expect(snapshot.deviceId).toBe(TEST_DEVICE_ID);
    expect(snapshot.firmware).toBe("eliza-companion/0.1.0");
    expect(snapshot.capabilities?.platform).toBe("esp32-s3");

    const mood = await service.setMood("thinking");
    expect(mood).toBe("thinking");

    const status = await service.getStatus();
    expect(status.mood).toBe("thinking");
    expect(status.deviceId).toBe(TEST_DEVICE_ID);

    device.emit({ type: "event", name: "touch", payload: { mood: "thinking" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.getSnapshot().lastEvent?.name).toBe("touch");

    const provider = await companionDeviceProvider.get(
      runtimeFor(service),
      {} as never,
      {} as never
    );
    expect(provider.values?.companionLastEvent).toBe("touch");
    expect(provider.values?.companionConnected).toBe(true);

    const actionResult = await setCompanionMoodAction.handler(
      runtimeFor(service),
      {} as never,
      {} as never,
      { parameters: { mood: "happy" } }
    );
    expect(actionResult?.success).toBe(true);
    expect(actionResult?.data).toMatchObject({ mood: "happy" });

    const statusResult = await getCompanionStatusAction.handler(
      runtimeFor(service),
      {} as never,
      {} as never
    );
    expect(statusResult?.success).toBe(true);
    expect(statusResult?.data).toMatchObject({ deviceId: TEST_DEVICE_ID, mood: "happy" });
  });

  it("rejects invalid mood locally without treating it as idle", async () => {
    device = await startMockDevice();
    service = new CompanionService(undefined, new CompanionClient({ commandTimeoutMs: 2000 }));
    await service.connect(device.url, TEST_TOKEN);
    await expect(service.setMood("angry")).rejects.toMatchObject({ code: "invalid-mood" });
    expect(service.getSnapshot().mood).not.toBe("idle");

    const result = await setCompanionMoodAction.handler(
      runtimeFor(service),
      {} as never,
      {} as never,
      { parameters: { mood: "angry" } }
    );
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("invalid-mood");
  });

  it("returns ok:false for unknown commands without crashing", async () => {
    device = await startMockDevice();
    const client = new CompanionClient({ commandTimeoutMs: 2000 });
    await client.connect(device.url, TEST_TOKEN);
    const result = await client.sendRawCommand("NOPE");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown-command");
    await client.disconnect();
  });

  it("ignores malformed JSON from the device", async () => {
    device = await startMockDevice({ malformedOnConnect: true });
    const client = new CompanionClient({ handshakeTimeoutMs: 2000 });
    const snapshot = await client.connect(device.url, TEST_TOKEN);
    expect(snapshot.deviceId).toBe(TEST_DEVICE_ID);
    device.emit("garbage {");
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
  });

  it("marks disconnected after a dropped pong and rejects later commands", async () => {
    device = await startMockDevice({ dropPong: true });
    const client = new CompanionClient({ pingTimeoutMs: 80, commandTimeoutMs: 200 });
    await client.connect(device.url, TEST_TOKEN);
    await client.ping();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.isConnected()).toBe(false);
    await expect(client.getStatus()).rejects.toBeInstanceOf(CompanionClientError);
  });

  it("GET_STATUS fails closed when disconnected", async () => {
    service = new CompanionService(undefined, new CompanionClient());
    await expect(service.getStatus()).rejects.toMatchObject({ code: "not-connected" });
    const result = await getCompanionStatusAction.handler(
      runtimeFor(service),
      {} as never,
      {} as never
    );
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("not-connected");
  });

  it("does not treat a register without deviceId as connected", async () => {
    device = await startMockDevice({ deviceId: null });
    const client = new CompanionClient({ handshakeTimeoutMs: 200 });
    await expect(client.connect(device.url, TEST_TOKEN)).rejects.toMatchObject({
      code: "handshake-timeout",
    });
    expect(client.isConnected()).toBe(false);
  });

  it("provider reports disconnected when no service is registered", async () => {
    const runtime = {
      getService: () => null,
    } as never;
    const result = await companionDeviceProvider.get(runtime, {} as never, {} as never);
    expect(result.values?.companionConnected).toBe(false);
  });
});
