/**
 * Choosing one place from a typed name, and remembering an open "which one did
 * you mean?" question so the owner's reply ("the first one") binds to it.
 *
 * Cloud Maps places carry a name, an address and a coordinate in the
 * provider's own relevance order, and no confidence score. So a place counts
 * as meant when the provider ranked it first, it is named what was asked, no
 * same-named branch stands nearby (a chain: "Starbucks"), and the candidates
 * around it outnumber far-away namesakes. The places Google returns for "Ferry
 * Building" are the building, its marketplace, its farmers market and other
 * parts of the same landmark; they are not a question for the owner. Nor
 * are the park and the neighbourhood Google also names "Golden Gate Park":
 * two same-named areas, neither at a street address, are one landmark.
 */

import type { PlaceRef, TravelMode } from "./types.js";

/** Great-circle distance in metres between two points on the Earth. */
export function metersBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.latitude - a.latitude) * rad) / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(((b.longitude - a.longitude) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Two results this close are one site reported twice. */
const SAME_SITE_METERS = 300;
/** A differently named result this close to a not-exact top match is a rival. */
const SAME_COMPLEX_METERS = 1_000;
/** Same-named results this close are branches of one chain in one area. */
const BRANCH_AREA_METERS = 50_000;
/** Same-named areas this close, neither at a street address, are one landmark. */
const LANDMARK_AREA_METERS = 5_000;
/** The top result's own area. */
const AREA_METERS = 25_000;
/** Around a known other route endpoint, only these candidates are local. */
const LOCAL_METERS = 100_000;

/** "The Ferry Building!" and "ferry building" compare equal. */
export function placeNameKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the\s+/u, "");
}

/** "Ferry Building, San Francisco", "Golden Gate Park in SF": the name part. */
function queryKeys(query: string): string[] {
  const head = query.split(",")[0] ?? query;
  const keys = [placeNameKey(head)];
  const named = /^(.+?)\s+(?:in|near|at|by)\s+\S/iu.exec(head)?.[1];
  if (named) keys.push(placeNameKey(named));
  return keys.filter((key) => key.length > 0);
}

/**
 * True when the provider gives a place as an area, not a street address: "San
 * Francisco, CA, USA" (the park) or "Golden Gate Park, San Francisco, CA, USA"
 * (the neighbourhood), never "1 Market St, ..." (a Starbucks). A place with no
 * address is not known to be an area.
 */
function isArea(place: PlaceRef): boolean {
  const address = place.formattedAddress?.trim();
  return !!address && !/(?:^|,)\s*\d+[\p{L}]?(?:[-/]\d+)?\s+\S/u.test(address);
}

function contains(name: string, key: string): boolean {
  return ` ${name} `.includes(` ${key} `);
}

function qualifiedPlaces(
  query: string,
  places: readonly PlaceRef[],
): PlaceRef[] | undefined {
  const qualifiers = [
    /^([^,]+),\s*(.+)$/u.exec(query),
    /^(.+)\s+in\s+(.+)$/iu.exec(query),
  ].flatMap((match) => {
    const name = placeNameKey(match?.[1] ?? "");
    const locality = placeNameKey(match?.[2] ?? "");
    return name && locality ? [{ name, locality }] : [];
  });
  if (qualifiers.length === 0) return undefined;

  const fullQuery = placeNameKey(query);
  return places.filter((place) => {
    const name = placeNameKey(place.name);
    const address = place.formattedAddress ?? "";
    const locality = placeNameKey(address.replace(/^\s*\d[^,]*,\s*/u, ""));
    return (
      name === fullQuery ||
      contains(placeNameKey(address), fullQuery) ||
      qualifiers.some(
        (qualifier) =>
          contains(name, qualifier.name) &&
          contains(locality, qualifier.locality),
      )
    );
  });
}

/**
 * The one place a query means when the provider's answer leaves no real
 * choice, else `undefined` (ask). `anchor` is the other route endpoint: a
 * destination without an explicit locality is looked for around the origin first.
 */
