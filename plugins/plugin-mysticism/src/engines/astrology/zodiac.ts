import aspectsData from "./data/aspects.json" with { type: "json" };
import signsData from "./data/signs.json" with { type: "json" };

export const SIGN_ORDER: readonly string[] = [
  "aries",
  "taurus",
  "gemini",
  "cancer",
  "leo",
  "virgo",
  "libra",
  "scorpio",
  "sagittarius",
  "capricorn",
  "aquarius",
  "pisces",
];

export type ZodiacSign = (typeof SIGN_ORDER)[number];
export type Element = "fire" | "earth" | "air" | "water";
export type Modality = "cardinal" | "fixed" | "mutable";

export interface SignPosition {
  sign: string;
  degrees: number; // 0-29 within sign
  totalDegrees: number; // 0-359 on the ecliptic
}

interface SignData {
  id: string;
  element: string;
  modality: string;
  rulingPlanet: string;
  degreesStart: number;
  degreesEnd: number;
}

const signLookup: Map<string, SignData> = new Map();
for (const s of signsData as SignData[]) {
  signLookup.set(s.id, s);
}

export function degreesToSign(totalDegrees: number): SignPosition {
  // Normalise to [0, 360)
  const deg = ((totalDegrees % 360) + 360) % 360;
  const signIndex = Math.floor(deg / 30);
  const withinSign = deg - signIndex * 30;
  return {
    sign: SIGN_ORDER[signIndex],
    degrees: withinSign,
    totalDegrees: deg,
  };
}

export function getElement(sign: string): Element {
  const data = signLookup.get(sign);
  if (!data) throw new Error(`Unknown sign: ${sign}`);
  return data.element as Element;
}

export function getModality(sign: string): Modality {
  const data = signLookup.get(sign);
  if (!data) throw new Error(`Unknown sign: ${sign}`);
  return data.modality as Modality;
}

export function getRulingPlanet(sign: string): string {
  const data = signLookup.get(sign);
  if (!data) throw new Error(`Unknown sign: ${sign}`);
  return data.rulingPlanet;
}

export function isAspect(
  degrees1: number,
  degrees2: number,
  aspectDegrees: number,
  orb: number
): boolean {
  let diff = Math.abs(degrees1 - degrees2);
  if (diff > 180) diff = 360 - diff;
  return Math.abs(diff - aspectDegrees) <= orb;
}

/** Returns a value in [0, 180]. */
export function angularSeparation(deg1: number, deg2: number): number {
  let diff = Math.abs(deg1 - deg2);
  if (diff > 180) diff = 360 - diff;
  return diff;
}

export function signDisplayName(signId: string): string {
  return signId.charAt(0).toUpperCase() + signId.slice(1);
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

export function getAspectDefinitions(): AspectDefinition[] {
  return aspectsData as AspectDefinition[];
}
