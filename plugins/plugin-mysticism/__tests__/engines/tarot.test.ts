import { describe, expect, it } from "vitest";
import {
  createDeck,
  drawCards,
  filterCards,
  getCard,
  shuffleDeck,
} from "../../src/engines/tarot/deck";
import { TarotEngine } from "../../src/engines/tarot/index";
import {
  buildCardInterpretationPrompt,
  buildDeepenPrompt,
  buildSynthesisPrompt,
} from "../../src/engines/tarot/interpreter";
import { getAllSpreads, getSpread, getSpreadNames } from "../../src/engines/tarot/spreads";
import type {
  DrawnCard,
  FeedbackEntry,
  SpreadPosition,
  TarotCard,
  TarotReadingState,
} from "../../src/types";

// ─── Deck Tests ──────────────────────────────────────────

describe("Tarot Deck", () => {
  it("createDeck returns 78 cards", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(78);
  });

  it("all cards have required TarotCard fields", () => {
    const deck = createDeck();
    for (const card of deck) {
      expect(card.id).toBeTypeOf("string");
      expect(card.name).toBeTypeOf("string");
      expect(card.number).toBeTypeOf("number");
      expect(card.arcana).toMatch(/^(major|minor)$/);
      expect(card.meaning_upright).toBeTypeOf("string");
      expect(card.meaning_upright.length).toBeGreaterThan(0);
      expect(card.meaning_reversed).toBeTypeOf("string");
      expect(card.meaning_reversed.length).toBeGreaterThan(0);
      expect(card.keywords_upright).toBeInstanceOf(Array);
      expect(card.keywords_reversed).toBeInstanceOf(Array);
      expect(card.keywords_upright.length).toBeGreaterThan(0);
      expect(card.keywords_reversed.length).toBeGreaterThan(0);
      expect(card.description).toBeTypeOf("string");
      expect(card.element).toBeTypeOf("string");
    }
  });

  it("major arcana has exactly 22 cards with null suit", () => {
    const deck = createDeck();
    const majorArcana = deck.filter((c: TarotCard) => c.arcana === "major");
    expect(majorArcana).toHaveLength(22);
    for (const card of majorArcana) {
      expect(card.suit).toBeNull();
    }
  });

  it("each suit has exactly 14 cards", () => {
    const suits = ["wands", "cups", "swords", "pentacles"] as const;
    const deck = createDeck();
    for (const suit of suits) {
      const suitCards = deck.filter((c: TarotCard) => c.suit === suit);
      expect(suitCards).toHaveLength(14);
      for (const card of suitCards) {
        expect(card.arcana).toBe("minor");
      }
    }
  });

  it("shuffleDeck produces a different order than the original", () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck);
    expect(shuffled).toHaveLength(78);
    // With 78! possible orderings the chance of identical order is astronomically small
    const samePositionCount = shuffled.filter(
      (card: TarotCard, i: number) => card.id === deck[i].id
    ).length;
    expect(samePositionCount).toBeLessThan(78);
  });

  it("shuffleDeck preserves all cards without loss or duplication", () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck);
    const originalIds = deck.map((c: TarotCard) => c.id).sort();
    const shuffledIds = shuffled.map((c: TarotCard) => c.id).sort();
    expect(shuffledIds).toEqual(originalIds);
  });

  it("drawCards returns the correct number of cards", () => {
    const deck = shuffleDeck(createDeck());
    for (const count of [1, 3, 5, 10]) {
      const drawn = drawCards(deck, count);
      expect(drawn).toHaveLength(count);
    }
  });

  it("drawCards produces no duplicate cards", () => {
    const deck = shuffleDeck(createDeck());
    const drawn = drawCards(deck, 10);
    const ids = drawn.map((d) => d.card.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(10);
  });

  it("drawCards with allowReversals=false produces no reversed cards", () => {
    const deck = shuffleDeck(createDeck());
    const drawn = drawCards(deck, 20, false);
    for (const d of drawn) {
      expect(d.reversed).toBe(false);
    }
  });

  it("drawCards throws RangeError when count exceeds deck size", () => {
    const deck = createDeck();
    expect(() => drawCards(deck, 100)).toThrow(RangeError);
    expect(() => drawCards(deck, -1)).toThrow(RangeError);
  });

  it("getCard finds The Fool by ID", () => {
    const fool = getCard("major_00_fool");
    expect(fool).toBeDefined();
    expect(fool?.name).toBe("The Fool");
    expect(fool?.arcana).toBe("major");
    expect(fool?.number).toBe(0);
    expect(fool?.element).toBe("Air");
  });

  it("getCard returns undefined for nonexistent ID", () => {
    const result = getCard("nonexistent_card_xyz");
    expect(result).toBeUndefined();
  });

  it("filterCards by arcana major returns 22 cards", () => {
    const major = filterCards({ arcana: "major" });
    expect(major).toHaveLength(22);
    for (const card of major) {
      expect(card.arcana).toBe("major");
    }
  });

  it("filterCards by suit cups returns 14 cards", () => {
    const cups = filterCards({ suit: "cups" });
    expect(cups).toHaveLength(14);
    for (const card of cups) {
      expect(card.suit).toBe("cups");
    }
  });

  it("filterCards by both arcana minor and suit swords returns 14 cards", () => {
    const minorSwords = filterCards({ arcana: "minor", suit: "swords" });
    expect(minorSwords).toHaveLength(14);
    for (const card of minorSwords) {
      expect(card.arcana).toBe("minor");
      expect(card.suit).toBe("swords");
    }
  });
});

