/**
 * Unit tests for LifeOps service constants and configuration tables.
 */

import { describe, expect, it } from "vitest";
import {
  DAY_MINUTES,
  DEFAULT_CALENDAR_REMINDER_STEPS,
  DEFAULT_GMAIL_SEARCH_CACHE_SCAN_LIMIT,
  DEFAULT_GMAIL_SEARCH_SCAN_LIMIT,
  DEFAULT_GMAIL_TRIAGE_MAX_RESULTS,
  DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS,
  DEFAULT_REMINDER_INTENSITY,
  DEFAULT_REMINDER_PROCESS_LIMIT,
  DEFAULT_WORKFLOW_PERMISSION_POLICY,
  DEFAULT_WORKFLOW_PROCESS_LIMIT,
  DEFINITION_PERFORMANCE_LAST7_DAYS,
  DEFINITION_PERFORMANCE_LAST30_DAYS,
  GLOBAL_REMINDER_PREFERENCE_CHANNEL_REF,
  GOAL_REVIEW_LOOKBACK_DAYS,
  GOAL_SEMANTIC_REVIEW_CACHE_TTL_MS,
  GOOGLE_CALENDAR_CACHE_TTL_MS,
  GOOGLE_GMAIL_CACHE_TTL_MS,
  GOOGLE_GMAIL_MAILBOX,
  GOOGLE_PRIMARY_CALENDAR_ID,
  LIFEOPS_TIME_ZONE_ALIASES,
  MAX_GMAIL_TRIAGE_MAX_RESULTS,
  MAX_OVERVIEW_OCCURRENCES,
  MAX_OVERVIEW_REMINDERS,
  OVERVIEW_HORIZON_MINUTES,
  PROACTIVE_TASK_QUERY_TAGS,
  REMINDER_ACTIVITY_GATES,
  REMINDER_ESCALATION_DELAYS,
  REMINDER_INTENSITY_CANONICAL_ALIASES,
  REMINDER_INTENSITY_METADATA_KEY,
  REMINDER_URGENCY_METADATA_KEY,
  reminderProcessingQueues,
} from "./service-constants.js";

