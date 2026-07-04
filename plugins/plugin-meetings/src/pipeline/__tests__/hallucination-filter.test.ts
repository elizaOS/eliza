/**
 * Post-ASR hallucination gate (`isHallucination`) against the ported Vexa
 * goldens. Pure, deterministic.
 */
import { describe, expect, it } from "vitest";
import { isHallucination } from "../hallucination-filter";

describe("isHallucination — Vexa goldens", () => {
  it("drops empty / whitespace text", () => {
    expect(isHallucination("")).toBe(true);
    expect(isHallucination("   ")).toBe(true);
  });

  it("drops known corpus phrases exactly as Whisper emits them", () => {
    expect(isHallucination(" Thanks for watching!")).toBe(true);
    expect(isHallucination("Thank you so much for joining us today.")).toBe(
      true,
    );
    expect(isHallucination("Bye-bye.")).toBe(true);
    expect(isHallucination("I'll see you next time.")).toBe(true);
  });

  it("drops corpus phrases case-insensitively", () => {
    expect(isHallucination("THANKS FOR WATCHING!")).toBe(true);
    expect(isHallucination("thank you very much.")).toBe(true);
  });

  it("drops corpus phrases with normalized trailing punctuation", () => {
    expect(isHallucination("Thanks for watching?")).toBe(true); // strips to "thanks for watching" + retries with "." / "..."
    expect(isHallucination("Thank you.")).toBe(true);
    expect(isHallucination("Thank you...")).toBe(true);
  });

  it("drops non-English corpus phrases (es/pt/ru)", () => {
    expect(isHallucination("¡Gracias por ver el vídeo!")).toBe(true);
    expect(isHallucination("Obrigado.")).toBe(true);
    expect(isHallucination("Продолжение следует...")).toBe(true);
    expect(isHallucination("Субтитры создавал DimaTorzok")).toBe(true);
  });

  it("drops single short words", () => {
    expect(isHallucination("Hm")).toBe(true);
    expect(isHallucination("wat")).toBe(true);
  });

  it("keeps a single long word", () => {
    expect(isHallucination("Congratulations")).toBe(false);
  });

  it("drops repetition loops (same 3-6 word phrase 3+ times)", () => {
    const loop = Array(5).fill("thank you Mr. President").join(" ");
    expect(isHallucination(loop)).toBe(true);
    const loop6 = Array(3).fill("we are going to be fine").join(" ");
    expect(isHallucination(loop6)).toBe(true);
  });

  it("keeps real meeting speech", () => {
    expect(
      isHallucination(
        "Let's review the Q3 roadmap and assign owners for each milestone.",
      ),
    ).toBe(false);
    expect(
      isHallucination("The deploy failed because the lockfile drifted."),
    ).toBe(false);
    // Repeats twice, not three times — legitimate emphasis
    expect(isHallucination("we need to ship it we need to ship it soon")).toBe(
      false,
    );
  });
});
