import { describe, expect, it } from "vitest";
import { G1Command } from "../protocol.js";
import { WebBluetoothG1Transport } from "../transport/web-bluetooth.js";

class FakeCharacteristic extends EventTarget {
  value?: DataView;
  readonly writes: Uint8Array[] = [];
  notificationsStarted = false;
  notificationsStopped = false;

  async writeValueWithResponse(data: ArrayBuffer): Promise<void> {
    this.writes.push(new Uint8Array(data));
  }

  async startNotifications(): Promise<this> {
    this.notificationsStarted = true;
    return this;
  }

  async stopNotifications(): Promise<void> {
    this.notificationsStopped = true;
  }

  emit(data: Uint8Array): void {
    this.value = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

function createFakeBluetooth() {
  const leftTx = new FakeCharacteristic();
  const leftRx = new FakeCharacteristic();
  const rightTx = new FakeCharacteristic();
  const rightRx = new FakeCharacteristic();
  const devices = [
    { name: "Even_G1_L_demo", tx: leftTx, rx: leftRx },
    { name: "Even_G1_R_demo", tx: rightTx, rx: rightRx },
  ];
  const requests: Array<{ options: unknown; deviceName: string }> = [];

  return {
    leftTx,
    leftRx,
    rightTx,
    rightRx,
    requests,
    bluetooth: {
      requestDevice: async (options: unknown) => {
        const device = devices.shift();
        if (!device) throw new Error("No fake devices left");
        requests.push({ options, deviceName: device.name });
        return {
          id: device.name,
          name: device.name,
          gatt: {
            connect: async () => ({
              connected: true,
              disconnect: () => undefined,
              getPrimaryService: async () => ({
                getCharacteristic: async (uuid: string) =>
                  uuid.includes("0002") ? device.tx : device.rx,
              }),
            }),
          },
        };
      },
    },
  };
}

function createWrongSideBluetooth() {
  const tx = new FakeCharacteristic();
  const rx = new FakeCharacteristic();
  return {
    bluetooth: {
      requestDevice: async () => ({
        name: "Even_G1_R_wrong_step",
        gatt: {
          connect: async () => ({
            connected: true,
            getPrimaryService: async () => ({
              getCharacteristic: async (uuid: string) =>
                uuid.includes("0002") ? tx : rx,
            }),
          }),
        },
      }),
    },
  };
}

function createSecondStepMismatchBluetooth() {
  const leftTx = new FakeCharacteristic();
  const leftRx = new FakeCharacteristic();
  const wrongTx = new FakeCharacteristic();
  const wrongRx = new FakeCharacteristic();
  const devices = [
    { name: "Even_G1_L_demo", tx: leftTx, rx: leftRx },
    { name: "Even_G1_L_again", tx: wrongTx, rx: wrongRx },
  ];
  return {
    leftRx,
    bluetooth: {
      requestDevice: async () => {
        const device = devices.shift();
        if (!device) throw new Error("No fake devices left");
        return {
          id: device.name,
          name: device.name,
          gatt: {
            connect: async () => ({
              connected: true,
              disconnect: () => undefined,
              getPrimaryService: async () => ({
                getCharacteristic: async (uuid: string) =>
                  uuid.includes("0002") ? device.tx : device.rx,
              }),
            }),
          },
        };
      },
    },
  };
}

function createDuplicateDeviceBluetooth() {
  const tx = new FakeCharacteristic();
  const rx = new FakeCharacteristic();
  const device = {
    id: "same-device-id",
    name: undefined,
    gatt: {
      connect: async () => ({
        connected: true,
        getPrimaryService: async () => ({
          getCharacteristic: async (uuid: string) =>
            uuid.includes("0002") ? tx : rx,
        }),
      }),
    },
  };
  return {
    bluetooth: {
      requestDevice: async () => device,
    },
  };
}

describe("WebBluetoothG1Transport", () => {
  it("connects both lenses, writes display packets, and parses notifications", async () => {
    const fake = createFakeBluetooth();
    const transport = new WebBluetoothG1Transport(fake.bluetooth);
    const events: string[] = [];
    const audio: number[] = [];

    transport.onEvent((event) => events.push(event.label ?? event.type));
    transport.onAudio((audioPcm) => audio.push(...audioPcm));

    await transport.connect();
    expect(transport.isConnected()).toBe(true);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map((request) => request.deviceName)).toEqual([
      "Even_G1_L_demo",
      "Even_G1_R_demo",
    ]);
    expect(fake.leftRx.notificationsStarted).toBe(true);
    expect(fake.rightRx.notificationsStarted).toBe(true);

    await transport.writeBoth(Uint8Array.from([G1Command.SendResult, 1]));
    expect(Array.from(fake.leftTx.writes[0])).toEqual([
      G1Command.SendResult,
      1,
    ]);
    expect(Array.from(fake.rightTx.writes[0])).toEqual([
      G1Command.SendResult,
      1,
    ]);

    await transport.openMicrophone(true);
    expect(Array.from(fake.rightTx.writes.at(-1) ?? [])).toEqual([
      G1Command.OpenMic,
      1,
    ]);

    fake.rightRx.emit(Uint8Array.from([0xf5, 0x01]));
    fake.rightRx.emit(Uint8Array.from([0xf1, 7, 1, 2]));
    expect(events).toContain("single_tap");
    expect(audio).toEqual([1, 2]);

    await transport.disconnect();
    expect(fake.leftRx.notificationsStopped).toBe(true);
    expect(fake.rightRx.notificationsStopped).toBe(true);
  });

  it("rejects a visible lens-side mismatch during whole-headset pairing", async () => {
    const fake = createWrongSideBluetooth();
    const transport = new WebBluetoothG1Transport(fake.bluetooth);

    await expect(transport.connectLens("left")).rejects.toThrow(
      "expected a lens name containing _L_",
    );
    expect(transport.isConnected()).toBe(false);
    expect(transport.getConnectedLenses()).toEqual({});
  });

  it("cleans up a partial connection when whole-headset connect fails", async () => {
    const fake = createSecondStepMismatchBluetooth();
    const transport = new WebBluetoothG1Transport(fake.bluetooth);

    await expect(transport.connect()).rejects.toThrow(
      "expected a lens name containing _R_",
    );
    expect(transport.isConnected()).toBe(false);
    expect(transport.getConnectedLenses()).toEqual({});
    expect(fake.leftRx.notificationsStopped).toBe(true);
  });

  it("rejects selecting the same unnamed device for both lenses", async () => {
    const fake = createDuplicateDeviceBluetooth();
    const transport = new WebBluetoothG1Transport(fake.bluetooth);

    await transport.connectLens("left");
    await expect(transport.connectLens("right")).rejects.toThrow(
      "Selected the left lens again",
    );
    expect(transport.isConnected()).toBe(false);
    expect(transport.getConnectedLenses()).toEqual({
      left: {
        connected: true,
        name: undefined,
        address: "same-device-id",
      },
    });
  });
});