// ─── Spread Tests ────────────────────────────────────────

describe("Tarot Spreads", () => {
  it("celtic_cross spread has 10 positions", () => {
    const spread = getSpread("celtic_cross");
    expect(spread).toBeDefined();
    expect(spread?.positions).toHaveLength(10);
    expect(spread?.cardCount).toBe(10);
    // Each position should have descriptive metadata
    for (const pos of spread?.positions ?? []) {
      expect(pos.name).toBeTypeOf("string");
      expect(pos.name.length).toBeGreaterThan(0);
      expect(pos.description).toBeTypeOf("string");
    }
  });

  it("getAllSpreads returns all available spread definitions", () => {
    const spreads = getAllSpreads();
    expect(spreads.length).toBeGreaterThanOrEqual(5);
    const ids = spreads.map((s) => s.id);
    expect(ids).toContain("single");
    expect(ids).toContain("three_card");
    expect(ids).toContain("celtic_cross");
    expect(ids).toContain("relationship");
    expect(ids).toContain("career");
  });

  it("each spread has positions matching its cardCount", () => {
    const spreads = getAllSpreads();
    for (const spread of spreads) {
      expect(spread.id).toBeTypeOf("string");
      expect(spread.name).toBeTypeOf("string");
      expect(spread.description).toBeTypeOf("string");
      expect(spread.positions).toHaveLength(spread.cardCount);
    }
  });

  it("getSpread returns undefined for unknown spread ID", () => {
    const result = getSpread("nonexistent_spread");
    expect(result).toBeUndefined();
  });
});

// ─── TarotEngine Tests ──────────────────────────────────

