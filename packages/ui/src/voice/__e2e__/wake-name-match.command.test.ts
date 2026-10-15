/**
 * The wake matcher hands its trailing `command` to `send()`, so it must hand
 * back the user's OWN words. It used to return the normalizer's token stream
 * (`"hey Eliza what's the weather in St. Louis?"` → `"what s the weather in st
 * louis"`): lowercase, punctuation gone, and every apostrophe split into a
 * separate token, so the agent answered a mangled request while the transcript
 * recorded next to it kept the original. The space-less-script fallback was
 * worse — it returned the normalized haystack, dropping every space
 * (`"エリザ turn on the lights"` → `"turnonthelights"`). Normalization stays the
 * matching currency; only the returned command is read from the original.
 */
import { describe, expect, it } from "vitest";
import { initialWakeControllerState, wakeControllerReducer } from "../wake-controller";
import { matchWakeName } from "../wake-name-match";

const COMMAND_CASES: Array<[transcript: string, name: string, command: string]> = [
  [
    "hey Eliza what's the weather in St. Louis?",
    "Eliza",
    "what's the weather in St. Louis?",
  ],
  ["Hey Eliza please order Domino's pizza", "Eliza", "please order Domino's pizza"],
  [
    "hey eliza — play twenty-three by U.S. Girls",
    "Eliza",
    "play twenty-three by U.S. Girls",
  ],
  ["Hey Ada turn on the lights", "Ada", "turn on the lights"],
  // Separators the name abuts are dropped, not spoken.
  ["Eliza, remind me at 3pm", "Eliza", "remind me at 3pm"],
  ["hey eliza", "Eliza", ""],
  ["Eliza,turn on the lights", "Eliza", "turn on the lights"],
  ["Eliza\u0301,turn on lights", "Eliza", "turn on lights"],
  ["hey Eliza's turn", "Eliza", "turn"],
  ["Eliza's on", "Eliza", "on"],
  ["Eliza,what is 2+2?", "Eliza", "what is 2+2?"],
  ["hey Eliza -5 degrees", "Eliza", "-5 degrees"],
  ["hey Eliza 💡 on", "Eliza", "💡 on"],
  ["hey Eliza $100", "Eliza", "$100"],
  ['hey Eliza "Hello"', "Eliza", '"Hello"'],
];

// A name in a script that does not space-separate words takes the substring
// fallback, which must also hand back the original tail rather than the
// space-stripped normalized haystack.
const FALLBACK_CASES: Array<[transcript: string, name: string, command: string]> = [
  ["エリザ天気教えて", "エリザ", "天気教えて"],
  ["エリザ、天気教えて", "エリザ", "天気教えて"],
  ["エリザ 天気 教えて", "エリザ", "天気 教えて"],
  ["エリザ turn on the lights", "エリザ", "turn on the lights"],
  ["ｴﾘｻﾞ what's up", "エリザ", "what's up"],
];

describe("matchWakeName command", () => {
  for (const [transcript, name, command] of COMMAND_CASES) {
    it(`preserves the spoken text after the name: ${JSON.stringify(transcript)}`, () => {
      const match = matchWakeName(transcript, name);
      expect(match.matched).toBe(true);
      expect(match.command).toBe(command);
    });
  }

  for (const [transcript, name, command] of FALLBACK_CASES) {
    it(`keeps the original tail for a space-less name: ${JSON.stringify(transcript)}`, () => {
      const match = matchWakeName(transcript, name);
      expect(match.matched).toBe(true);
      expect(match.command).toBe(command);
    });
  }
});

describe("matchWakeName decisions", () => {
  it("still matches a homophone within the length budget", () => {
    const match = matchWakeName("hey elisa what's up", "Eliza");
    expect(match.matched).toBe(true);
    expect(match.command).toBe("what's up");
  });

  it("still refuses an unrelated phrase after the wake prefix", () => {
    expect(matchWakeName("hey there", "Eliza").matched).toBe(false);
  });

  it("still refuses a bare short name without a prefix", () => {
    expect(matchWakeName("ada turn on the lights", "Ada").matched).toBe(false);
    expect(matchWakeName("hey ada turn on the lights", "Ada").matched).toBe(true);
  });

  it("reports the distance of the matched tokens", () => {
    expect(matchWakeName("hey eliza do it", "Eliza").distance).toBe(0);
    expect(matchWakeName("hey elisa do it", "Eliza").distance).toBe(1);
  });
});


describe("two-stage wake command handoff", () => {
  for (const [transcript, characterName, command] of [...COMMAND_CASES, ...FALLBACK_CASES]) {
    it(`emits the unchanged command and transcript: ${JSON.stringify(transcript)}`, () => {
      const config = { characterName, trainedHeads: new Set<string>(), capabilities: { openWakeWord: true, asrConfirm: true, swabble: false } };
      const candidate = wakeControllerReducer(initialWakeControllerState(), { type: "stage-a-candidate", now: 100 }, config);
      const confirmed = wakeControllerReducer(candidate.state, { type: "stage-b-transcript", transcript, now: 200 }, config);
      expect(confirmed.emit).toEqual({ wakeWord: characterName, command, transcript, path: "two-stage-asr" });
      expect(confirmed.state.phase).toBe("idle");
    });
  }
});
