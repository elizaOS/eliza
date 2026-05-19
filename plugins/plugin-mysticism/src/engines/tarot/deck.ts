import { webcrypto } from "node:crypto";
import type { DrawnCard, TarotCard } from "../../types";
import cardsData from "./data/cards.json";

const allCards: TarotCard[] = cardsData as TarotCard[];

function secureRandom32(): number {
  const buf = new Uint32Array(1);
  webcrypto.getRandomValues(buf);
  return buf[0];
}

function secureRandomFloat(): number {
  return secureRandom32() / 0x100000000;
}

export function shuffleDeck(cards: TarotCard[]): TarotCard[] {
  const shuffled = [...cards];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(secureRandomFloat() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = temp;
  }
  return shuffled;
}

export function drawCards(deck: TarotCard[], count: number, allowReversals = true): DrawnCard[] {
  if (count > deck.length) {
    throw new RangeError(`Cannot draw ${count} cards from a deck of ${deck.length}`);
  }
  if (count < 0) {
    throw new RangeError("Card count must be non-negative");
  }

  const drawn: DrawnCard[] = [];
  for (let i = 0; i < count; i++) {
    const reversed = allowReversals ? secureRandomFloat() < 0.5 : false;
    drawn.push({ card: deck[i], reversed, positionIndex: i });
  }
  return drawn;
}

export function createDeck(): TarotCard[] {
  return [...allCards];
}

export function getCard(id: string): TarotCard | undefined {
  return allCards.find((card) => card.id === id);
}

export function filterCards(filter: {
  arcana?: "major" | "minor";
  suit?: "wands" | "cups" | "swords" | "pentacles";
}): TarotCard[] {
  return allCards.filter((card) => {
    if (filter.arcana !== undefined && card.arcana !== filter.arcana) {
      return false;
    }
    if (filter.suit !== undefined && card.suit !== filter.suit) {
      return false;
    }
    return true;
  });
}