describe("TarotEngine", () => {
  const engine = new TarotEngine();

  it("startReading creates valid state with correct spread and cards", () => {
    const state = engine.startReading("three_card", "What should I focus on?");
    expect(state.spread.id).toBe("three_card");
    expect(state.question).toBe("What should I focus on?");
    expect(state.drawnCards).toHaveLength(3);
    expect(state.revealedIndex).toBe(0);
    expect(state.userFeedback).toHaveLength(0);
    // Each drawn card should have valid card data and position index
    state.drawnCards.forEach((dc, i) => {
      expect(dc.card.id).toBeTypeOf("string");
      expect(dc.card.name).toBeTypeOf("string");
      expect(dc.positionIndex).toBe(i);
      expect(typeof dc.reversed).toBe("boolean");
    });
  });

  it("startReading throws for unknown spread ID", () => {
    expect(() => engine.startReading("nonexistent_spread", "question")).toThrow(/Unknown spread/);
  });

  it("getNextReveal returns cards in sequential order", () => {
    const state = engine.startReading("three_card", "test question");

    const reveal1 = engine.getNextReveal(state);
    expect(reveal1).not.toBeNull();
    expect(reveal1?.card).toBe(state.drawnCards[0]);
    expect(reveal1?.position).toBe(state.spread.positions[0]);
    expect(reveal1?.prompt).toBeTypeOf("string");
    expect(reveal1?.prompt.length).toBeGreaterThan(100);
  });

  it("recordFeedback advances revealedIndex and stores feedback immutably", () => {
    const state = engine.startReading("three_card", "test");
    const feedback: FeedbackEntry = {
      element: "The Fool",
      userText: "This speaks to me deeply",
      timestamp: Date.now(),
    };

    const updated = engine.recordFeedback(state, feedback);

    // Updated state advanced
    expect(updated.revealedIndex).toBe(1);
    expect(updated.userFeedback).toHaveLength(1);
    expect(updated.userFeedback[0].element).toBe("The Fool");

    // Original state unchanged (immutability)
    expect(state.revealedIndex).toBe(0);
    expect(state.userFeedback).toHaveLength(0);
  });

  it("getSynthesis returns a non-empty prompt after all cards are revealed", () => {
    let state = engine.startReading("three_card", "What should I focus on?");

    // Reveal all cards by recording feedback for each
    for (let i = 0; i < state.drawnCards.length; i++) {
      const feedback: FeedbackEntry = {
        element: state.drawnCards[i].card.name,
        userText: "Interesting interpretation",
        timestamp: Date.now(),
      };
      state = engine.recordFeedback(state, feedback);
    }

    const synthesis = engine.getSynthesis(state);
    expect(synthesis).toBeTypeOf("string");
    expect(synthesis.length).toBeGreaterThan(100);
    expect(synthesis).toContain("What should I focus on?");
  });

  it("getSynthesis throws if not all cards have been revealed", () => {
    const state = engine.startReading("three_card", "test");
    expect(() => engine.getSynthesis(state)).toThrow(/not been revealed/);
  });

  it("getNextReveal returns null when all cards have been revealed", () => {
    let state = engine.startReading("single", "daily guidance");
    const feedback: FeedbackEntry = {
      element: "card",
      userText: "ok",
      timestamp: Date.now(),
    };
    state = engine.recordFeedback(state, feedback);

    const reveal = engine.getNextReveal(state);
    expect(reveal).toBeNull();
  });

  it("isComplete returns correct values throughout the reading", () => {
    let state = engine.startReading("single", "test");
    expect(engine.isComplete(state)).toBe(false);

    const feedback: FeedbackEntry = {
      element: "card",
      userText: "yes",
      timestamp: Date.now(),
    };
    state = engine.recordFeedback(state, feedback);
    expect(engine.isComplete(state)).toBe(true);
  });

  it("reversed cards produce different interpretation prompt than upright", () => {
    const spread = getSpread("single")!;
    const card = getCard("major_00_fool")!;

    const uprightState: TarotReadingState = {
      spread,
      question: "test",
      drawnCards: [{ card, reversed: false, positionIndex: 0 }],
      revealedIndex: 0,
      userFeedback: [],
    };

    const reversedState: TarotReadingState = {
      spread,
      question: "test",
      drawnCards: [{ card, reversed: true, positionIndex: 0 }],
      revealedIndex: 0,
      userFeedback: [],
    };

    const uprightReveal = engine.getNextReveal(uprightState);
    const reversedReveal = engine.getNextReveal(reversedState);

    expect(uprightReveal).not.toBeNull();
    expect(reversedReveal).not.toBeNull();

    // Prompts should contain different orientation markers
    expect(uprightReveal?.prompt).toContain("UPRIGHT");
    expect(reversedReveal?.prompt).toContain("REVERSED");

    // Different keywords are used
    expect(uprightReveal?.prompt).not.toEqual(reversedReveal?.prompt);

    // The upright prompt should contain upright keywords
    for (const keyword of card.keywords_upright) {
      expect(uprightReveal?.prompt).toContain(keyword);
    }

    // The reversed prompt should contain reversed keywords
    for (const keyword of card.keywords_reversed) {
      expect(reversedReveal?.prompt).toContain(keyword);
    }
  });
});

// ─── Data Integrity Tests (cards.json) ───────────────────

