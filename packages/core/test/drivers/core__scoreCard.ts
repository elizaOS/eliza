// SPEC.md, "Conformance": spec/core/scoreCard.md against ScoreCard of src/prompt-optimization.vibe, one per key, observed through its signals
import type { Driver, Options } from "../../gen/core__scoreCard.conformance.ts";
import type { NumericKind, ScoreCard as Card, ScoreSignal as Signal } from "../../gen/core__scoreCard.ts";
import { ScoreCard } from "../../src/prompt-optimization.vibe";

const cards = new Map<string, ScoreCard>();

const cardOf = (key: string): ScoreCard => {
  const existing = cards.get(key);
  if (existing) return existing;
  const created = new ScoreCard();
  cards.set(key, created);
  return created;
};

const numberOf = (numericKind: NumericKind, value: number): number => {
  if (numericKind === "FiniteValue") return value;
  if (numericKind === "NaNValue") return Number.NaN;
  if (numericKind === "PositiveInfinity") return Number.POSITIVE_INFINITY;
  if (numericKind === "NegativeInfinity") return Number.NEGATIVE_INFINITY;
  return "x" as unknown as number;
};

const kindOf = (value: number): NumericKind => {
  if (Number.isFinite(value)) return "FiniteValue";
  if (Number.isNaN(value)) return "NaNValue";
  return value > 0 ? "PositiveInfinity" : "NegativeInfinity";
};

const comparable = (signals: readonly Signal[]): Card => ({
  signals: signals.map((signal) => ({ ...signal, value: signal.numericKind === "FiniteValue" ? signal.value : 0 })),
});

export const driver: Driver<Card> = {
  reset: () => {
    cards.clear();
  },
  dispatch: (key, event) => {
    cardOf(key).add({
      source: event.source,
      kind: event.kind,
      value: numberOf(event.numericKind, event.value),
      metadata: { text: event.metadata },
    });
    return "accepted";
  },
  observe: (key) =>
    comparable(
      cardOf(key).signals.map((signal) => ({
        source: signal.source,
        kind: signal.kind,
        numericKind: kindOf(signal.value),
        value: signal.value,
        metadata: signal.metadata?.text as string,
      })),
    ),
};

export const options: Options<Card> = { view: (state) => comparable(state.signals) };