export function dominantPlace(
  query: string,
  places: readonly PlaceRef[],
  anchor?: { latitude: number; longitude: number },
): PlaceRef | undefined {
  const qualified = qualifiedPlaces(query, places);
  const candidates = qualified ?? places;
  // A lone result is the place meant: a provider answers "SFO" with "San
  // Francisco International Airport" and a typo with the spelled place.
  if (candidates.length <= 1) return candidates[0];
  const local =
    qualified === undefined && anchor
      ? candidates.filter(
          (place) => metersBetween(anchor, place.coordinates) <= LOCAL_METERS,
        )
      : [];
  const pool = local.length > 0 ? local : candidates;
  const [first, ...rest] = pool;
  if (!first) return undefined;
  const away = (place: PlaceRef) =>
    metersBetween(first.coordinates, place.coordinates);
  const keys = queryKeys(query);
  const exact = (place: PlaceRef) => keys.includes(placeNameKey(place.name));
  const matches = (place: PlaceRef) =>
    keys.some((key) => contains(placeNameKey(place.name), key));
  if (!matches(first)) return undefined;
  if (rest.every((place) => away(place) <= SAME_SITE_METERS)) return first;
  const firstName = placeNameKey(first.name);
  // Another branch of the same name in the same area: "Starbucks". A
  // same-named area beside an area top result is the same landmark.
  if (
    rest.some(
      (place) =>
        placeNameKey(place.name) === firstName &&
        away(place) > SAME_SITE_METERS &&
        away(place) <= BRANCH_AREA_METERS &&
        !(
          isArea(first) &&
          isArea(place) &&
          away(place) <= LANDMARK_AREA_METERS
        ),
    )
  )
    return undefined;
  // A top result that only contains the words ("Blue Bottle Coffee" for
  // "coffee") is meant only when no other match stands elsewhere.
  if (
    !exact(first) &&
    rest.some((place) => matches(place) && away(place) > SAME_COMPLEX_METERS)
  )
    return undefined;
  // Far-away namesakes are fewer than the results around the top one.
  const around = pool.filter((place) => away(place) <= AREA_METERS).length;
  return around * 2 > pool.length ? first : undefined;
}

const ORDINALS: Record<string, number> = {
  first: 1,
  "1st": 1,
  one: 1,
  second: 2,
  "2nd": 2,
  two: 2,
  third: 3,
  "3rd": 3,
  three: 3,
  fourth: 4,
  "4th": 4,
  four: 4,
  fifth: 5,
  "5th": 5,
  five: 5,
  sixth: 6,
  "6th": 6,
  six: 6,
  seventh: 7,
  "7th": 7,
  seven: 7,
  eighth: 8,
  "8th": 8,
  eight: 8,
  ninth: 9,
  "9th": 9,
  nine: 9,
  tenth: 10,
  "10th": 10,
  ten: 10,
};

