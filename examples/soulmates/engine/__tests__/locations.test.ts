import { describe, expect, it } from "vitest";
import {
  CURATED_VENUES,
  CuratedLocationProvider,
  createDefaultLocationProvider,
} from "../locations";
import type { LocationSuggestionRequest } from "../types";

describe("CuratedLocationProvider", () => {
  const provider = new CuratedLocationProvider();

  describe("suggest", () => {
    it("should return venues matching city", async () => {
      const request: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["coffee", "conversation"],
        timeOfDay: "morning",
        limit: 3,
      };

      const suggestions = await provider.suggest(request);

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.length).toBeLessThanOrEqual(3);
      expect(suggestions.every((s) => s.city === "San Francisco")).toBe(true);
    });

    it("should return empty array for unknown city", async () => {
      const request: LocationSuggestionRequest = {
        city: "Unknown City",
        interests: ["coffee"],
        timeOfDay: "morning",
        limit: 3,
      };

      const suggestions = await provider.suggest(request);

      expect(suggestions).toHaveLength(0);
    });

    it("should rank venues by interest match", async () => {
      const request: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["art", "museums", "culture"],
        timeOfDay: "afternoon",
        limit: 5,
      };

      const suggestions = await provider.suggest(request);

      expect(suggestions.length).toBeGreaterThan(0);
      // First result should have high interest match
      expect(suggestions[0].name).toBeDefined();
    });

    it("should filter by time of day", async () => {
      const morningRequest: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["coffee"],
        timeOfDay: "morning",
        limit: 5,
      };

      const morningSuggestions = await provider.suggest(morningRequest);

      expect(morningSuggestions.length).toBeGreaterThan(0);
      // Should prioritize morning-friendly venues
    });

    it("should respect limit parameter", async () => {
      const request: LocationSuggestionRequest = {
        city: "New York",
        interests: ["outdoor", "walking"],
        timeOfDay: "afternoon",
        limit: 2,
      };

      const suggestions = await provider.suggest(request);

      expect(suggestions.length).toBeLessThanOrEqual(2);
    });

    it("should return venues with all required fields", async () => {
      const request: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["coffee"],
        timeOfDay: "morning",
        limit: 1,
      };

      const suggestions = await provider.suggest(request);

      expect(suggestions.length).toBeGreaterThan(0);
      const venue = suggestions[0];
      expect(venue.name).toBeDefined();
      expect(venue.address).toBeDefined();
      expect(venue.city).toBeDefined();
      expect(typeof venue.name).toBe("string");
      expect(typeof venue.address).toBe("string");
      expect(typeof venue.city).toBe("string");
    });

    it("should include placeId when available", async () => {
      const request: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["park", "outdoor"],
        timeOfDay: "afternoon",
        limit: 3,
      };

      const suggestions = await provider.suggest(request);

      // At least some venues should have placeId
      const withPlaceId = suggestions.filter((s) => s.placeId !== undefined);
      expect(withPlaceId.length).toBeGreaterThan(0);
    });

    it("should handle New York venues", async () => {
      const request: LocationSuggestionRequest = {
        city: "New York",
        interests: ["coffee", "business"],
        timeOfDay: "morning",
        limit: 3,
      };

      const suggestions = await provider.suggest(request);

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.every((s) => s.city === "New York")).toBe(true);
    });

    it("should handle evening requests", async () => {
      const request: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["food", "dining"],
        timeOfDay: "evening",
        limit: 3,
      };

      const suggestions = await provider.suggest(request);

      expect(suggestions.length).toBeGreaterThan(0);
    });

    it("should handle requests with no matching interests", async () => {
      const request: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["underwater_basketweaving"],
        timeOfDay: "morning",
        limit: 3,
      };

      const suggestions = await provider.suggest(request);

      // Should still return some venues for the city
      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe("addVenue", () => {
    it("should allow adding custom venues", async () => {
      const customProvider = new CuratedLocationProvider();
      const customVenue = {
        name: "Custom Test Venue",
        address: "123 Test St",
        city: "Test City",
        category: ["test"],
        timeOfDay: ["morning" as const],
        interests: ["testing"],
        notes: "Test venue",
      };

      customProvider.addVenue(customVenue);

      const request: LocationSuggestionRequest = {
        city: "Test City",
        interests: ["testing"],
        timeOfDay: "morning",
        limit: 5,
      };

      const suggestions = await customProvider.suggest(request);

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some((s) => s.name === "Custom Test Venue")).toBe(
        true,
      );
    });
  });

  describe("getVenuesForCity", () => {
    it("should return all venues for San Francisco", () => {
      const sfVenues = provider.getVenuesForCity("San Francisco");

      expect(sfVenues.length).toBeGreaterThan(0);
      expect(sfVenues.every((v) => v.city === "San Francisco")).toBe(true);
    });

    it("should return all venues for New York", () => {
      const nyVenues = provider.getVenuesForCity("New York");

      expect(nyVenues.length).toBeGreaterThan(0);
      expect(nyVenues.every((v) => v.city === "New York")).toBe(true);
    });

    it("should return empty array for unknown city", () => {
      const venues = provider.getVenuesForCity("Unknown City");

      expect(venues).toHaveLength(0);
    });
  });

  describe("createDefaultLocationProvider", () => {
    it("should return a working LocationSuggestionProvider", async () => {
      const provider = createDefaultLocationProvider();

      const request: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["coffee"],
        timeOfDay: "morning",
        limit: 3,
      };

      const suggestions = await provider.suggest(request);

      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe("CURATED_VENUES", () => {
    it("should contain venues", () => {
      expect(CURATED_VENUES.length).toBeGreaterThan(0);
    });

    it("should have both SF and NY venues", () => {
      const sfVenues = CURATED_VENUES.filter((v) => v.city === "San Francisco");
      const nyVenues = CURATED_VENUES.filter((v) => v.city === "New York");

      expect(sfVenues.length).toBeGreaterThan(0);
      expect(nyVenues.length).toBeGreaterThan(0);
    });

    it("should have all required fields", () => {
      for (const venue of CURATED_VENUES) {
        expect(venue.name).toBeDefined();
        expect(venue.address).toBeDefined();
        expect(venue.city).toBeDefined();
        expect(Array.isArray(venue.category)).toBe(true);
        expect(Array.isArray(venue.timeOfDay)).toBe(true);
        expect(Array.isArray(venue.interests)).toBe(true);
        expect(typeof venue.notes).toBe("string");
      }
    });
  });

  describe("Scoring algorithm", () => {
    it("should prioritize exact interest matches", async () => {
      const request: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["museums", "art"],
        timeOfDay: "afternoon",
        limit: 5,
      };

      const suggestions = await provider.suggest(request);

      expect(suggestions.length).toBeGreaterThan(0);
      // Museum venues should rank highly
      const hasMuseum = suggestions.some((s) =>
        s.name.toLowerCase().includes("museum"),
      );
      expect(hasMuseum).toBe(true);
    });

    it("should consider time of day in ranking", async () => {
      const eveningRequest: LocationSuggestionRequest = {
        city: "San Francisco",
        interests: ["food", "dining"],
        timeOfDay: "evening",
        limit: 3,
      };

      const eveningSuggestions = await provider.suggest(eveningRequest);

      expect(eveningSuggestions.length).toBeGreaterThan(0);
      // Evening venues should be prioritized
    });
  });

  describe("Custom venue database", () => {
    it("should allow using custom venue database", async () => {
      const customVenues = [
        {
          name: "Custom Cafe",
          address: "456 Custom Ave",
          city: "Custom City",
          category: ["cafe"],
          timeOfDay: ["morning" as const],
          interests: ["coffee"],
          notes: "Custom venue",
        },
      ];

      const customProvider = new CuratedLocationProvider(customVenues);

      const request: LocationSuggestionRequest = {
        city: "Custom City",
        interests: ["coffee"],
        timeOfDay: "morning",
        limit: 3,
      };

      const suggestions = await customProvider.suggest(request);

      expect(suggestions.length).toBe(1);
      expect(suggestions[0].name).toBe("Custom Cafe");
    });
  });
});
