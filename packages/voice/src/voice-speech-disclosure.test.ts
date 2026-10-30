import { describe, expect, it } from "vitest";
import { CLEF_RECENT_TURNS_MAX } from "./voice-endpoint-chain";
import {
  SPEECH_DISCLOSURES,
  speechDisclosure,
  speechDisclosures,
} from "./voice-speech-disclosure";

describe("speech disclosure table", () => {
  it("states exactly what leaves the device on each route", () => {
    expect(
      SPEECH_DISCLOSURES.map(({ route, leavesDevice, sends }) => ({
        route,
        leavesDevice,
        sends,
      })),
    ).toEqual([
      { route: "local-turn", leavesDevice: false, sends: [] },
      {
        route: "clef-turn",
        leavesDevice: true,
        sends: ["transcript-text", "recent-text-turns"],
      },
      { route: "local-stt", leavesDevice: false, sends: [] },
      { route: "cloud-stt", leavesDevice: true, sends: ["audio"] },
      { route: "local-tts", leavesDevice: false, sends: [] },
      { route: "cloud-tts", leavesDevice: true, sends: ["reply-text"] },
    ]);
    const clef = speechDisclosure("clef-turn");
    expect(clef.neverSends).toContain("audio");
    expect(clef.maxRecentTurns).toBe(CLEF_RECENT_TURNS_MAX);
    expect(clef.text).toContain("Audio is never sent.");
    expect(clef.text).toContain(`up to ${CLEF_RECENT_TURNS_MAX} recent turns`);
    expect(speechDisclosure("cloud-stt").text).toMatch(/audio .* is sent/);
    expect(speechDisclosure("cloud-tts").text).toMatch(/text of each reply/);
    for (const row of SPEECH_DISCLOSURES) {
      expect(row.sends.filter((kind) => row.neverSends.includes(kind))).toEqual(
        [],
      );
      expect(row.text).toMatch(/\.$/);
    }
  });

  it("takes the product's names and nothing else, and is frozen", () => {
    const rows = speechDisclosures({
      serviceName: "Alpha Cloud",
      deviceNoun: "phone",
    });
    expect(
      speechDisclosure("cloud-stt", { serviceName: "Alpha Cloud" }).text,
    ).toBe(
      "The audio of what you say is sent to Alpha Cloud to be transcribed.",
    );
    expect(rows.find((row) => row.route === "local-stt")?.text).toBe(
      "Your voice is transcribed on this phone. Audio is not sent.",
    );
    expect(() => speechDisclosures({ serviceName: "bad\nname" })).toThrow(
      TypeError,
    );
    expect(() => speechDisclosures({ deviceNoun: " " })).toThrow(TypeError);
    expect(() =>
      speechDisclosures({ serviceName: "x".repeat(60) }),
    ).not.toThrow();
    expect(() =>
      speechDisclosures({ serviceName: "x".repeat(61) }),
    ).toThrow(TypeError);
    expect(() =>
      speechDisclosures({ deviceNoun: "x".repeat(61) }),
    ).toThrow(TypeError);
    expect(Object.isFrozen(SPEECH_DISCLOSURES)).toBe(true);
    expect(Object.isFrozen(SPEECH_DISCLOSURES[1])).toBe(true);
    expect(Object.isFrozen(SPEECH_DISCLOSURES[1]?.sends)).toBe(true);
    expect(() =>
      speechDisclosure("cloud-video" as unknown as "cloud-stt"),
    ).toThrow(RangeError);
  });
});
