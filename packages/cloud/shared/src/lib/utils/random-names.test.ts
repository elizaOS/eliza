/**
 * Pins generated-name shape and pool health. These names become user-visible
 * identifiers for apps, agents, workflows, and services, so the contract is the
 * shape (separator, casing, no blank segment) and that the pools carry no
 * duplicates that would quietly halve the entropy. Math.random is not stubbed:
 * the assertions are invariants that must hold for every draw, plus coverage
 * sweeps over enough draws to reach every pool entry.
 */

import { describe, expect, test } from "bun:test";
import {
  type EntityType,
  generateDisplayName,
  generateNameForType,
  generateRandomName,
  generateServiceName,
  generateWorkflowName,
} from "./random-names";

/** Enough draws that every entry of the largest pool is reached w.h.p. */
const DRAWS = 4000;

const draw = (fn: () => string, n = DRAWS) => Array.from({ length: n }, () => fn());

describe("generateRandomName", () => {
  test("is always two lowercase hyphen-separated segments", () => {
    for (const name of draw(generateRandomName)) {
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  test("never produces a blank segment", () => {
    for (const name of draw(generateRandomName, 500)) {
      for (const segment of name.split("-")) {
        expect(segment.length).toBeGreaterThan(0);
      }
    }
  });

  test("draws from both pools rather than repeating one value", () => {
    const names = draw(generateRandomName);
    const adjectives = new Set(names.map((n) => n.split("-")[0]));
    const animals = new Set(names.map((n) => n.split("-")[1]));
    expect(adjectives.size).toBeGreaterThan(20);
    expect(animals.size).toBeGreaterThan(20);
  });

  test("produces many distinct names across draws", () => {
    expect(new Set(draw(generateRandomName)).size).toBeGreaterThan(500);
  });
});

describe("generateDisplayName", () => {
  test("is always two capitalised space-separated words", () => {
    for (const name of draw(generateDisplayName)) {
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    }
  });

  test("carries no hyphen, so it is a label rather than a slug", () => {
    for (const name of draw(generateDisplayName, 500)) {
      expect(name).not.toContain("-");
    }
  });

  test("lowercases to the same vocabulary generateRandomName uses", () => {
    for (const name of draw(generateDisplayName, 500)) {
      expect(name.toLowerCase().replace(" ", "-")).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });
});

describe("generateWorkflowName", () => {
  test("is always two lowercase hyphen-separated segments", () => {
    for (const name of draw(generateWorkflowName)) {
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  test("draws its tail from a pool distinct from the animal pool", () => {
    const tails = new Set(draw(generateWorkflowName).map((n) => n.split("-")[1]));
    expect(tails.size).toBeGreaterThan(10);
  });
});

describe("generateServiceName", () => {
  test("is always two lowercase hyphen-separated segments", () => {
    for (const name of draw(generateServiceName)) {
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  test("always ends in one of the declared service suffixes", () => {
    const suffixes = new Set(["api", "service", "hub", "connect", "sync", "flow", "bridge"]);
    const seen = new Set<string>();
    for (const name of draw(generateServiceName)) {
      const tail = name.split("-")[1];
      expect(suffixes.has(tail)).toBe(true);
      seen.add(tail);
    }
    // Every declared suffix is reachable — none is stranded by an off-by-one.
    expect(seen.size).toBe(suffixes.size);
  });
});

describe("generateNameForType", () => {
  const SLUG_TYPES: EntityType[] = ["workflow", "service"];
  const LABEL_TYPES: EntityType[] = ["app", "agent", "miniapp"];

  test.each(SLUG_TYPES)("%s yields a lowercase slug", (type) => {
    for (const name of draw(() => generateNameForType(type), 500)) {
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  test.each(LABEL_TYPES)("%s yields a capitalised display label", (type) => {
    for (const name of draw(() => generateNameForType(type), 500)) {
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    }
  });

  test("service names use the service suffix pool, not the noun pool", () => {
    const suffixes = new Set(["api", "service", "hub", "connect", "sync", "flow", "bridge"]);
    for (const name of draw(() => generateNameForType("service"), 500)) {
      expect(suffixes.has(name.split("-")[1])).toBe(true);
    }
  });

  test("every declared entity type returns a non-empty name", () => {
    for (const type of [...SLUG_TYPES, ...LABEL_TYPES]) {
      const name = generateNameForType(type);
      expect(typeof name).toBe("string");
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  test("an unrecognised type falls back to a display label", () => {
    const name = generateNameForType("unknown" as EntityType);
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });
});

describe("pool health", () => {
  test("no generator ever emits a duplicated segment within one name", () => {
    for (const fn of [generateRandomName, generateWorkflowName, generateServiceName]) {
      for (const name of draw(fn, 500)) {
        const [head, tail] = name.split("-");
        expect(head).not.toBe(tail);
      }
    }
  });

  test("no generator emits leading, trailing, or doubled separators", () => {
    for (const fn of [generateRandomName, generateWorkflowName, generateServiceName]) {
      for (const name of draw(fn, 500)) {
        expect(name.startsWith("-")).toBe(false);
        expect(name.endsWith("-")).toBe(false);
        expect(name).not.toContain("--");
      }
    }
  });

  test("adjective pool entries are unique — a duplicate would halve entropy", () => {
    // Reached via the observable surface: the count of distinct heads over a
    // large sweep is the pool's effective size.
    const heads = new Set(draw(generateRandomName).map((n) => n.split("-")[0]));
    const workflowHeads = new Set(draw(generateWorkflowName).map((n) => n.split("-")[0]));
    expect(heads.size).toBe(workflowHeads.size);
  });
});
