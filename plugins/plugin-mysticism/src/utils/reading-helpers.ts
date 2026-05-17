import type { ReadingSession } from "../types";

export function getCurrentElement(session: ReadingSession): string {
  if (session.tarot) {
    const idx = session.tarot.revealedIndex;
    if (idx > 0 && idx <= session.tarot.drawnCards.length) {
      const card = session.tarot.drawnCards[idx - 1];
      const position = session.tarot.spread.positions[idx - 1];
      return `${card.card.name} in ${position.name}`;
    }
    if (idx === 0 && session.tarot.drawnCards.length > 0) {
      return "spread introduction";
    }
    return "tarot synthesis";
  }

  if (session.iching) {
    const revealed = session.iching.revealedLines;
    const changing = session.iching.castResult.changingLines;
    if (revealed === 0) {
      return `Hexagram ${session.iching.hexagram.number}: ${session.iching.hexagram.englishName}`;
    }
    if (revealed <= changing.length) {
      const sorted = [...changing].sort((a, b) => a - b);
      return `Line ${sorted[revealed - 1]} of ${session.iching.hexagram.englishName}`;
    }
    return "I Ching synthesis";
  }

  if (session.astrology) {
    const revealed = session.astrology.revealedPlanets;
    if (revealed.length > 0) {
      const lastPlanet = revealed[revealed.length - 1];
      return `${lastPlanet.charAt(0).toUpperCase() + lastPlanet.slice(1)} placement`;
    }
    return "chart overview";
  }

  return session.type;
}
