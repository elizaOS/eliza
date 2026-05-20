/**
 * Tests for NPC Persona Generator
 */
import { describe, expect, it } from "bun:test";
import type { Actor, Organization } from "../types";
import { SeededRandom } from "../utils/entropy";
import { NPCPersonaGenerator } from "./npc-persona-generator";

// Mock actors for testing
const mockActors: Actor[] = [
  {
    id: "alice",
    name: "Alice AI",
    description: "AI researcher at OpenAGI",
    affiliations: ["openagi"],
    domain: ["tech", "ai"],
    tier: "S_TIER",
  },
  {
    id: "bob",
    name: "Bob Builder",
    description: "Engineer at AItropic",
    affiliations: ["aitropic"],
    domain: ["tech", "ai"],
    tier: "S_TIER",
  },
  {
    id: "carol",
    name: "Carol Colleague",
    description: "Researcher at OpenAGI",
    affiliations: ["openagi"],
    domain: ["ai"],
    tier: "A_TIER",
  },
  {
    id: "dave",
    name: "Dave Politician",
    description: "A politician",
    role: "politician",
    domain: ["politics"],
    tier: "A_TIER",
  },
  {
    id: "eve",
    name: "Eve Conspiracy",
    personality: "contrarian conspiracy theorist",
    description: "Spreads misinformation",
    tier: "B_TIER",
  },
  {
    id: "frank",
    name: "Frank Finance",
    description: "Finance expert",
    domain: ["finance"],
    role: "expert",
    tier: "S_TIER",
  },
];

// Mock organizations
const mockOrganizations: Organization[] = [
  {
    id: "openagi",
    name: "OpenAGI",
    description: "AI research lab",
    type: "company",
    canBeInvolved: true,
  },
  {
    id: "aitropic",
    name: "AItropic",
    description: "AI safety company",
    type: "company",
    canBeInvolved: true,
  },
  {
    id: "deepmaind",
    name: "DeepMaind",
    description: "AI research division",
    type: "company",
    canBeInvolved: true,
  },
];

describe("NPCPersonaGenerator", () => {
  describe("assignPersonas", () => {
    it("generates deterministic personas with seeded RNG", () => {
      const generator = new NPCPersonaGenerator();
      const rng1 = new SeededRandom(42);
      const rng2 = new SeededRandom(42);

      const personas1 = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng1.next(),
      );
      const personas2 = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng2.next(),
      );

      // Deep equality comparison to catch regressions in any persona field
      for (const [id, persona1] of personas1) {
        const persona2 = personas2.get(id);
        expect(persona2).toBeDefined();
        expect(persona1).toEqual(persona2!);
      }
    });

    it("generates personas for all actors", () => {
      const generator = new NPCPersonaGenerator();
      const rng = new SeededRandom(42);

      const personas = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng.next(),
      );

      expect(personas.size).toBe(mockActors.length);
      for (const actor of mockActors) {
        expect(personas.has(actor.id)).toBe(true);
      }
    });
  });

  describe("reliability assignment", () => {
    it("assigns low reliability to politicians", () => {
      const generator = new NPCPersonaGenerator();
      const rng = new SeededRandom(42);

      const personas = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng.next(),
      );

      const dave = personas.get("dave");
      expect(dave).toBeDefined();
      expect(dave?.reliability).toBeGreaterThanOrEqual(0.25);
      expect(dave?.reliability).toBeLessThanOrEqual(0.4);
      expect(dave?.willingToLie).toBe(true);
    });

    it("assigns very low reliability to conspiracy theorists", () => {
      const generator = new NPCPersonaGenerator();
      const rng = new SeededRandom(42);

      const personas = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng.next(),
      );

      const eve = personas.get("eve");
      expect(eve).toBeDefined();
      expect(eve?.reliability).toBeGreaterThanOrEqual(0.15);
      expect(eve?.reliability).toBeLessThanOrEqual(0.3);
      expect(eve?.willingToLie).toBe(true);
      expect(eve?.selfInterest).toBe("chaos");
    });

    it("assigns higher reliability to insiders", () => {
      const generator = new NPCPersonaGenerator();
      const rng = new SeededRandom(42);

      const personas = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng.next(),
      );

      const alice = personas.get("alice");
      expect(alice).toBeDefined();
      expect(alice?.reliability).toBeGreaterThanOrEqual(0.7);
      expect(alice?.insiderOrgs).toContain("openagi");
    });
  });

  describe("relationship inference", () => {
    it("identifies actors with shared affiliations as allies", () => {
      const generator = new NPCPersonaGenerator();
      const rng = new SeededRandom(42);

      const personas = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng.next(),
      );

      // Alice and Carol both work at OpenAGI - should be allies
      const alice = personas.get("alice");
      const carol = personas.get("carol");

      expect(alice).toBeDefined();
      expect(carol).toBeDefined();
      expect(alice?.favorsActors).toContain("carol");
      expect(carol?.favorsActors).toContain("alice");
    });

    it("identifies actors from competing orgs as rivals", () => {
      const generator = new NPCPersonaGenerator();
      const rng = new SeededRandom(42);

      const personas = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng.next(),
      );

      // Alice (OpenAGI) and Bob (AItropic) work at competitors - should be rivals
      const alice = personas.get("alice");
      const bob = personas.get("bob");

      expect(alice).toBeDefined();
      expect(bob).toBeDefined();
      expect(alice?.opposesActors).toContain("bob");
      expect(bob?.opposesActors).toContain("alice");
    });

    it("identifies competitor organizations", () => {
      const generator = new NPCPersonaGenerator();
      const rng = new SeededRandom(42);

      const personas = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng.next(),
      );

      // Alice works at OpenAGI which competes with AItropic
      const alice = personas.get("alice");
      expect(alice).toBeDefined();
      expect(alice?.opposesOrgs).toContain("aitropic");
    });

    it("returns empty arrays for actors without affiliations", () => {
      const generator = new NPCPersonaGenerator();
      const rng = new SeededRandom(42);

      const personas = generator.assignPersonas(
        mockActors,
        mockOrganizations,
        () => rng.next(),
      );

      // Eve has no affiliations
      const eve = personas.get("eve");
      expect(eve).toBeDefined();
      expect(eve?.favorsActors).toEqual([]);
      expect(eve?.opposesActors).toEqual([]);
      expect(eve?.favorsOrgs).toEqual([]);
      expect(eve?.opposesOrgs).toEqual([]);
    });
  });
});
