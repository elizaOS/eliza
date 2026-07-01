/**
 * Tests for Event-Level Deduplication in TopicDiversityService
 *
 * Verifies that event tracking prevents duplicate content:
 * - Event ID generation
 * - Coverage tracking
 * - Saturation detection
 * - Expiry/cleanup
 *
 * NOTE: 6 tests are skipped due to Bun timer mocking limitations.
 * Bun's vi.spyOn(Date, 'now') doesn't affect `new Date()` calls,
 * making time-dependent tests unreliable.
 *
 * Re-enable these tests when Bun supports full timer mocking.
 * Tracking: https://github.com/oven-sh/bun/issues/5388
 * Skipped tests:
 * - "should update lastCoveredAt on subsequent tracks"
 * - "should update lastCoveredAt to extend lifetime"
 * - "should allow more posts after 30 minute cooldown"
 * - "should count recent events (within 1 hour)"
 * - "should clean up expired events"
 * - "should keep events that are not yet expired"
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopicDiversityService } from "../../services/topic-diversity-service";

describe("TopicDiversityService - Event Deduplication", () => {
  let service: TopicDiversityService;
  let mockNow: number;

  beforeEach(() => {
    service = new TopicDiversityService({
      maxPostsPerEvent: 3,
      eventExpiryHours: 12,
    });
    // Use a fixed time for deterministic tests
    mockNow = new Date("2025-01-04T12:00:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(mockNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to advance mock time
  const advanceTime = (ms: number) => {
    mockNow += ms;
    vi.spyOn(Date, "now").mockReturnValue(mockNow);
  };

  describe("trackEventCoverage", () => {
    it("should track new events", () => {
      const eventId = service.trackEventCoverage([
        "bitcoin",
        "$94000",
        "breakout",
      ]);

      expect(eventId).toBeTruthy();
      expect(eventId).toContain("bitcoin");
      expect(eventId).toContain("94000");

      const coverage = service.getEventCoverage([
        "bitcoin",
        "$94000",
        "breakout",
      ]);
      expect(coverage).not.toBeNull();
      expect(coverage?.postCount).toBe(1);
    });

    it("should increment count for existing events", () => {
      service.trackEventCoverage(["bitcoin", "crash"]);
      service.trackEventCoverage(["bitcoin", "crash"]);
      service.trackEventCoverage(["bitcoin", "crash"]);

      const coverage = service.getEventCoverage(["bitcoin", "crash"]);
      expect(coverage?.postCount).toBe(3);
    });

    // Skip: Bun doesn't support full timer mocking - new Date() returns real time
    it("should update lastCoveredAt on subsequent tracks", () => {
      service.trackEventCoverage(["ethereum", "upgrade"]);

      // Advance time by 1 hour
      advanceTime(60 * 60 * 1000);

      service.trackEventCoverage(["ethereum", "upgrade"]);

      const coverage = service.getEventCoverage(["ethereum", "upgrade"]);
      expect(coverage?.postCount).toBe(2);
      // lastCoveredAt should be updated to later time
      expect(coverage?.lastCoveredAt.getTime()).toBeGreaterThan(
        coverage?.firstCoveredAt.getTime(),
      );
    });

    it("should merge keywords from multiple tracks of same event", () => {
      // Track same event twice with exact same keywords
      service.trackEventCoverage(["bitcoin", "breakout"]);
      service.trackEventCoverage(["bitcoin", "breakout"]);

      // Same event ID, count should be 2
      const coverage = service.getEventCoverage(["bitcoin", "breakout"]);
      expect(coverage).not.toBeNull();
      expect(coverage?.keywords).toContain("bitcoin");
      expect(coverage?.postCount).toBe(2);
    });

    it("should normalize keywords to lowercase", () => {
      service.trackEventCoverage(["BITCOIN", "BTC", "Crash"]);

      const coverage = service.getEventCoverage(["bitcoin", "btc", "crash"]);
      expect(coverage).not.toBeNull();
    });

    it("should filter out short keywords (length <= 2)", () => {
      const eventId = service.trackEventCoverage([
        "AI",
        "ML",
        "big",
        "announcement",
      ]);

      // 'AI' and 'ML' are too short (2 chars) and should be filtered
      // Only 'big' and 'announcement' should be in the ID
      expect(eventId).toContain("big");
      expect(eventId).toContain("announcement");
    });
  });

  describe("shouldSkipEvent", () => {
    it("should return false for new events", () => {
      expect(service.shouldSkipEvent(["new", "event"])).toBe(false);
    });

    it("should return true when event reaches max posts", () => {
      service.trackEventCoverage(["saturated", "event"]);
      service.trackEventCoverage(["saturated", "event"]);
      service.trackEventCoverage(["saturated", "event"]);

      // Now at limit (3)
      expect(service.shouldSkipEvent(["saturated", "event"])).toBe(true);
    });

    it("should return true when event exceeds max posts", () => {
      // Manually trigger more posts than allowed by tracking multiple times
      for (let i = 0; i < 5; i++) {
        service.trackEventCoverage(["over", "limit", "event"]);
      }

      expect(service.shouldSkipEvent(["over", "limit", "event"])).toBe(true);
    });

    it("should return true for rapid-fire posts (2+ in 30 minutes)", () => {
      service.trackEventCoverage(["rapid", "fire"]);
      service.trackEventCoverage(["rapid", "fire"]);

      // Only 2 posts, below max of 3, but within 30 minutes
      expect(service.shouldSkipEvent(["rapid", "fire"])).toBe(true);
    });

    // Skip: Bun doesn't support full timer mocking - new Date() returns real time
    it("should allow more posts after 30 minute cooldown", () => {
      service.trackEventCoverage(["cooldown", "test"]);
      service.trackEventCoverage(["cooldown", "test"]);

      // Initially blocked
      expect(service.shouldSkipEvent(["cooldown", "test"])).toBe(true);

      // Advance 31 minutes
      advanceTime(31 * 60 * 1000);

      // Should now be allowed (under max, past cooldown)
      expect(service.shouldSkipEvent(["cooldown", "test"])).toBe(false);
    });

    it("should match events regardless of keyword order", () => {
      service.trackEventCoverage(["bitcoin", "breakout", "$94000"]);
      service.trackEventCoverage(["$94000", "bitcoin", "breakout"]);
      service.trackEventCoverage(["breakout", "$94000", "bitcoin"]);

      // All should be same event
      expect(service.shouldSkipEvent(["bitcoin", "$94000", "breakout"])).toBe(
        true,
      );
    });
  });

  describe("getEventCoverage", () => {
    it("should return null for unknown events", () => {
      expect(service.getEventCoverage(["unknown", "event"])).toBeNull();
    });

    it("should return coverage data for tracked events", () => {
      service.trackEventCoverage(["known", "event"]);

      const coverage = service.getEventCoverage(["known", "event"]);
      expect(coverage).not.toBeNull();
      expect(coverage?.eventId).toBeTruthy();
      expect(coverage?.postCount).toBe(1);
      expect(coverage?.firstCoveredAt).toBeInstanceOf(Date);
      expect(coverage?.lastCoveredAt).toBeInstanceOf(Date);
      expect(coverage?.keywords).toBeInstanceOf(Array);
    });
  });

  describe("getEventStats", () => {
    it("should return zero counts for empty service", () => {
      const stats = service.getEventStats();

      expect(stats.totalEvents).toBe(0);
      expect(stats.saturatedEvents).toBe(0);
      expect(stats.recentEvents).toBe(0);
    });

    it("should count total events", () => {
      service.trackEventCoverage(["event", "one"]);
      service.trackEventCoverage(["event", "two"]);
      service.trackEventCoverage(["event", "three"]);

      const stats = service.getEventStats();
      expect(stats.totalEvents).toBe(3);
    });

    it("should count saturated events", () => {
      // Saturate one event
      for (let i = 0; i < 3; i++) {
        service.trackEventCoverage(["saturated", "one"]);
      }
      // Leave another unsaturated
      service.trackEventCoverage(["unsaturated", "two"]);

      const stats = service.getEventStats();
      expect(stats.saturatedEvents).toBe(1);
    });

    // Skip: Bun doesn't support full timer mocking - new Date() returns real time
    it("should count recent events (within 1 hour)", () => {
      service.trackEventCoverage(["recent", "event"]);

      // Advance 30 minutes
      advanceTime(30 * 60 * 1000);
      service.trackEventCoverage(["also", "recent"]);

      // Advance 2 hours
      advanceTime(2 * 60 * 60 * 1000);
      service.trackEventCoverage(["new", "recent"]);

      const stats = service.getEventStats();
      // Only the last one should be recent
      expect(stats.recentEvents).toBe(1);
      expect(stats.totalEvents).toBe(3);
    });
  });

  describe("Event Expiry", () => {
    // Skip: Bun doesn't support full timer mocking - new Date() returns real time
    it("should clean up expired events", () => {
      service.trackEventCoverage(["old", "event"]);

      // Advance past expiry (12 hours + cleanup interval)
      advanceTime(13 * 60 * 60 * 1000);

      // Force cleanup by calling a method that triggers it
      service.shouldSkipEvent(["trigger", "cleanup"]);

      // Old event should be gone
      expect(service.getEventCoverage(["old", "event"])).toBeNull();
    });

    // Skip: Bun doesn't support full timer mocking - new Date() returns real time
    it("should keep events that are not yet expired", () => {
      service.trackEventCoverage(["fresh", "event"]);

      // Advance 6 hours (less than 12 hour expiry)
      advanceTime(6 * 60 * 60 * 1000);

      // Force cleanup
      service.trackEventCoverage(["trigger", "cleanup"]);

      // Fresh event should still exist
      expect(service.getEventCoverage(["fresh", "event"])).not.toBeNull();
    });

    // Skip: Bun doesn't support full timer mocking - new Date() returns real time
    it("should update lastCoveredAt to extend lifetime", () => {
      service.trackEventCoverage(["renewed", "event"]);

      // Advance 10 hours
      advanceTime(10 * 60 * 60 * 1000);

      // Track again to renew
      service.trackEventCoverage(["renewed", "event"]);

      // Advance another 10 hours (20 total from first, 10 from renewal)
      advanceTime(10 * 60 * 60 * 1000);

      // Force cleanup
      service.shouldSkipEvent(["trigger", "cleanup"]);

      // Event should still exist (renewed 10 hours ago, expiry is 12 hours)
      expect(service.getEventCoverage(["renewed", "event"])).not.toBeNull();
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty keyword array", () => {
      const eventId = service.trackEventCoverage([]);
      expect(eventId).toBe("generic-event");
    });

    it("should handle single keyword", () => {
      service.trackEventCoverage(["bitcoin"]);
      expect(service.getEventCoverage(["bitcoin"])).not.toBeNull();
    });

    it("should handle keywords with special characters", () => {
      service.trackEventCoverage(["$100k", "+15%", "bitcoin"]);
      expect(
        service.getEventCoverage(["$100k", "+15%", "bitcoin"]),
      ).not.toBeNull();
    });

    it("should handle whitespace in keywords", () => {
      service.trackEventCoverage(["  bitcoin  ", "  eth  "]);
      expect(service.getEventCoverage(["bitcoin", "eth"])).not.toBeNull();
    });

    it("should handle duplicate keywords in tracking", () => {
      // Keywords with duplicates - event ID includes all (sorted)
      service.trackEventCoverage(["bitcoin", "bitcoin", "bitcoin", "crash"]);

      // Must use same keywords to find it (duplicates matter for event ID)
      const coverage = service.getEventCoverage([
        "bitcoin",
        "bitcoin",
        "bitcoin",
        "crash",
      ]);
      expect(coverage).not.toBeNull();
      expect(coverage?.postCount).toBe(1);
    });
  });
});
