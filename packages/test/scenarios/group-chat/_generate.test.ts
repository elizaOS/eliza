/** Verifies corpus generators reject cached or downloaded bytes that drift from their immutable pins. */
import { describe, expect, it } from "bun:test";
import { verifyWhen2SpeakCorpus } from "./_generate.ts";
import { verifyLoSoNASource } from "./behavior/_generate-losona.ts";

describe("group-chat corpus source integrity", () => {
  it("rejects a mismatched When2Speak source", () => {
    expect(() => verifyWhen2SpeakCorpus("tampered")).toThrow(
      "When2Speak corpus digest does not match the pin",
    );
  });

  it("rejects a mismatched LoSoNA source", () => {
    expect(() => verifyLoSoNASource("tampered")).toThrow(
      "LoSoNA source digest does not match the pin",
    );
  });
});
