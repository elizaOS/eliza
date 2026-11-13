/**
 * Renderer-neutral projection of agent Maps replies, for chat surfaces that
 * draw messages from plain data instead of the React inline widgets
 * (`widgets/maps-card.tsx`): template renderers, native hosts and other
 * mobile shells. It reads the same validated `[MAPSCARD]` specs
 * (`message-maps-parser.ts`) and the `maps-share` confirmation choice that
 * `plugins/plugin-maps/src/action.ts` appends through core's
 * `appendInteractionBlock`.
 *
 * Presentation only: links are shown as text and never opened, stored message
 * text and model context are unchanged, and malformed or out-of-policy markup
 * stays literal text. A share answer is sent as an ordinary chat message, so the
 * agent's confirmation gate still decides; this module only guarantees that one
 * tap sends one exact answer, once, from the newest reply, without discarding
 * the user's unsent draft.
 *
 * This module imports only the import-free parser leaf so hosts can project
 * the pair without the `MessageContent` React graph.
 */

import {
  findMapsCardRegions,
  type MapsCardPlace,
  type MapsCardSpec,
  type MapsTravelMode,
} from "./message-maps-parser";

export function formatMapsDistance(meters: number): string {
  if (meters < 1_000) return `${Math.round(meters)} m`;
  const km = meters / 1_000;
  return `${km >= 100 ? Math.round(km) : Math.round(km * 10) / 10} km`;
}

export function formatMapsDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export const MAPS_TRAVEL_MODE_TEXT: Record<MapsTravelMode, string> = {
  drive: "Driving",
  walk: "Walking",
  bicycle: "Cycling",
  transit: "Transit",
};

/** A Maps card as text: a title, its lines and the provider's attribution
 * (empty when the provider carries none; never fabricated). */
export interface MapsChatTextCard {
  kind: MapsCardSpec["kind"];
  title: string;
  lines: string[];
  attribution: string;
}

export interface MapsShareChoiceOption {
  /** The exact message sent back when chosen. */
  value: string;
  label: string;
}

/** The plugin-maps share gate: exactly two bounded answers sent back verbatim. */
export interface MapsShareChoice {
  id: string;
  options: MapsShareChoiceOption[];
}

export interface MapsChatTextOptions {
  /** Lines of a locate card. A text surface cannot collect device coordinates,
   * so the host says what the user can do instead (and whether it ever sends
   * its location). */
  locateLines?: readonly string[];
}

export const DEFAULT_MAPS_LOCATE_LINES: readonly string[] = [
  "Reply with a place or address.",
];

const placeLine = (place: MapsCardPlace) =>
  place.formattedAddress
    ? `${place.name}, ${place.formattedAddress}`
    : place.name;

/** One validated card as display text. */
export function presentMapsCard(
  card: MapsCardSpec,
  options: MapsChatTextOptions = {},
): MapsChatTextCard {
  switch (card.kind) {
    case "place":
      return {
        kind: card.kind,
        title: card.place.name,
        lines: card.place.formattedAddress ? [card.place.formattedAddress] : [],
        attribution: card.attribution ?? "",
      };
    case "places":
      return {
        kind: card.kind,
        title: `Places for “${card.query}”`,
        lines: card.places.map(placeLine),
        attribution: card.attribution ?? "",
      };
    case "route":
      return {
        kind: card.kind,
        title: `Route to ${card.destination.name}`,
        lines: [
          `From ${card.origin.name}`,
          `${MAPS_TRAVEL_MODE_TEXT[card.travelMode]} · ${formatMapsDistance(card.distanceMeters)} · ${formatMapsDuration(card.durationSeconds)}`,
          ...card.warnings,
        ],
        attribution: card.attribution ?? "",
      };
    case "handoff":
      return {
        kind: card.kind,
        title:
          card.handoffKind === "share"
            ? `Location link for ${card.place.name}`
            : `Directions to ${card.place.name}`,
        lines: [
          ...(card.place.formattedAddress ? [card.place.formattedAddress] : []),
          card.webUri,
        ],
        attribution: "",
      };
    case "locate":
      return {
        kind: card.kind,
        title: "Location needed",
        lines: [...(options.locateLines ?? DEFAULT_MAPS_LOCATE_LINES)],
        attribution: "",
      };
  }
}

const MAPS_SHARE_CHOICE_RE =
  /\[CHOICE:maps-share id=(maps-share-[^\]\s]{1,200})\]\r?\n([\s\S]*?)\r?\n\[\/CHOICE\]/g;
const MAX_SHARE_VALUE = 500;
const MAX_SHARE_LABEL = 80;

/** Parse a `maps-share` choice body: exactly two `value=label` lines. The
 * label never contains `=`, so a place name in the value may. */
export function parseMapsShareChoice(
  id: string,
  body: string,
): MapsShareChoice | null {
  const options = body.split(/\r?\n/).map((line) => {
    const at = line.lastIndexOf("=");
    return at > 0
      ? { value: line.slice(0, at).trim(), label: line.slice(at + 1).trim() }
      : { value: "", label: "" };
  });
  if (
    options.length !== 2 ||
    options.some(
      (option) =>
        !option.value ||
        !option.label ||
        option.value.length > MAX_SHARE_VALUE ||
        option.label.length > MAX_SHARE_LABEL,
    )
  ) {
    return null;
  }
  return { id, options };
}

