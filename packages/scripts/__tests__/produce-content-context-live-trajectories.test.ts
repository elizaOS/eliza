/** Verifies live-trajectory configuration, fixed object selection, and prompt non-leakage without mocking providers. */

import { describe, expect, it } from "vitest";
import {
  buildLiveControllerPrompt,
  resolveLiveTrajectoryConfig,
  selectLiveTrajectoryObjects,
} from "../produce-content-context-live-trajectories.mjs";

const SHA = "a".repeat(40);
const FAMILIES = [
  "file",
  "document",
  "memory",
  "email",
  "attachment",
  "tool-output",
];

function object(family: string, byteLength: number) {
  return {
    id: `${family}-${byteLength}`,
    family,
    format: "single-line",
    byteLength,
    canaries: [
      {
        label: "end",
        text: `SECRET:${family}`,
        byteStart: byteLength - 20,
        byteEnd: byteLength,
      },
    ],
  };
}

describe("live progressive-content trajectory producer", () => {
  it("fails closed when direct OpenAI credentials are absent", () => {
    expect(() =>
      resolveLiveTrajectoryConfig(
        {
          "corpus-root": ".",
          output: "out",
          commit: SHA,
          model: "gpt-live",
          "judge-model": "gpt-judge",
          "input-usd-per-million": "1",
          "output-usd-per-million": "2",
        },
        {},
      ),
    ).toThrow("OPENAI_API_KEY is required");
  });

  it("requires an independent judge model and explicit positive pricing", () => {
    const base = {
      "corpus-root": ".",
      output: "out",
      commit: SHA,
      model: "gpt-controller",
      "judge-model": "gpt-controller",
      "input-usd-per-million": "1",
      "output-usd-per-million": "2",
    };
    expect(() =>
      resolveLiveTrajectoryConfig(base, { OPENAI_API_KEY: "secret" }),
    ).toThrow("must be distinct");
    expect(() =>
      resolveLiveTrajectoryConfig(
        {
          ...base,
          "judge-model": "gpt-judge",
          "input-usd-per-million": "0",
        },
        { OPENAI_API_KEY: "secret" },
      ),
    ).toThrow("must be a positive number");
  });

  it("selects one bounded multi-page production coordinate per family", () => {
    const manifest = {
      objects: FAMILIES.flatMap((family) => [
        object(family, 200_000),
        object(family, 130_000),
      ]),
    };
    const selected = selectLiveTrajectoryObjects(manifest);
    expect(selected.map(({ family }) => family)).toEqual(FAMILIES);
    expect(selected.every(({ byteLength }) => byteLength === 130_000)).toBe(
      true,
    );
  });

  it("does not disclose the expected canary or its late offset to the controller", () => {
    for (const family of FAMILIES) {
      const prompt = buildLiveControllerPrompt(family);
      expect(prompt).not.toContain(`SECRET:${family}`);
      expect(prompt).not.toContain("129980");
      expect(prompt).toContain("nextOffset");
    }
  });
});
