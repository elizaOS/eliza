import type { FeedbackEntry, Hexagram, IChingReadingState } from "../../types.js";

import { castHexagram, getHexagram, getLowerTrigram, getUpperTrigram } from "./divination.js";

import { buildHexagramPrompt, buildIChingSynthesisPrompt, buildLinePrompt } from "./interpreter.js";

export {
  binaryToHexagramNumber,
  castHexagram,
  getHexagram,
  getLowerTrigram,
  getTrigram,
  getUpperTrigram,
} from "./divination.js";

export {
  buildHexagramPrompt,
  buildIChingSynthesisPrompt,
  buildLinePrompt,
} from "./interpreter.js";

/** Stateless — operates on IChingReadingState objects for concurrent safety. */
export class IChingEngine {
  startReading(question: string): IChingReadingState {
    const castResult = castHexagram();
    const hexagram = getHexagram(castResult.hexagramNumber);

    let transformedHexagram: Hexagram | null = null;
    if (castResult.transformedHexagramNumber !== null) {
      transformedHexagram = getHexagram(castResult.transformedHexagramNumber);
    }

    return {
      question,
      castResult,
      hexagram,
      transformedHexagram,
      revealedLines: 0,
      userFeedback: [],
    };
  }

  /**
   * Returns null when all changing lines have been revealed.
   * If there are no changing lines, the first call returns null.
   */
  getNextReveal(state: IChingReadingState): { linePosition: number; prompt: string } | null {
    const { castResult, hexagram, question, userFeedback, revealedLines } = state;

    const sortedChangingLines = [...castResult.changingLines].sort((a, b) => a - b);

    if (revealedLines >= sortedChangingLines.length) {
      return null;
    }

    const linePosition = sortedChangingLines[revealedLines];

    if (revealedLines === 0) {
      const prompt = buildHexagramPrompt(
        hexagram,
        question,
        castResult.changingLines,
        state.transformedHexagram,
        0,
        userFeedback
      );
      return { linePosition, prompt };
    }

    const prompt = buildLinePrompt(hexagram, linePosition, question, userFeedback);
    return { linePosition, prompt };
  }

  recordFeedback(state: IChingReadingState, feedback: FeedbackEntry): IChingReadingState {
    return {
      ...state,
      revealedLines: state.revealedLines + 1,
      userFeedback: [...state.userFeedback, feedback],
    };
  }

  getSynthesis(state: IChingReadingState): string {
    return buildIChingSynthesisPrompt(
      state.hexagram,
      state.transformedHexagram,
      state.castResult.changingLines,
      state.question,
      state.userFeedback
    );
  }

  getCastingSummary(state: IChingReadingState): string {
    const { hexagram, castResult, transformedHexagram } = state;
    const upper = getUpperTrigram(hexagram);
    const lower = getLowerTrigram(hexagram);

    const parts: string[] = [
      `${hexagram.character} Hexagram ${hexagram.number}: ${hexagram.name} — ${hexagram.englishName}`,
      "",
      `Upper: ${upper.character} ${upper.englishName} (${upper.image})`,
      `Lower: ${lower.character} ${lower.englishName} (${lower.image})`,
    ];

    if (castResult.changingLines.length > 0) {
      parts.push(
        "",
        `Changing lines: ${castResult.changingLines.map((l) => `Line ${l}`).join(", ")}`
      );
    } else {
      parts.push("", "No changing lines — the reading is stable.");
    }

    if (transformedHexagram) {
      parts.push(
        "",
        `Transforming to: ${transformedHexagram.character} Hexagram ${transformedHexagram.number}: ${transformedHexagram.name} — ${transformedHexagram.englishName}`
      );
    }

    return parts.join("\n");
  }

  getHexagramPrompt(state: IChingReadingState): string {
    return buildHexagramPrompt(
      state.hexagram,
      state.question,
      state.castResult.changingLines,
      state.transformedHexagram,
      state.revealedLines,
      state.userFeedback
    );
  }
}