export interface MapsChatText {
  /** The message prose with valid Maps markup removed. */
  displayText: string;
  cards: MapsChatTextCard[];
  choice: MapsShareChoice | null;
}

/** Replace valid Maps markup with presentation data. A message without any
 * keeps its exact text, including indentation and trailing whitespace. */
export function projectMapsChatText(
  text: string,
  options: MapsChatTextOptions = {},
): MapsChatText {
  const cards: MapsChatTextCard[] = [];
  let choice: MapsShareChoice | null = null;
  let rendered = text;
  const regions = findMapsCardRegions(text);
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    const region = regions[index];
    cards.unshift(presentMapsCard(region.card, options));
    rendered = rendered.slice(0, region.start) + rendered.slice(region.end);
  }
  rendered = rendered.replace(
    MAPS_SHARE_CHOICE_RE,
    (whole, id: string, body: string) => {
      // The question itself stays in the surrounding prose; only its answers
      // become controls. One reply carries at most one share question.
      const parsed = choice ? null : parseMapsShareChoice(id, body);
      if (!parsed) return whole;
      choice = parsed;
      return "";
    },
  );
  const displayText =
    cards.length > 0 || choice
      ? rendered.replace(/\n{3,}/g, "\n\n").trim()
      : rendered;
  return { displayText, cards, choice };
}

/** One transcript message as the host renders it. */
export interface MapsChatMessageInput {
  id: string;
  isAgent: boolean;
  text: string;
}

export interface MapsChatAnswerOption extends MapsShareChoiceOption {
  /** Send this answer. Ignored after the question was answered, or while the
   * host cannot send. */
  choose(): void;
}

export interface MapsChatMessageView {
  displayText: string;
  cards: MapsChatTextCard[];
  /** Answers to offer, or `null` when the reply asks nothing or its question
   * can no longer be answered here. */
  choice: { id: string; options: MapsChatAnswerOption[] } | null;
}

/** What the host supplies to send an answer. */
export interface MapsChatAnswerPort {
  /** Send the exact text as an ordinary user message. A rejection lets the
   * question be answered again. */
  send(text: string): Promise<unknown> | unknown;
  /** False while nothing may be sent: offline, a reply in progress, a
   * connection dialog open, or the surface unmounted. */
  canAnswer(): boolean;
  /** The user's unsent composer text; an answer never replaces it. */
  draft(): string;
  /** Re-render the transcript after the answered state changed. */
  refresh(): void;
  /** Show a short notice to the user. */
  notify(message: string): void;
}

export interface MapsChatAnswerOptions extends MapsChatTextOptions {
  draftNotice?: string;
  failureNotice?: string;
}

export const MAPS_CHAT_DRAFT_NOTICE =
  "Keep or send your chat draft before answering.";
export const MAPS_CHAT_FAILURE_NOTICE = "The answer was not sent.";

export interface MapsChatAnswers {
  /** Views for a transcript in order; `null` for a message without Maps
   * content, which the host renders unchanged. Projection never sends. */
  project(
    messages: readonly MapsChatMessageInput[],
  ): (MapsChatMessageView | null)[];
  /** Whether the question with this view id has been answered here. */
  answered(id: string): boolean;
}

/** Projection and answer state for one transcript surface. Only the newest
 * reply's question can be answered; an older one is history. */
export function createMapsChatAnswers(
  port: MapsChatAnswerPort,
  options: MapsChatAnswerOptions = {},
): MapsChatAnswers {
  const done = new Set<string>();
  async function answer(id: string, value: string): Promise<void> {
    if (done.has(id) || !port.canAnswer()) return;
    if (port.draft().trim()) {
      port.notify(options.draftNotice ?? MAPS_CHAT_DRAFT_NOTICE);
      return;
    }
    done.add(id);
    port.refresh();
    try {
      await port.send(value);
    } catch (error) {
      done.delete(id);
      port.refresh();
      port.notify(
        error instanceof Error && error.message
          ? error.message
          : (options.failureNotice ?? MAPS_CHAT_FAILURE_NOTICE),
      );
    }
  }
  return {
    answered: (id) => done.has(id),
    project(messages) {
      return messages.map((message, index) => {
        if (!message.isAgent) return null;
        const parsed = projectMapsChatText(message.text, options);
        if (parsed.cards.length === 0 && !parsed.choice) return null;
        const id = parsed.choice ? `${message.id}:${parsed.choice.id}` : "";
        const open =
          !!parsed.choice && index === messages.length - 1 && !done.has(id);
        return {
          displayText: parsed.displayText,
          cards: parsed.cards,
          choice:
            open && parsed.choice
              ? {
                  id,
                  options: parsed.choice.options.map((option) => ({
                    ...option,
                    choose: () => void answer(id, option.value),
                  })),
                }
              : null,
        };
      });
    },
  };
}
