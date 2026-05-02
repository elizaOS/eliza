/** UUID type from ElizaOS core */
export type UUID = string;

export interface FeedbackEntry {
  element: string;
  userText: string;
  timestamp: number;
}

export type ReadingPhase = "intake" | "casting" | "interpretation" | "synthesis" | "closing";

export type ReadingSystem = "tarot" | "iching" | "astrology";

export interface PaymentRecord {
  id: string;
  entityId: string;
  amount: string;
  currency: string;
  system: ReadingSystem;
  timestamp: number;
  status: "pending" | "completed" | "refunded";
}

export interface TarotCard {
  id: string;
  name: string;
  number: number;
  arcana: "major" | "minor";
  suit: "wands" | "cups" | "swords" | "pentacles" | null;
  keywords_upright: string[];
  keywords_reversed: string[];
  meaning_upright: string;
  meaning_reversed: string;
  description: string;
  element: string;
  planet: string | null;
  zodiac: string | null;
  numerology: number;
}

export interface DrawnCard {
  card: TarotCard;
  reversed: boolean;
  positionIndex: number;
}

export interface SpreadPosition {
  index: number;
  name: string;
  description: string;
}

export interface SpreadDefinition {
  id: string;
  name: string;
  description: string;
  positions: SpreadPosition[];
  cardCount: number;
}

export interface TarotReadingState {
  spread: SpreadDefinition;
  drawnCards: DrawnCard[];
  revealedIndex: number;
  question: string;
  userFeedback: FeedbackEntry[];
}

export interface Trigram {
  number: number;
  name: string;
  englishName: string;
  character: string;
  binary: string;
  lines: number[];
  attribute: string;
  image: string;
  family: string;
  element: string;
  direction: string;
  bodyPart: string;
}

export interface HexagramLine {
  position: number;
  text: string;
  meaning: string;
}

export interface Hexagram {
  number: number;
  name: string;
  englishName: string;
  character: string;
  binary: string;
  topTrigram: number;
  bottomTrigram: number;
  judgment: string;
  image: string;
  lines: HexagramLine[];
  keywords: string[];
  description: string;
}

export interface CastResult {
  lines: number[];
  changingLines: number[];
  hexagramNumber: number;
  transformedHexagramNumber: number | null;
  binary: string;
  transformedBinary: string | null;
}

export interface IChingReadingState {
  question: string;
  castResult: CastResult;
  hexagram: Hexagram;
  transformedHexagram: Hexagram | null;
  revealedLines: number;
  userFeedback: FeedbackEntry[];
}

export interface BirthData {
  year: number;
  month: number;
  day: number | null;
  hour: number | null;
  minute: number | null;
  latitude: number | null;
  longitude: number | null;
  timezone: number | null;
}

export interface PlanetPosition {
  planet: string;
  sign: string;
  degrees: number;
  totalDegrees: number;
  house: number;
  retrograde: boolean;
}

export interface SignPosition {
  sign: string;
  degrees: number;
  totalDegrees: number;
}

export interface ChartAspect {
  planet1: string;
  planet2: string;
  aspectName: string;
  aspectSymbol: string;
  exactDegrees: number;
  actualDegrees: number;
  orb: number;
  nature: "harmonious" | "challenging" | "neutral";
}

export interface ZodiacSign {
  id: string;
  name: string;
  symbol: string;
  element: "fire" | "earth" | "air" | "water";
  modality: "cardinal" | "fixed" | "mutable";
  rulingPlanet: string;
  dateRange: { start: { month: number; day: number }; end: { month: number; day: number } };
  traits: string[];
  shadow: string[];
  keywords: string[];
  description: string;
  houseNatural: number;
  degreesStart: number;
  degreesEnd: number;
}

export interface Planet {
  id: string;
  name: string;
  symbol: string;
  keywords: string[];
  description: string;
  dignities: {
    domicile: string;
    exaltation: string;
    detriment: string;
    fall: string;
  };
  meaningsInSigns: Record<string, string>;
}

export interface House {
  number: number;
  name: string;
  alias: string;
  keywords: string[];
  naturalSign: string;
  naturalRuler: string;
  description: string;
  lifeAreas: string[];
}

export interface AspectDefinition {
  id: string;
  name: string;
  symbol: string;
  degrees: number;
  orb: number;
  nature: "harmonious" | "challenging" | "neutral";
  keywords: string[];
  description: string;
}

export interface NatalChart {
  sun: PlanetPosition;
  moon: PlanetPosition;
  mercury: PlanetPosition;
  venus: PlanetPosition;
  mars: PlanetPosition;
  jupiter: PlanetPosition;
  saturn: PlanetPosition;
  uranus: PlanetPosition;
  neptune: PlanetPosition;
  pluto: PlanetPosition;
  ascendant: SignPosition;
  midheaven: SignPosition;
  aspects: ChartAspect[];
  houseCusps: number[];
}

export interface AstrologyReadingState {
  birthData: BirthData;
  chart: NatalChart;
  revealedPlanets: string[];
  revealedHouses: string[];
  userFeedback: FeedbackEntry[];
}

export interface ReadingSession {
  id: string;
  entityId: string;
  roomId: string;
  type: ReadingSystem;
  phase: ReadingPhase;
  tarot?: TarotReadingState;
  iching?: IChingReadingState;
  astrology?: AstrologyReadingState;
  paymentStatus: "none" | "requested" | "paid";
  paymentAmount: string | null;
  paymentTxHash: string | null;
  createdAt: number;
  updatedAt: number;
  meta: Record<string, string | number | boolean>;
}

export interface CrisisIndicators {
  detected: boolean;
  severity: "low" | "medium" | "high";
  keywords: string[];
  recommendedAction: string;
}

export interface FormControlOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormControl {
  key: string;
  type: string;
  label: string;
  description?: string;
  required?: boolean;
  ask?: string;
  hint?: string[];
  example?: string;
  default?: string | number | boolean;
  minLength?: number;
  maxLength?: number;
  options?: FormControlOption[];
  pattern?: string;
}

export interface FormDefinition {
  id: string;
  name: string;
  description?: string;
  controls: FormControl[];
  onSubmit?: string;
  onCancel?: string;
  ttl?: { minDays?: number; maxDays?: number };
  nudgeAfterMinutes?: number;
  nudgeMessage?: string;
}
