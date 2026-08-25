import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ContinuityShellRunner,
  probeContinuityDevices,
} from "./continuity-probe.js";

const realPlatform = process.platform;

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const createActivitySignal = vi.fn(async () => {});
const listActivitySignals = vi.fn(async () => []);
const repository = { createActivitySignal, listActivitySignals };

function shellWith(stdout: string): ContinuityShellRunner {
  return { run: vi.fn(async () => ({ stdout })) };
}

function bluetoothJson(
  entries: Array<{
    name: string;
    address: string;
    minorType: string;
    connected: boolean;
  }>,
): string {
  const connected: Record<string, unknown> = {};
  const notConnected: Record<string, unknown> = {};
  for (const entry of entries) {
    const payload = {
      device_address: entry.address,
      device_minorType: entry.minorType,
    };
    (entry.connected ? connected : notConnected)[entry.name] = payload;
  }
  return JSON.stringify({
    SPBluetoothDataType: [
      { device_connected: connected, device_not_connected: notConnected },
    ],
  });
}

beforeEach(() => {
  createActivitySignal.mockReset();
  listActivitySignals.mockReset();
  listActivitySignals.mockResolvedValue([]);
  setPlatform("darwin");
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe("probeContinuityDevices", () => {
  it("is a no-op on non-darwin platforms", async () => {
    setPlatform("linux");
    await probeContinuityDevices({
      repository,
      agentId: "agent-1",
      now: new Date("2026-08-25T12:00:00Z"),
    });
    expect(listActivitySignals).not.toHaveBeenCalled();
    expect(createActivitySignal).not.toHaveBeenCalled();
  });

  it("does not run when a recent capacitor mobile signal is authoritative", async () => {
    listActivitySignals.mockResolvedValue([
      {
        source: "mobile_device",
        platform: "capacitor:ios",
        state: "active",
        metadata: {},
      },
    ]);
    const shell = shellWith("{}");
    await probeContinuityDevices({
      repository,
      agentId: "agent-1",
      now: new Date("2026-08-25T12:00:00Z"),
      shell,
    });
    expect(shell.run).not.toHaveBeenCalled();
    expect(createActivitySignal).not.toHaveBeenCalled();
  });

  it("ignores bluetooth headphones even though 'Headphones' contains 'phone'", async () => {
    const shell = shellWith(
      bluetoothJson([
        {
          name: "Sony WH-1000XM",
          address: "AA:BB:CC:DD:EE:01",
          minorType: "Headphones",
          connected: true,
        },
      ]),
    );
    await probeContinuityDevices({
      repository,
      agentId: "agent-1",
      now: new Date("2026-08-25T12:00:00Z"),
      shell,
    });
    expect(createActivitySignal).not.toHaveBeenCalled();
  });

  it("emits a mobile_device signal for a paired connected iPhone", async () => {
    const shell = shellWith(
      bluetoothJson([
        {
          name: "Owner iPhone",
          address: "AA:BB:CC:DD:EE:02",
          minorType: "Phone",
          connected: true,
        },
      ]),
    );
    await probeContinuityDevices({
      repository,
      agentId: "agent-1",
      now: new Date("2026-08-25T12:00:00Z"),
      shell,
    });
    expect(createActivitySignal).toHaveBeenCalledTimes(1);
    const signal = createActivitySignal.mock.calls[0][0];
    expect(signal.platform).toBe("macos_continuity:system_profiler_bluetooth");
    expect(signal.state).toBe("active");
    expect(signal.metadata.deviceId).toBe("AA:BB:CC:DD:EE:02");
  });

  it("merges devicectl over bluetooth for the same device id and stays idempotent", async () => {
    const devicectl = JSON.stringify({
      result: {
        devices: [
          {
            identifier: "00008120-001A1B2C3D4E",
            deviceProperties: { name: "Owner iPhone", deviceType: "iPhone" },
            connectionProperties: {
              pairingState: "paired",
              tunnelState: "connected",
            },
          },
        ],
      },
    });
    let calls = 0;
    const shell: ContinuityShellRunner = {
      run: vi.fn(async () => {
        calls += 1;
        return { stdout: calls === 1 ? devicectl : bluetoothJson([]) };
      }),
    };
    await probeContinuityDevices({
      repository,
      agentId: "agent-1",
      now: new Date("2026-08-25T12:00:00Z"),
      shell,
    });
    expect(createActivitySignal).toHaveBeenCalledTimes(1);
    const signal = createActivitySignal.mock.calls[0][0];
    expect(signal.platform).toBe("macos_continuity:xcrun_devicectl");

    // Second run with the same observation → no duplicate signal.
    createActivitySignal.mockReset();
    listActivitySignals.mockResolvedValue([signal]);
    await probeContinuityDevices({
      repository,
      agentId: "agent-1",
      now: new Date("2026-08-25T12:01:00Z"),
      shell,
    });
    expect(createActivitySignal).not.toHaveBeenCalled();
  });

  it("tolerates malformed devicectl output and falls back to bluetooth", async () => {
    let calls = 0;
    const shell: ContinuityShellRunner = {
      run: vi.fn(async () => {
        calls += 1;
        return { stdout: calls === 1 ? "not json {" : bluetoothJson([]) };
      }),
    };
    await expect(
      probeContinuityDevices({
        repository,
        agentId: "agent-1",
        now: new Date("2026-08-25T12:00:00Z"),
        shell,
      }),
    ).resolves.toBeUndefined();
    expect(createActivitySignal).not.toHaveBeenCalled();
  });
});
