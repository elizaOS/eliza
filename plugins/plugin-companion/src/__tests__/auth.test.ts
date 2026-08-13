import { afterEach, describe, expect, it } from "vitest";
import { CompanionClient, CompanionClientError } from "../companion-client";
import { type MockDevice, startMockDevice, TEST_TOKEN } from "./mock-device";

describe("companion pairing auth", () => {
  let device: MockDevice | undefined;

  afterEach(async () => {
    await device?.close();
    device = undefined;
  });

  it("rejects a missing pairing token before opening the socket", async () => {
    const client = new CompanionClient();
    await expect(
      client.connect("ws://127.0.0.1:9/api/companion/device-bridge", "")
    ).rejects.toMatchObject({ code: "missing-token" });
  });

  it("rejects a wrong token with 401", async () => {
    device = await startMockDevice({ token: TEST_TOKEN });
    const client = new CompanionClient({ handshakeTimeoutMs: 1500 });
    await expect(client.connect(device.url, "wrong-token")).rejects.toBeInstanceOf(
      CompanionClientError
    );
    await expect(client.connect(device.url, "wrong-token")).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("does not send commands before handshake completes", async () => {
    const client = new CompanionClient();
    await expect(client.setMood("listening")).rejects.toMatchObject({
      code: "not-connected",
    });
  });

  it("accepts the matching token and records register", async () => {
    device = await startMockDevice();
    const client = new CompanionClient({ handshakeTimeoutMs: 2000 });
    const snapshot = await client.connect(device.url, TEST_TOKEN);
    expect(snapshot.connected).toBe(true);
    expect(snapshot.deviceId).toBeTruthy();
    await client.disconnect();
  });
});
