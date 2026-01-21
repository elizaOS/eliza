import type { IsoDateTime } from "./types";

export interface WeightedItem<T> {
  item: T;
  weight: number;
}

export interface Rng {
  next: () => number;
  int: (min: number, max: number) => number;
  bool: (probability: number) => boolean;
  pick: <T>(items: T[]) => T;
  pickWeighted: <T>(items: Array<WeightedItem<T>>) => T;
  shuffle: <T>(items: T[]) => T[];
}

export const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const clampInt = (value: number, min: number, max: number): number => {
  return Math.round(clampNumber(value, min, max));
};

export const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, v) => sum + v, 0);
  return total / values.length;
};

export const unique = <T>(values: T[]): T[] => [...new Set(values)];

export const isoNow = (): IsoDateTime => {
  return new Date().toISOString();
};

export const hashString = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

export const createRng = (seed: number): Rng => {
  let t = seed >>> 0;
  const next = (): number => {
    t += 0x6d2b79f5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (max < min) {
      return min;
    }
    const n = next();
    return Math.floor(n * (max - min + 1)) + min;
  };

  const bool = (probability: number): boolean => {
    return next() < clampNumber(probability, 0, 1);
  };

  const pick = <T>(items: T[]): T => {
    if (items.length === 0) {
      throw new Error("pick called with empty array");
    }
    return items[int(0, items.length - 1)];
  };

  const pickWeighted = <T>(items: Array<WeightedItem<T>>): T => {
    if (items.length === 0) {
      throw new Error("pickWeighted called with empty array");
    }
    const total = items.reduce(
      (sum, item) => sum + Math.max(0, item.weight),
      0,
    );
    if (total <= 0) {
      return items[int(0, items.length - 1)].item;
    }
    let roll = next() * total;
    for (const item of items) {
      roll -= Math.max(0, item.weight);
      if (roll <= 0) {
        return item.item;
      }
    }
    return items[items.length - 1].item;
  };

  const shuffle = <T>(items: T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const temp = out[i];
      out[i] = out[j];
      out[j] = temp;
    }
    return out;
  };

  return { next, int, bool, pick, pickWeighted, shuffle };
};
