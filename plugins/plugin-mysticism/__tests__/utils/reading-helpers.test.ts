import { describe, expect, it } from "vitest";
import { MysticismService } from "../../src/services/mysticism-service";
import type { BirthData, ReadingSession } from "../../src/types";
import { getCurrentElement } from "../../src/utils/reading-helpers";

// ─── Test Fixtures ───────────────────────────

const ENTITY = "entity-helper-test";
const ROOM = "room-helper-test";

const FULL_BIRTH_DATA: BirthData = {
  year: 1990,
  month: 6,
  day: 15,
  hour: 12,
  minute: 0,
  latitude: 40.7,
  longitude: -74.0,
  timezone: -5,
};

describe("getCurrentElement", () => {
  // ─── Tarot Branches ───────────────────────────

  describe("tarot system", () => {
    it("returns 'spread introduction' when revealedIndex=0 with drawn cards", () => {
      const service = new MysticismService();
      const session = service.startTarotReading(ENTITY, ROOM, "three_card", "test question");

      // At start, revealedIndex=0 and drawnCards has 3 cards
      expect(session.tarot).toBeDefined();
      expect(session.tarot?.revealedIndex).toBe(0);
      expect(session.tarot?.drawnCards.length).toBe(3);

      const result = getCurrentElement(session);
      expect(result).toBe("spread introduction");
    });

    it("returns 'CardName in PositionName' when revealedIndex=1 with cards", () => {
      const service = new MysticismService();
      service.startTarotReading(ENTITY, ROOM, "three_card", "test question");

      // Reveal the first card by getting reveal and recording feedback
      const reveal = service.getNextReveal(ENTITY, ROOM);
      expect(reveal).not.toBeNull();
      service.recordFeedback(ENTITY, ROOM, {
        element: reveal?.element,
        userText: "interesting",
        timestamp: Date.now(),
      });

      const session = service.getSession(ENTITY, ROOM)!;
      expect(session.tarot?.revealedIndex).toBe(1);

      const result = getCurrentElement(session);
      // Should be "CardName in PositionName" for the first revealed card
      const expectedCard = session.tarot?.drawnCards[0].card.name;
      const expectedPosition = session.tarot?.spread.positions[0].name;
      expect(result).toBe(`${expectedCard} in ${expectedPosition}`);
    });

    it("returns last card when revealedIndex equals drawnCards.length", () => {
      const service = new MysticismService();
      service.startTarotReading(ENTITY, ROOM, "three_card", "career growth");

      // Reveal all 3 cards
      for (let i = 0; i < 3; i++) {
        const reveal = service.getNextReveal(ENTITY, ROOM);
        expect(reveal).not.toBeNull();
        service.recordFeedback(ENTITY, ROOM, {
          element: reveal?.element,
          userText: `Feedback ${i}`,
          timestamp: Date.now(),
        });
      }

      const session = service.getSession(ENTITY, ROOM)!;
      expect(session.tarot?.revealedIndex).toBe(3);
      expect(session.tarot?.drawnCards.length).toBe(3);

      // revealedIndex=3 still satisfies idx <= drawnCards.length, returns last card
      const result = getCurrentElement(session);
      const lastCard = session.tarot?.drawnCards[2].card.name;
      const lastPos = session.tarot?.spread.positions[2].name;
      expect(result).toBe(`${lastCard} in ${lastPos}`);
    });

    it("returns 'tarot synthesis' when revealedIndex exceeds drawnCards.length", () => {
      // The synthesis branch only triggers when revealedIndex > drawnCards.length.
      // This can't happen via normal service flow, so construct manually.
      const service = new MysticismService();
      const session = service.startTarotReading(ENTITY, ROOM, "single", "test");

      // Manually push revealedIndex beyond drawnCards.length
      session.tarot!.revealedIndex = session.tarot?.drawnCards.length + 1;

      const result = getCurrentElement(session);
      expect(result).toBe("tarot synthesis");
    });
  });

  // ─── I Ching Branches ───────────────────────────

  describe("iching system", () => {
    it("returns 'Hexagram N: EnglishName' when revealedLines=0", () => {
      const service = new MysticismService();
      const session = service.startIChingReading(ENTITY, ROOM, "life direction");

      expect(session.iching).toBeDefined();
      expect(session.iching?.revealedLines).toBe(0);

      const result = getCurrentElement(session);
      const hex = session.iching?.hexagram;
      expect(result).toBe(`Hexagram ${hex.number}: ${hex.englishName}`);
    });

    it("returns 'Line X of EnglishName' when revealing changing lines", () => {
      const service = new MysticismService();

      // We need a session with changing lines. Since castHexagram is random,
      // keep starting until we get one with at least 2 changing lines.
      let session: ReadingSession;
      let attempts = 0;
      do {
        service.startIChingReading(ENTITY, ROOM, "test question");
        session = service.getSession(ENTITY, ROOM)!;
        attempts++;
      } while (session.iching?.castResult.changingLines.length < 2 && attempts < 200);

      if (session.iching?.castResult.changingLines.length < 2) {
        // Extremely unlikely but skip if no changing lines after many attempts
        return;
      }

      // Reveal one line via the service
      const reveal = service.getNextReveal(ENTITY, ROOM);
      expect(reveal).not.toBeNull();
      service.recordFeedback(ENTITY, ROOM, {
        element: reveal?.element,
        userText: "resonates",
        timestamp: Date.now(),
      });

      const updated = service.getSession(ENTITY, ROOM)!;
      expect(updated.iching?.revealedLines).toBe(1);

      const result = getCurrentElement(updated);
      const sorted = [...(updated.iching?.castResult.changingLines ?? [])].sort((a, b) => a - b);
      const expectedLine = sorted[0]; // first revealed is sorted[revealedLines-1] = sorted[0]
      expect(result).toBe(`Line ${expectedLine} of ${updated.iching?.hexagram.englishName}`);
    });

    it("returns 'I Ching synthesis' when revealedLines > changingLines", () => {
      const service = new MysticismService();

      // Start readings until we get one with at least 1 changing line
      let session: ReadingSession;
      let attempts = 0;
      do {
        service.startIChingReading(ENTITY, ROOM, "synthesis test");
        session = service.getSession(ENTITY, ROOM)!;
        attempts++;
      } while (session.iching?.castResult.changingLines.length < 1 && attempts < 200);

      if (session.iching?.castResult.changingLines.length < 1) {
        return;
      }

      const changingCount = session.iching?.castResult.changingLines.length;

      // Reveal all changing lines
      for (let i = 0; i < changingCount; i++) {
        const reveal = service.getNextReveal(ENTITY, ROOM);
        if (!reveal) break;
        service.recordFeedback(ENTITY, ROOM, {
          element: reveal.element,
          userText: `feedback ${i}`,
          timestamp: Date.now(),
        });
      }

      const updated = service.getSession(ENTITY, ROOM)!;
      // revealedLines should now equal changingLines.length (or more),
      // which means revealed > changingLines.length (synthesis)
      // Actually the engine increments revealedLines by 1 per feedback.
      // getNextReveal returns null when revealedLines >= changingLines.length.
      // But getCurrentElement checks: if revealed <= changing.length → line;
      //   else → synthesis.
      // After revealing all, revealedLines == changingCount.
      // The condition is: if (revealed <= changing.length) → still in line territory
      // So we need revealedLines > changing.length. Let's record one more feedback
      // manually to push it past.
      // Wait, let me re-read the code:
      //   if (revealed === 0) → hexagram
      //   if (revealed <= changing.length) → line
      //   else → synthesis
      // When revealedLines == changingCount and changingCount >= 1, that's
      // revealed <= changing.length, so it would try to show a line.
      // But sorted[revealedLines - 1] = sorted[changingCount - 1] — that's
      // the last changing line. So with revealedLines == changingCount,
      // it still shows a line. We need revealedLines > changingCount.
      //
      // The engine's recordFeedback increments revealedLines.
      // After revealing all lines, getNextReveal returns null.
      // But we can still record feedback to push revealedLines past changingLines.length.
      // Actually let's just call recordFeedback one more time.
      service.recordFeedback(ENTITY, ROOM, {
        element: "final",
        userText: "synthesis time",
        timestamp: Date.now(),
      });

      const synth = service.getSession(ENTITY, ROOM)!;
      expect(synth.iching?.revealedLines).toBeGreaterThan(
        synth.iching?.castResult.changingLines.length
      );

      const result = getCurrentElement(synth);
      expect(result).toBe("I Ching synthesis");
    });
  });

  // ─── Astrology Branches ───────────────────────────

  describe("astrology system", () => {
    it("returns 'Planet placement' when revealedPlanets has entries", () => {
      const service = new MysticismService();
      service.startAstrologyReading(ENTITY, ROOM, FULL_BIRTH_DATA);

      // First getNextReveal returns the overview, second returns a planet
      const overview = service.getNextReveal(ENTITY, ROOM);
      expect(overview).not.toBeNull();
      service.recordFeedback(ENTITY, ROOM, {
        element: overview?.element,
        userText: "tell me more",
        timestamp: Date.now(),
      });

      const planetReveal = service.getNextReveal(ENTITY, ROOM);
      expect(planetReveal).not.toBeNull();
      service.recordFeedback(ENTITY, ROOM, {
        element: planetReveal?.element,
        userText: "fascinating",
        timestamp: Date.now(),
      });

      const session = service.getSession(ENTITY, ROOM)!;
      expect(session.astrology).toBeDefined();
      expect(session.astrology?.revealedPlanets.length).toBeGreaterThan(0);

      const result = getCurrentElement(session);
      const lastPlanet =
        session.astrology?.revealedPlanets[session.astrology?.revealedPlanets.length - 1];
      const capitalized = lastPlanet.charAt(0).toUpperCase() + lastPlanet.slice(1);
      expect(result).toBe(`${capitalized} placement`);
    });

    it("returns 'chart overview' when revealedPlanets is empty", () => {
      const service = new MysticismService();
      const session = service.startAstrologyReading(ENTITY, ROOM, FULL_BIRTH_DATA);

      // Right after start, revealedPlanets is empty
      expect(session.astrology).toBeDefined();
      expect(session.astrology?.revealedPlanets).toEqual([]);

      const result = getCurrentElement(session);
      expect(result).toBe("chart overview");
    });
  });

  // ─── Fallback Branch ───────────────────────────

  describe("fallback", () => {
    it("returns session.type when no system-specific state exists", () => {
      // Construct a minimal ReadingSession with no tarot/iching/astrology
      const bareSession: ReadingSession = {
        id: "bare-session",
        entityId: ENTITY,
        roomId: ROOM,
        type: "tarot",
        phase: "intake",
        paymentStatus: "none",
        paymentAmount: null,
        paymentTxHash: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        meta: {},
      };

      const result = getCurrentElement(bareSession);
      expect(result).toBe("tarot");
    });

    it("returns 'iching' for bare iching session", () => {
      const bareSession: ReadingSession = {
        id: "bare-iching",
        entityId: ENTITY,
        roomId: ROOM,
        type: "iching",
        phase: "intake",
        paymentStatus: "none",
        paymentAmount: null,
        paymentTxHash: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        meta: {},
      };

      const result = getCurrentElement(bareSession);
      expect(result).toBe("iching");
    });
  });
});
