/** Weather location regressions; uses the real public Core export closure. */
import { describe, expect, test } from "bun:test";
import {
  finalizeSharedRealtimeReply,
  resolveSharedRealtimeRequirement,
} from "./shared-realtime-grounding";

describe("Shared public weather location", () => {
  for (const [message, location] of [
    [
      "IM-WX-1008: What is the current weather in Springfield, Missouri? Include the city, current temperature, and conditions. Text only.",
      "Springfield, Missouri",
    ],
    ["current weather in Paris, France?", "Paris, France"],
    ["weather in Springfield, Missouri, USA", "Springfield, Missouri, USA"],
    ["current weather in Springfield, MO.", "Springfield, MO"],
    ["weather in St. Louis, Missouri. Include temperature and conditions.", "St. Louis, Missouri"],
    ["weather in Mt. Pleasant, Michigan.", "Mt. Pleasant, Michigan"],
    ["weather in Springfield, Missouri. Text only.", "Springfield, Missouri"],
    ["weather in Springfield, Missouri; include conditions", "Springfield, Missouri"],
    [
      "weather in Springfield, Missouri include temperature and conditions",
      "Springfield, Missouri",
    ],
    ["weather in Springfield, Missouri and include temperature", "Springfield, Missouri"],
    ["weather in Austin", "Austin"],
  ] as const) {
    test(`preserves bounded public weather location: ${message}`, () => {
      expect(resolveSharedRealtimeRequirement(message, [])).toMatchObject({
        domain: "weather",
        query: `current public weather in ${location}`,
      });
    });
  }

  for (const message of [
    "weather in Springfield, Missouri, USA, North America",
    "weather in Springfield,",
    "weather in , Missouri",
    `weather in ${"A".repeat(81)}`,
    `weather in ${"A".repeat(241)}`,
    "weather in Springfield, Missouri\u0000",
    "weather in Springfield, Missouri\u200b",
    "weather in Springfield, Missouri\ninclude conditions",
    "weather in 37.2090, -93.2923",
    "weather at https://example.com/conditions",
    "weather in my location",
  ]) {
    test(`rejects unsafe weather location: ${JSON.stringify(message)}`, () => {
      expect(resolveSharedRealtimeRequirement(message, [])).toBeUndefined();
    });
  }

  test("keeps unsupported weather claims fail closed", () => {
    expect(
      finalizeSharedRealtimeReply("Springfield is 75 degrees Fahrenheit and sunny.", {
        kind: "web_search",
        query: "current public weather in Springfield, Missouri, USA",
        provider: "parallel",
        observedAt: Date.UTC(2026, 9, 8, 17),
        truncated: false,
        text: "source data",
        sources: [
          {
            url: "https://weather.example/current",
            text: "Springfield, Missouri is 75 degrees Fahrenheit and sunny.",
          },
        ],
      }),
    ).toContain("couldn’t safely bind");
  });
});