describe("Data Integrity — cards.json", () => {
  const deck = createDeck();

  it("every card ID is unique across all 78 cards", () => {
    const ids = deck.map((c: TarotCard) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(78);
  });

  it("major arcana card IDs follow major_XX_name convention", () => {
    const majorCards = deck.filter((c: TarotCard) => c.arcana === "major");
    for (const card of majorCards) {
      expect(card.id).toMatch(/^major_\d{2}_\w+$/);
    }
  });

  it("minor arcana card IDs follow suit_XX or suit_page/knight/queen/king convention", () => {
    const minorCards = deck.filter((c: TarotCard) => c.arcana === "minor");
    const suitPattern = /^(wands|cups|swords|pentacles)_(\d{2}(_ace)?|page|knight|queen|king)$/;
    for (const card of minorCards) {
      expect(card.id).toMatch(suitPattern);
    }
  });

  it("minor arcana cards numbered 1-14 per suit", () => {
    const suits = ["wands", "cups", "swords", "pentacles"] as const;
    for (const suit of suits) {
      const suitCards = deck.filter((c: TarotCard) => c.suit === suit);
      const numbers = suitCards.map((c: TarotCard) => c.number).sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    }
  });

  it("major arcana cards numbered 0-21", () => {
    const majorCards = deck.filter((c: TarotCard) => c.arcana === "major");
    const numbers = majorCards.map((c: TarotCard) => c.number).sort((a, b) => a - b);
    const expected = Array.from({ length: 22 }, (_, i) => i);
    expect(numbers).toEqual(expected);
  });

  it("every card has at least 2 upright and 2 reversed keywords", () => {
    for (const card of deck) {
      expect(card.keywords_upright.length).toBeGreaterThanOrEqual(2);
      expect(card.keywords_reversed.length).toBeGreaterThanOrEqual(2);
      for (const kw of card.keywords_upright) {
        expect(kw.trim().length).toBeGreaterThan(0);
      }
      for (const kw of card.keywords_reversed) {
        expect(kw.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("every card has meaning_upright and meaning_reversed that are actual sentences (> 20 chars)", () => {
    for (const card of deck) {
      expect(card.meaning_upright.length).toBeGreaterThan(20);
      expect(card.meaning_reversed.length).toBeGreaterThan(20);
    }
  });

  it("every card has a description longer than 20 chars", () => {
    for (const card of deck) {
      expect(card.description.length).toBeGreaterThan(20);
    }
  });

  it("no two cards share the exact same meaning_upright", () => {
    const meanings = deck.map((c: TarotCard) => c.meaning_upright);
    const uniqueMeanings = new Set(meanings);
    expect(uniqueMeanings.size).toBe(deck.length);
  });
});

// ─── Deck Edge Cases ─────────────────────────────────────

describe("Deck Edge Cases", () => {
  it("shuffleDeck on an empty array returns empty array", () => {
    const result = shuffleDeck([]);
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });

  it("shuffleDeck on a single-card array returns that card", () => {
    const deck = createDeck();
    const singleCard = [deck[0]];
    const result = shuffleDeck(singleCard);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(deck[0].id);
  });

  it("drawCards with count=0 returns empty array", () => {
    const deck = shuffleDeck(createDeck());
    const drawn = drawCards(deck, 0);
    expect(drawn).toEqual([]);
    expect(drawn).toHaveLength(0);
  });

  it("two consecutive shuffleDeck calls produce different orders", () => {
    const deck = createDeck();
    const shuffle1 = shuffleDeck(deck);
    const shuffle2 = shuffleDeck(deck);
    const ids1 = shuffle1.map((c: TarotCard) => c.id);
    const ids2 = shuffle2.map((c: TarotCard) => c.id);
    // With 78! possible orderings, identical order is astronomically unlikely
    expect(ids1).not.toEqual(ids2);
  });
});

// ─── Spread Edge Cases ───────────────────────────────────

describe("Spread Edge Cases", () => {
  it("getSpreadNames() returns string array matching spread count", () => {
    const names = getSpreadNames();
    const spreads = getAllSpreads();
    expect(names).toHaveLength(spreads.length);
    for (const name of names) {
      expect(name).toBeTypeOf("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("every spread position has a unique index within its spread", () => {
    const spreads = getAllSpreads();
    for (const spread of spreads) {
      const indices = spread.positions.map((p) => p.index);
      const uniqueIndices = new Set(indices);
      expect(uniqueIndices.size).toBe(spread.positions.length);
    }
  });

  it("position indices are sequential (0, 1, 2, ...)", () => {
    const spreads = getAllSpreads();
    for (const spread of spreads) {
      const indices = spread.positions.map((p) => p.index);
      const expected = Array.from({ length: spread.positions.length }, (_, i) => i);
      expect(indices).toEqual(expected);
    }
  });
});

// ─── TarotEngine Edge Cases ──────────────────────────────

describe("TarotEngine Edge Cases", () => {
  const engine = new TarotEngine();

  it("full reading lifecycle: start -> reveal all -> feedback for each -> synthesize (celtic cross)", () => {
    let state = engine.startReading("celtic_cross", "What does the future hold?");
    expect(state.drawnCards).toHaveLength(10);
    expect(state.revealedIndex).toBe(0);

    // Reveal each card, provide feedback, verify state advances
    for (let i = 0; i < 10; i++) {
      const reveal = engine.getNextReveal(state);
      expect(reveal).not.toBeNull();
      expect(reveal?.card).toBe(state.drawnCards[i]);
      expect(reveal?.position).toBe(state.spread.positions[i]);
      expect(reveal?.prompt.length).toBeGreaterThan(100);

      const feedback: FeedbackEntry = {
        element: state.drawnCards[i].card.name,
        userText: `Card ${i + 1} insight`,
        timestamp: Date.now(),
      };
      state = engine.recordFeedback(state, feedback);
      expect(state.revealedIndex).toBe(i + 1);
      expect(state.userFeedback).toHaveLength(i + 1);
    }

    // All cards revealed
    expect(engine.isComplete(state)).toBe(true);
    expect(engine.getNextReveal(state)).toBeNull();

    // Synthesize
    const synthesis = engine.getSynthesis(state);
    expect(synthesis).toBeTypeOf("string");
    expect(synthesis.length).toBeGreaterThan(100);
    expect(synthesis).toContain("What does the future hold?");
  });

  it("getDeepening returns prompt containing the card name and user response", () => {
    let state = engine.startReading("three_card", "What should I know?");
    const cardName = state.drawnCards[0].card.name;
    const feedback: FeedbackEntry = {
      element: cardName,
      userText: "This is meaningful",
      timestamp: Date.now(),
    };
    state = engine.recordFeedback(state, feedback);

    const deepening = engine.getDeepening(state, 0, "Tell me more about this card");
    expect(deepening).toContain(cardName);
    expect(deepening).toContain("Tell me more about this card");
  });

  it("getDeepening throws RangeError for negative cardIndex", () => {
    let state = engine.startReading("three_card", "test");
    const feedback: FeedbackEntry = {
      element: "card",
      userText: "ok",
      timestamp: Date.now(),
    };
    state = engine.recordFeedback(state, feedback);
    expect(() => engine.getDeepening(state, -1, "response")).toThrow(RangeError);
  });

  it("getDeepening throws Error for unrevealed card index", () => {
    let state = engine.startReading("three_card", "test");
    const feedback: FeedbackEntry = {
      element: "card",
      userText: "ok",
      timestamp: Date.now(),
    };
    state = engine.recordFeedback(state, feedback);
    // Card at index 1 has not been revealed yet (revealedIndex is 1)
    expect(() => engine.getDeepening(state, 1, "response")).toThrow(/not been revealed/);
  });

  it("recordFeedback throws when all cards already revealed", () => {
    let state = engine.startReading("single", "test");
    const feedback: FeedbackEntry = {
      element: "card",
      userText: "yes",
      timestamp: Date.now(),
    };
    state = engine.recordFeedback(state, feedback);
    // All cards revealed, should throw
    expect(() => engine.recordFeedback(state, feedback)).toThrow(/already been revealed/);
  });

  it("getReadingSummary returns correct counts at each phase", () => {
    let state = engine.startReading("three_card", "What lies ahead?");

    // Phase 1: no cards revealed
    let summary = engine.getReadingSummary(state);
    expect(summary.spread).toBe("Past, Present, Future");
    expect(summary.question).toBe("What lies ahead?");
    expect(summary.totalCards).toBe(3);
    expect(summary.revealedCards).toBe(0);
    expect(summary.feedbackCount).toBe(0);
    expect(summary.isComplete).toBe(false);
    expect(summary.cards).toHaveLength(3);
    for (const c of summary.cards) {
      expect(c.revealed).toBe(false);
    }

    // Phase 2: one card revealed
    const feedback: FeedbackEntry = {
      element: state.drawnCards[0].card.name,
      userText: "insight",
      timestamp: Date.now(),
    };
    state = engine.recordFeedback(state, feedback);
    summary = engine.getReadingSummary(state);
    expect(summary.revealedCards).toBe(1);
    expect(summary.feedbackCount).toBe(1);
    expect(summary.isComplete).toBe(false);
    expect(summary.cards[0].revealed).toBe(true);
    expect(summary.cards[1].revealed).toBe(false);

    // Phase 3: all cards revealed
    for (let i = 1; i < 3; i++) {
      state = engine.recordFeedback(state, {
        element: state.drawnCards[i].card.name,
        userText: "ok",
        timestamp: Date.now(),
      });
    }
    summary = engine.getReadingSummary(state);
    expect(summary.revealedCards).toBe(3);
    expect(summary.feedbackCount).toBe(3);
    expect(summary.isComplete).toBe(true);
    for (const c of summary.cards) {
      expect(c.revealed).toBe(true);
      expect(c.position).toBeTypeOf("string");
      expect(c.card).toBeTypeOf("string");
      expect(typeof c.reversed).toBe("boolean");
    }
  });

  it("startReading with allowReversals=false produces no reversed cards in state", () => {
    const state = engine.startReading("celtic_cross", "test", false);
    for (const dc of state.drawnCards) {
      expect(dc.reversed).toBe(false);
    }
  });
});

// ─── Interpreter Prompt Content Verification ─────────────

describe("Interpreter Prompt Content Verification", () => {
  const testCard = getCard("major_00_fool")!;
  const testPosition: SpreadPosition = {
    index: 0,
    name: "Present / Significator",
    description: "The heart of the matter",
  };
  const testQuestion = "What should I focus on this year?";

  const uprightDrawn: DrawnCard = {
    card: testCard,
    reversed: false,
    positionIndex: 0,
  };

  const reversedDrawn: DrawnCard = {
    card: testCard,
    reversed: true,
    positionIndex: 0,
  };

  const sampleFeedback: FeedbackEntry[] = [
    {
      element: "The Magician",
      userText: "That speaks to me",
      timestamp: Date.now(),
    },
  ];

  it("buildCardInterpretationPrompt includes the card name", () => {
    const prompt = buildCardInterpretationPrompt(uprightDrawn, testPosition, testQuestion, []);
    expect(prompt).toContain(testCard.name);
  });

  it("buildCardInterpretationPrompt includes the position name", () => {
    const prompt = buildCardInterpretationPrompt(uprightDrawn, testPosition, testQuestion, []);
    expect(prompt).toContain(testPosition.name);
  });

  it("buildCardInterpretationPrompt includes the question", () => {
    const prompt = buildCardInterpretationPrompt(uprightDrawn, testPosition, testQuestion, []);
    expect(prompt).toContain(testQuestion);
  });

  it("buildCardInterpretationPrompt includes previous feedback when provided", () => {
    const prompt = buildCardInterpretationPrompt(
      uprightDrawn,
      testPosition,
      testQuestion,
      sampleFeedback
    );
    expect(prompt).toContain("The Magician");
    expect(prompt).toContain("That speaks to me");
  });

  it("buildSynthesisPrompt includes all card names", () => {
    const cards: DrawnCard[] = [
      { card: getCard("major_00_fool")!, reversed: false, positionIndex: 0 },
      { card: getCard("major_01_magician")!, reversed: true, positionIndex: 1 },
      {
        card: getCard("major_02_high_priestess")!,
        reversed: false,
        positionIndex: 2,
      },
    ];
    const spread = getSpread("three_card")!;
    const prompt = buildSynthesisPrompt(cards, spread, "test question", []);
    expect(prompt).toContain("The Fool");
    expect(prompt).toContain("The Magician");
    expect(prompt).toContain("The High Priestess");
  });

  it("buildSynthesisPrompt includes the question", () => {
    const cards: DrawnCard[] = [
      { card: getCard("major_00_fool")!, reversed: false, positionIndex: 0 },
    ];
    const spread = getSpread("single")!;
    const prompt = buildSynthesisPrompt(cards, spread, "Am I on the right path?", []);
    expect(prompt).toContain("Am I on the right path?");
  });

  it("buildDeepenPrompt includes the user response text", () => {
    const prompt = buildDeepenPrompt(
      uprightDrawn,
      testPosition,
      testQuestion,
      "I feel strongly about new beginnings"
    );
    expect(prompt).toContain("I feel strongly about new beginnings");
  });

  it("reversed cards produce prompts containing 'REVERSED'", () => {
    const prompt = buildCardInterpretationPrompt(reversedDrawn, testPosition, testQuestion, []);
    expect(prompt).toContain("REVERSED");
  });

  it("upright cards produce prompts containing 'UPRIGHT'", () => {
    const prompt = buildCardInterpretationPrompt(uprightDrawn, testPosition, testQuestion, []);
    expect(prompt).toContain("UPRIGHT");
  });
});