const CHOICE_REPLY =
  /^\s*(?:(?:yes|yeah|yep|ok(?:ay)?|sure|um+|uh+|so|hmm+|let'?s\s+(?:go\s+with|do)|i\s+(?:meant?|want|mean)|go\s+with|pick|choose|use|take)[,\s]+)*(?:(?:the|number|no\.?|#|option|item)\s*)*(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|one|two|three|four|five|six|seven|eight|nine|ten|last|top|\d{1,2})(?:\s+(?:one|option|place|result|choice))?(?:[,\s]+(?:one|please|thanks|thank\s+you))*\s*[.!?]*\s*$/iu;

/**
 * The 0-based choice a short reply names ("the first one", "2", "number
 * three", "the last one"), or `undefined` when the reply is not a choice or
 * names none of `count` options.
 */
export function choiceIndex(
  reply: string | undefined,
  count: number,
): number | undefined {
  if (!reply || reply.length > 60) return undefined;
  const word = CHOICE_REPLY.exec(reply)?.[1]?.toLowerCase();
  // "the one" names no position; "one" and "number one" do.
  if (!word || (word === "one" && /\bthe\s+one\b/iu.test(reply)))
    return undefined;
  const position =
    word === "last"
      ? count
      : word === "top"
        ? 1
        : /^\d+$/u.test(word)
          ? Number(word)
          : ORDINALS[word];
  return position !== undefined && position >= 1 && position <= count
    ? position - 1
    : undefined;
}

export type PlaceChoiceField =
  | "originQuery"
  | "destinationQuery"
  | "placeQuery";

/** The Maps operation that asked: a MAPS subaction or phone navigation. */
export type PlaceChoiceOperation =
  | "route"
  | "select"
  | "save"
  | "share"
  | "navigate"
  | "navigation-start";

/** Promoted action each asking operation continues through. */
export const PLACE_CHOICE_ACTIONS: Record<PlaceChoiceOperation, string> = {
  route: "MAPS_ROUTE",
  select: "MAPS_SELECT",
  save: "MAPS_SAVE",
  share: "MAPS_SHARE",
  navigate: "MAPS_NAVIGATE",
  "navigation-start": "MAPS_NAVIGATION_START",
};

/** One open "which one did you mean?" question in one owner conversation. */
export interface PendingPlaceChoice {
  operation: PlaceChoiceOperation;
  /** The field the question is about; the next choice binds to it. */
  field: PlaceChoiceField;
  /** The words searched for that field. */
  query: string;
  /** The numbered options, in the order the owner saw them. */
  places: PlaceRef[];
  /** Every field's request words, so a continuation needs none restated. */
  queries: Partial<Record<PlaceChoiceField, string>>;
  resolved: Partial<Record<PlaceChoiceField, PlaceRef>>;
  travelMode?: TravelMode;
  expiresAt: number;
}

/** A question left unanswered this long is no longer the one a reply means. */
export const PLACE_CHOICE_TTL_MS = 10 * 60_000;
const MAX_OPEN_CHOICES = 256;

/** The owner turn a scope names, when the caller passes a message. */
type ChoiceScope = { id?: unknown; roomId?: unknown; entityId?: unknown };

interface OpenChoice {
  choice: PendingPlaceChoice;
  /** The owner turn whose request asked the question. */
  askedBy?: string;
  /** The next owner turn after it: the only one that can answer it. */
  answeredBy?: string;
}

/**
 * Open place questions, one per owner conversation (room and entity). A
 * question is answered by the owner's next turn or not at all: once the owner
 * has moved on ("call mom"), a later "the first one" answers whatever the
 * agent asked since (a contact, an email), not this question.
 */
export class PlaceChoices {
  private readonly open = new Map<string, OpenChoice>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(scope: ChoiceScope): string {
    return `${String(scope.roomId)}\u0000${String(scope.entityId)}`;
  }

  get(scope: ChoiceScope): PendingPlaceChoice | undefined {
    const key = this.key(scope);
    const entry = this.open.get(key);
    if (!entry) return undefined;
    if (entry.choice.expiresAt <= this.now()) {
      this.open.delete(key);
      return undefined;
    }
    const turn = typeof scope.id === "string" ? scope.id : undefined;
    if (turn !== undefined && entry.askedBy !== undefined) {
      if (turn === entry.askedBy || turn === entry.answeredBy)
        return entry.choice;
      if (entry.answeredBy === undefined) {
        entry.answeredBy = turn;
        return entry.choice;
      }
      // A later turn: the owner did not answer when asked.
      this.open.delete(key);
      return undefined;
    }
    return entry.choice;
  }

  set(scope: ChoiceScope, choice: Omit<PendingPlaceChoice, "expiresAt">): void {
    const key = this.key(scope);
    this.open.delete(key);
    if (this.open.size >= MAX_OPEN_CHOICES) {
      const oldest = this.open.keys().next().value;
      if (oldest !== undefined) this.open.delete(oldest);
    }
    this.open.set(key, {
      choice: { ...choice, expiresAt: this.now() + PLACE_CHOICE_TTL_MS },
      ...(typeof scope.id === "string" ? { askedBy: scope.id } : {}),
    });
  }

  clear(scope: ChoiceScope): void {
    this.open.delete(this.key(scope));
  }
}

/** "Ferry Building — One Ferry Building, San Francisco" or the name alone. */
export function placeLabel(place: PlaceRef): string {
  return place.formattedAddress
    ? `${place.name} — ${place.formattedAddress}`
    : place.name;
}

/**
 * The option the owner picks from an open question: an
 * ordinal ("the first one"), the option's own label or name, or its id.
 */
export function chosenPlace(
  choice: PendingPlaceChoice,
  reply: string | undefined,
): PlaceRef | undefined {
  const index = choiceIndex(reply, choice.places.length);
  if (index !== undefined) return choice.places[index];
  if (!reply) return undefined;
  const key = placeNameKey(reply);
  const byLabel = choice.places.filter(
    (place) =>
      place.providerPlaceId === reply ||
      placeNameKey(placeLabel(place)) === key,
  );
  if (byLabel.length === 1) return byLabel[0];
  const byName = choice.places.filter(
    (place) => placeNameKey(place.name) === key,
  );
  return byName.length === 1 ? byName[0] : undefined;
}