describe("LifeOps service constants", () => {
  it("defines standard overview horizons and limits", () => {
    expect(MAX_OVERVIEW_OCCURRENCES).toBe(8);
    expect(MAX_OVERVIEW_REMINDERS).toBe(6);
    expect(OVERVIEW_HORIZON_MINUTES).toBe(18 * 60);
    expect(DAY_MINUTES).toBe(24 * 60);
  });

  it("defines Google integration constants and cache TTLs", () => {
    expect(GOOGLE_CALENDAR_CACHE_TTL_MS).toBe(300_000);
    expect(GOOGLE_GMAIL_CACHE_TTL_MS).toBe(300_000);
    expect(GOOGLE_PRIMARY_CALENDAR_ID).toBe("primary");
    expect(GOOGLE_GMAIL_MAILBOX).toBe("me");
    expect(DEFAULT_GMAIL_TRIAGE_MAX_RESULTS).toBe(12);
    expect(MAX_GMAIL_TRIAGE_MAX_RESULTS).toBe(5000);
    expect(DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS).toBe(30);
    expect(DEFAULT_GMAIL_SEARCH_SCAN_LIMIT).toBe(50);
    expect(DEFAULT_GMAIL_SEARCH_CACHE_SCAN_LIMIT).toBe(200);
  });

  it("defines reminder and workflow limits and review periods", () => {
    expect(DEFAULT_REMINDER_PROCESS_LIMIT).toBe(24);
    expect(DEFAULT_WORKFLOW_PROCESS_LIMIT).toBe(12);
    expect(GOAL_REVIEW_LOOKBACK_DAYS).toBe(7);
    expect(GOAL_SEMANTIC_REVIEW_CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(DEFINITION_PERFORMANCE_LAST7_DAYS).toBe(7);
    expect(DEFINITION_PERFORMANCE_LAST30_DAYS).toBe(30);
    expect(DEFAULT_REMINDER_INTENSITY).toBe("normal");
    expect(GLOBAL_REMINDER_PREFERENCE_CHANNEL_REF).toBe(
      "lifeops://owner/reminder-preferences",
    );
  });

  it("maps common timezone abbreviations to canonical IANA timezone names", () => {
    expect(LIFEOPS_TIME_ZONE_ALIASES.pst).toBe("America/Los_Angeles");
    expect(LIFEOPS_TIME_ZONE_ALIASES.pdt).toBe("America/Los_Angeles");
    expect(LIFEOPS_TIME_ZONE_ALIASES.pt).toBe("America/Los_Angeles");
    expect(LIFEOPS_TIME_ZONE_ALIASES.pacific).toBe("America/Los_Angeles");

    expect(LIFEOPS_TIME_ZONE_ALIASES.est).toBe("America/New_York");
    expect(LIFEOPS_TIME_ZONE_ALIASES.edt).toBe("America/New_York");
    expect(LIFEOPS_TIME_ZONE_ALIASES.eastern).toBe("America/New_York");

    expect(LIFEOPS_TIME_ZONE_ALIASES.cst).toBe("America/Chicago");
    expect(LIFEOPS_TIME_ZONE_ALIASES.cdt).toBe("America/Chicago");
    expect(LIFEOPS_TIME_ZONE_ALIASES.central).toBe("America/Chicago");

    expect(LIFEOPS_TIME_ZONE_ALIASES.mst).toBe("America/Denver");
    expect(LIFEOPS_TIME_ZONE_ALIASES.mdt).toBe("America/Denver");
    expect(LIFEOPS_TIME_ZONE_ALIASES.mountain).toBe("America/Denver");

    expect(LIFEOPS_TIME_ZONE_ALIASES.utc).toBe("UTC");
    expect(LIFEOPS_TIME_ZONE_ALIASES.gmt).toBe("UTC");
  });

  it("configures reminder escalation delays per urgency level", () => {
    expect(REMINDER_ESCALATION_DELAYS.low).toEqual({
      initialMinutes: null,
      repeatMinutes: null,
    });
    expect(REMINDER_ESCALATION_DELAYS.medium).toEqual({
      initialMinutes: 90,
      repeatMinutes: 180,
    });
    expect(REMINDER_ESCALATION_DELAYS.high).toEqual({
      initialMinutes: 7,
      repeatMinutes: 10,
    });
    expect(REMINDER_ESCALATION_DELAYS.critical).toEqual({
      initialMinutes: 5,
      repeatMinutes: 10,
    });
  });

  it("normalizes reminder intensity aliases", () => {
    expect(REMINDER_INTENSITY_CANONICAL_ALIASES.minimal).toBe("minimal");
    expect(REMINDER_INTENSITY_CANONICAL_ALIASES.normal).toBe("normal");
    expect(REMINDER_INTENSITY_CANONICAL_ALIASES.persistent).toBe("persistent");
    expect(REMINDER_INTENSITY_CANONICAL_ALIASES.high_priority_only).toBe(
      "high_priority_only",
    );
    expect(REMINDER_INTENSITY_CANONICAL_ALIASES.paused).toBe(
      "high_priority_only",
    );
    expect(REMINDER_INTENSITY_CANONICAL_ALIASES.low).toBe("minimal");
    expect(REMINDER_INTENSITY_CANONICAL_ALIASES.high).toBe("persistent");
  });

  it("defines default calendar steps and workflow permission policy", () => {
    expect(DEFAULT_CALENDAR_REMINDER_STEPS).toEqual([
      {
        channel: "in_app",
        offsetMinutes: 30,
        label: "30m before event",
      },
    ]);

    expect(DEFAULT_WORKFLOW_PERMISSION_POLICY).toEqual({
      allowBrowserActions: false,
      trustedBrowserActions: false,
      allowXPosts: false,
      trustedXPosting: false,
      requireConfirmationForBrowserActions: true,
      requireConfirmationForXPosts: true,
    });
  });

  it("defines query tags, activity gates, and metadata key constants", () => {
    expect(PROACTIVE_TASK_QUERY_TAGS).toEqual(["queue", "repeat", "proactive"]);
    expect(REMINDER_ACTIVITY_GATES).toEqual(["active_on_computer"]);
    expect(REMINDER_INTENSITY_METADATA_KEY).toBe("reminderIntensity");
    expect(REMINDER_URGENCY_METADATA_KEY).toBe("reminderUrgency");
    expect(reminderProcessingQueues).toBeInstanceOf(Map);
  });
});
