import type { DrawnCard, FeedbackEntry, SpreadPosition, TarotReadingState } from "../../types";
import { createDeck, drawCards, shuffleDeck } from "./deck";
import {
  buildCardInterpretationPrompt,
  buildDeepenPrompt,
  buildSynthesisPrompt,
} from "./interpreter";
import { getAllSpreads, getSpread } from "./spreads";

export interface RevealResult {
  card: DrawnCard;
  position: SpreadPosition;
  prompt: string;
}

/** Stateless — all reading state lives in TarotReadingState objects. */
export class TarotEngine {
  startReading(spreadId: string, question: string, allowReversals = true): TarotReadingState {
    const spread = getSpread(spreadId);
    if (!spread) {
      const available = getAllSpreads()
        .map((s) => `"${s.id}"`)
        .join(", ");
      throw new Error(`Unknown spread "${spreadId}". Available spreads: ${available}`);
    }

    const deck = shuffleDeck(createDeck());
    const drawnCards = drawCards(deck, spread.cardCount, allowReversals);

    return {
      spread,
      question,
      drawnCards,
      revealedIndex: 0,
      userFeedback: [],
    };
  }

  /** Does NOT advance revealedIndex — call recordFeedback() to advance. */
  getNextReveal(state: TarotReadingState): RevealResult | null {
    if (state.revealedIndex >= state.drawnCards.length) {
      return null;
    }

    const card = state.drawnCards[state.revealedIndex];
    const position = state.spread.positions[state.revealedIndex];

    const prompt = buildCardInterpretationPrompt(
      card,
      position,
      state.question,
      state.userFeedback
    );

    return { card, position, prompt };
  }

  recordFeedback(state: TarotReadingState, feedback: FeedbackEntry): TarotReadingState {
    if (state.revealedIndex >= state.drawnCards.length) {
      throw new Error("Cannot record feedback: all cards have already been revealed");
    }

    return {
      ...state,
      revealedIndex: state.revealedIndex + 1,
      userFeedback: [...state.userFeedback, feedback],
    };
  }

  getSynthesis(state: TarotReadingState): string {
    if (state.revealedIndex < state.drawnCards.length) {
      const remaining = state.drawnCards.length - state.revealedIndex;
      throw new Error(`Cannot synthesize: ${remaining} card(s) have not been revealed yet`);
    }

    return buildSynthesisPrompt(state.drawnCards, state.spread, state.question, state.userFeedback);
  }

  getDeepening(state: TarotReadingState, cardIndex: number, userResponse: string): string {
    if (cardIndex < 0 || cardIndex >= state.drawnCards.length) {
      throw new RangeError(
        `Card index ${cardIndex} is out of bounds (0-${state.drawnCards.length - 1})`
      );
    }

    if (cardIndex >= state.revealedIndex) {
      throw new Error(
        `Card at index ${cardIndex} has not been revealed yet (current reveal index: ${state.revealedIndex})`
      );
    }

    const card = state.drawnCards[cardIndex];
    const position = state.spread.positions[cardIndex];

    return buildDeepenPrompt(card, position, state.question, userResponse);
  }

  isComplete(state: TarotReadingState): boolean {
    return state.revealedIndex >= state.drawnCards.length;
  }

  getReadingSummary(state: TarotReadingState): {
    spread: string;
    question: string;
    totalCards: number;
    revealedCards: number;
    feedbackCount: number;
    isComplete: boolean;
    cards: Array<{
      position: string;
      card: string;
      reversed: boolean;
      revealed: boolean;
    }>;
  } {
    return {
      spread: state.spread.name,
      question: state.question,
      totalCards: state.drawnCards.length,
      revealedCards: state.revealedIndex,
      feedbackCount: state.userFeedback.length,
      isComplete: this.isComplete(state),
      cards: state.drawnCards.map((dc, i) => ({
        position: state.spread.positions[i].name,
        card: dc.card.name,
        reversed: dc.reversed,
        revealed: i < state.revealedIndex,
      })),
    };
  }
}
