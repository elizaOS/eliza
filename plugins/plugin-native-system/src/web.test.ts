import { describe, expect, it } from "vitest";

import { SystemWeb } from "./web";

describe("SystemWeb fallback", () => {
  it("returns bounded fallback status and device settings on non-Android runtimes", async () => {
    const system = new SystemWeb();

    await expect(system.getStatus()).resolves.toEqual({
      packageName: "web",
      roles: [],
    });
    await expect(system.getDeviceSettings()).resolves.toMatchObject({
      brightness: 0.75,
      brightnessMode: "unknown",
      canWriteSettings: false,
      volumes: expect.arrayContaining([
        { stream: "music", current: 7, max: 15 },
        { stream: "ring", current: 4, max: 7 },
      ]),
    });
  });

  it("rejects malformed role requests without echoing hostile values", async () => {
    const system = new SystemWeb();

    await expect(
      system.requestRole({ role: "../sms" as never }),
    ).rejects.toThrow("role must be one of home, dialer, sms, assistant");
    await expect(system.requestRole({ role: "sms" })).rejects.toThrow(
      "Android role sms is only available on Android.",
    );
  });

  it("rejects malformed brightness and volume options before fallback errors", async () => {
    const system = new SystemWeb();

    await expect(
      system.setScreenBrightness({ brightness: Number.NaN }),
    ).rejects.toThrow("brightness must be a number between 0 and 1");
    await expect(
      system.setScreenBrightness({ brightness: -0.1 }),
    ).rejects.toThrow("brightness must be a number between 0 and 1");
    await expect(
      system.setScreenBrightness({ brightness: 1.1 }),
    ).rejects.toThrow("brightness must be a number between 0 and 1");
    await expect(
      system.setVolume({ stream: "../../music" as never, volume: 1 }),
    ).rejects.toThrow(
      "stream must be one of music, ring, alarm, notification, system, voiceCall",
    );
    await expect(
      system.setVolume({ stream: "music", volume: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("volume must be a non-negative finite integer");
    await expect(
      system.setVolume({ stream: "music", volume: 1.5 }),
    ).rejects.toThrow("volume must be a non-negative finite integer");
    await expect(
      system.setVolume({ stream: "music", volume: -1 }),
    ).rejects.toThrow("volume must be a non-negative finite integer");
    await expect(
      system.setScreenBrightness({ brightness: 0.5 }),
    ).rejects.toThrow("Brightness control is only available on Android.");
    await expect(
      system.setVolume({ stream: "music", volume: 1 }),
    ).rejects.toThrow("music volume control is only available on Android.");
  });
});
