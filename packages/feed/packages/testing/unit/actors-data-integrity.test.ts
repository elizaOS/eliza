/**
 * Data integrity tests for actor/organization TypeScript data
 * Ensures all required fields are present and no unused fields remain
 *
 * NOTE: This test file intentionally uses loadActorsData() to test raw data
 * integrity of the source TypeScript files. StaticDataRegistry exposes a
 * subset of fields for runtime use, but this test validates ALL fields exist
 * in the source data.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { loadActorsData } from "@feed/engine";
import type { ActorData, ActorsDatabase, Organization } from "@feed/shared";

describe("Actors.json Data Integrity", () => {
  let actorsData: ActorsDatabase;

  beforeAll(async () => {
    // Use loadActorsData to test raw data integrity (not StaticDataRegistry)
    // This ensures all source data fields are validated
    actorsData = loadActorsData() as ActorsDatabase;
  });

  describe("Actor Required Fields", () => {
    it("all actors should have id", () => {
      const missing = actorsData.actors.filter((a: ActorData) => !a.id);
      expect(missing).toHaveLength(0);
    });

    it("all actors should have name", () => {
      const missing = actorsData.actors.filter((a: ActorData) => !a.name);
      expect(missing).toHaveLength(0);
    });

    it("all actors should have realName", () => {
      const missing = actorsData.actors.filter((a: ActorData) => !a.realName);
      expect(missing).toHaveLength(0);
    });

    it("all actors should have username", () => {
      const missing = actorsData.actors.filter((a: ActorData) => !a.username);
      expect(missing).toHaveLength(0);
    });

    it("all actors should have description", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) => !a.description,
      );
      expect(missing).toHaveLength(0);
    });

    it("all actors should have profileDescription", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) => !a.profileDescription,
      );
      expect(missing).toHaveLength(0);
    });

    it("all actors should have domain array", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) => !Array.isArray(a.domain),
      );
      expect(missing).toHaveLength(0);
    });

    it("all actors should have personality", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) => !a.personality,
      );
      expect(missing).toHaveLength(0);
    });

    it("all actors should have tier", () => {
      const missing = actorsData.actors.filter((a: ActorData) => !a.tier);
      expect(missing).toHaveLength(0);
    });

    it("all actors should have postStyle", () => {
      const missing = actorsData.actors.filter((a: ActorData) => !a.postStyle);
      expect(missing).toHaveLength(0);
    });

    it("all actors should have postExample array", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) => !Array.isArray(a.postExample),
      );
      expect(missing).toHaveLength(0);
    });

    it("all actors should have hasPool boolean", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) => typeof a.hasPool !== "boolean",
      );
      expect(missing).toHaveLength(0);
    });

    it("all actors should have pfpDescription", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) => !a.pfpDescription,
      );
      expect(missing).toHaveLength(0);
    });

    it("all actor pfpDescriptions should identify the subject or be detailed portrait prompts", () => {
      const escapeRegex = (str: string): string =>
        str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      type PfpPrefixViolation = {
        id: string;
        realName: string;
        pfpStart: string;
      };

      const violations: PfpPrefixViolation[] = actorsData.actors.flatMap(
        (a: ActorData) => {
          if (!a.pfpDescription) return [];

          const pfp = a.pfpDescription.trim();
          const realName = a.realName.trim();
          const displayName = a.name.trim();

          const mentionsKnownName = [realName, displayName].some((name) =>
            new RegExp(escapeRegex(name), "i").test(pfp),
          );
          const wordCount = pfp.split(/\s+/).filter(Boolean).length;

          if (mentionsKnownName || wordCount >= 12) return [];

          return [
            {
              id: a.id,
              displayName,
              realName,
              wordCount,
              pfpStart: pfp.slice(0, 120),
            },
          ];
        },
      );

      expect(violations).toHaveLength(0);
    });

    it("all actors should have profileBanner", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) => !a.profileBanner,
      );
      expect(missing).toHaveLength(0);
    });

    it("all actors should have originalFirstName", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) =>
          a.originalFirstName === undefined || a.originalFirstName === null,
      );
      expect(missing).toHaveLength(0);
    });

    it("all actors should have originalLastName (can be empty string)", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) =>
          a.originalLastName === undefined || a.originalLastName === null,
      );
      expect(missing).toHaveLength(0);
    });

    it("all actors should have originalHandle", () => {
      const missing = actorsData.actors.filter(
        (a: ActorData) => !a.originalHandle,
      );
      expect(missing).toHaveLength(0);
    });
  });

  describe("Organization Required Fields", () => {
    it("all organizations should have id", () => {
      const missing = actorsData.organizations.filter(
        (o: Organization) => !o.id,
      );
      expect(missing).toHaveLength(0);
    });

    it("all organizations should have name", () => {
      const missing = actorsData.organizations.filter(
        (o: Organization) => !o.name,
      );
      expect(missing).toHaveLength(0);
    });

    it("all organizations should have type", () => {
      const missing = actorsData.organizations.filter(
        (o: Organization) => !o.type,
      );
      expect(missing).toHaveLength(0);
    });

    it("all organizations should have description", () => {
      const missing = actorsData.organizations.filter(
        (o: Organization) => !o.description,
      );
      expect(missing).toHaveLength(0);
    });

    it("all organizations should have postStyle", () => {
      const missing = actorsData.organizations.filter(
        (o: Organization) => !o.postStyle,
      );
      expect(missing).toHaveLength(0);
    });

    it("all organizations should have postExample array", () => {
      const missing = actorsData.organizations.filter(
        (o: Organization) => !Array.isArray(o.postExample),
      );
      expect(missing).toHaveLength(0);
    });

    it("all company-type organizations should have initialPrice (number)", () => {
      // Only companies need initialPrice - media organizations don't have stock prices
      const companies = actorsData.organizations.filter(
        (o: Organization) => o.type === "company",
      );
      const missing = companies.filter(
        (o: Organization) => typeof o.initialPrice !== "number",
      );
      expect(missing).toHaveLength(0);
    });

    it("all organizations should have originalName", () => {
      const missing = actorsData.organizations.filter(
        (o: Organization) => !o.originalName,
      );
      expect(missing).toHaveLength(0);
    });

    it("all organizations should have originalHandle", () => {
      const missing = actorsData.organizations.filter(
        (o: Organization) => !o.originalHandle,
      );
      expect(missing).toHaveLength(0);
    });
  });

  describe("Unused Fields Removed", () => {
    // Helper to check for properties that might exist on objects at runtime
    const hasProperty = (obj: object, prop: string): boolean => prop in obj;

    it('no actors should have "nickname" field', () => {
      const withNickname = actorsData.actors.filter((a) =>
        hasProperty(a, "nickname"),
      );
      expect(withNickname).toHaveLength(0);
    });

    it('no actors should have "aliases" field', () => {
      const withAliases = actorsData.actors.filter((a) =>
        hasProperty(a, "aliases"),
      );
      expect(withAliases).toHaveLength(0);
    });

    it('no actors should have "quirks" field', () => {
      const withQuirks = actorsData.actors.filter((a) =>
        hasProperty(a, "quirks"),
      );
      expect(withQuirks).toHaveLength(0);
    });

    it('no actors should have "canPostFeed" field', () => {
      const withCanPostFeed = actorsData.actors.filter((a) =>
        hasProperty(a, "canPostFeed"),
      );
      expect(withCanPostFeed).toHaveLength(0);
    });

    it('no actors should have "canPostGroups" field', () => {
      const withCanPostGroups = actorsData.actors.filter((a) =>
        hasProperty(a, "canPostGroups"),
      );
      expect(withCanPostGroups).toHaveLength(0);
    });
  });

  describe("Name Parody Validation", () => {
    it("all actor names should be different from realName", () => {
      const notParodied = actorsData.actors.filter(
        (a: ActorData) => a.name === a.realName,
      );
      expect(notParodied).toHaveLength(0);
    });

    it("actor names should contain AI variations", () => {
      const aiPatterns = /AI|ai/;
      const withAI = actorsData.actors.filter((a: ActorData) =>
        aiPatterns.test(a.name),
      );
      // Most should have AI in the name
      expect(withAI.length).toBeGreaterThan(actorsData.actors.length * 0.8);
    });

    it("organization names should be parodied", () => {
      const notParodied = actorsData.organizations.filter(
        (o: Organization) => o.name === o.originalName,
      );
      expect(notParodied).toHaveLength(0);
    });
  });

  describe("Data Consistency", () => {
    it("all actor IDs should be unique", () => {
      const ids = actorsData.actors.map((a: ActorData) => a.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("all organization IDs should be unique", () => {
      const ids = actorsData.organizations.map((o: Organization) => o.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("actor affiliations should reference valid organization IDs", () => {
      const orgIds = new Set(
        actorsData.organizations.map((o: Organization) => o.id),
      );

      for (const actor of actorsData.actors) {
        if (actor.affiliations && Array.isArray(actor.affiliations)) {
          for (const affiliation of actor.affiliations) {
            expect(orgIds.has(affiliation)).toBe(true);
          }
        }
      }
    });

    it("all hasPool values should be boolean", () => {
      for (const actor of actorsData.actors) {
        expect(typeof actor.hasPool).toBe("boolean");
      }
    });

    it("all company initialPrice values should be number", () => {
      // Only companies have initialPrice - media organizations don't have stock prices
      const companies = actorsData.organizations.filter(
        (o: Organization) => o.type === "company",
      );
      for (const org of companies) {
        expect(typeof org.initialPrice).toBe("number");
      }
    });
  });

  describe("Counts", () => {
    it("should have 204 actors", () => {
      expect(actorsData.actors).toHaveLength(204);
    });

    it("should have 60 organizations", () => {
      expect(actorsData.organizations).toHaveLength(60);
    });
  });
});
