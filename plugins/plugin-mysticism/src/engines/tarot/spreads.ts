import type { SpreadDefinition } from "../../types";
import spreadsData from "./data/spreads.json";

const allSpreads: SpreadDefinition[] = spreadsData as SpreadDefinition[];

export function getSpread(id: string): SpreadDefinition | undefined {
  return allSpreads.find((spread) => spread.id === id);
}

export function getAllSpreads(): SpreadDefinition[] {
  return [...allSpreads];
}

export function getSpreadNames(): string[] {
  return allSpreads.map((spread) => spread.name);
}
