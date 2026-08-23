/**
 * Unit-tests the landing demo library helpers against the real module:
 * unsupported-claim detection order and word boundaries, capability-scoped
 * filtering for spoken and attachment steps, and attachment text rendering.
 */

import { describe, expect, test } from "vitest";
import {
  findUndeclaredLandingDemoClaims,
  findUnsupportedLandingDemoClaims,
  LANDING_DEMO_CAPABILITIES,
  LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES,
  landingDemoStepText,
} from "../src/lib/landing-demo";

describe("landing demo library units", () => {
  test("returns no unsupported claims for empty or claim-free text", () => {
    expect(findUnsupportedLandingDemoClaims("")).toEqual([]);
    expect(
      findUnsupportedLandingDemoClaims(
        "The garden looks lovely this time of year.",
      ),
    ).toEqual([]);
  });

  test("detects a single category exactly", () => {
    expect(
      findUnsupportedLandingDemoClaims("Please email me the details."),
    ).toEqual(["email"]);
    expect(
      findUnsupportedLandingDemoClaims("npm install finished cleanly."),
    ).toEqual(["shell"]);
  });

  test("reports multiple categories in declaration order, not mention order", () => {
    expect(
      findUnsupportedLandingDemoClaims(
        "Set a reminder to book the table and then email me.",
      ),
    ).toEqual(["email", "booking", "reminder"]);
  });

  test("matches case-insensitively", () => {
    expect(
      findUnsupportedLandingDemoClaims("EMAIL ME THE CONFIRMATION."),
    ).toEqual(["email"]);
  });

  test("respects word boundaries on claim stems", () => {
    expect(
      findUnsupportedLandingDemoClaims("She mailed the letter yesterday."),
    ).toEqual([]);
  });

  test("never reports unsupported claims for member or user steps", () => {
    expect(
      findUndeclaredLandingDemoClaims({
        kind: "member",
        name: "Maya",
        text: "I'll email you, book the table, and check your calendar.",
      }),
    ).toEqual([]);
    expect(
      findUndeclaredLandingDemoClaims({
        kind: "user",
        text: "Send me a reminder and reserve the table.",
      }),
    ).toEqual([]);
  });

  test("allows each connected capability only its declared claim category", () => {
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "connected-calendar",
        kind: "eliza",
        text: "I moved your appointment to Thursday.",
      }),
    ).toEqual([]);
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "room-memory",
        kind: "eliza",
        text: "I saved your preference.",
      }),
    ).toEqual([]);
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "scheduled-reminder",
        kind: "eliza",
        text: "I'll remind you before the pickup.",
      }),
    ).toEqual([]);
  });

  test("still blocks undeclared categories on capable steps", () => {
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "scheduled-reminder",
        kind: "eliza",
        text: "I booked the reservation for you.",
      }),
    ).toEqual(["booking"]);
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "conversation-memory",
        kind: "eliza",
        text: "I saved your preference.",
      }),
    ).toEqual(["durable-memory"]);
  });

  test("scans attachment steps through their rendered text", () => {
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "public-web-search",
        kind: "place",
        place: {
          category: "Cafe",
          distance: "0.4 mi",
          feature: "Reservations accepted",
          name: "Harbor Desk",
          neighborhood: "SoMa",
          rating: "4.6",
        },
      }),
    ).toEqual(["booking"]);
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "scheduled-reminder",
        handoff: {
          child: "Ava",
          day: "Friday",
          location: "Calendar Annex",
          time: "4:30 PM",
          title: "Pickup",
        },
        kind: "handoff",
      }),
    ).toEqual(["calendar"]);
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "room-memory",
        kind: "task-list",
        taskList: {
          items: [
            {
              assignee: "You",
              completed: false,
              task: "Remember that preference",
            },
          ],
          title: "Chores",
        },
      }),
    ).toEqual([]);
  });

  test("returns spoken step text unchanged", () => {
    expect(landingDemoStepText({ kind: "user", text: "works for me" })).toBe(
      "works for me",
    );
    expect(
      landingDemoStepText({ kind: "member", name: "Leo", text: "same" }),
    ).toBe("same");
    expect(
      landingDemoStepText({
        capability: "conversation-memory",
        kind: "eliza",
        text: "Noted in this room.",
      }),
    ).toBe("Noted in this room.");
  });

  test("renders a place attachment as its six fields joined by spaces", () => {
    expect(
      landingDemoStepText({
        capability: "public-web-search",
        kind: "place",
        place: {
          category: "Californian",
          distance: "0.4 mi",
          feature: "Quiet patio",
          name: "Cypress Table",
          neighborhood: "Noe Valley",
          rating: "4.8",
        },
      }),
    ).toBe("Cypress Table Californian Noe Valley 0.4 mi 4.8 Quiet patio");
  });

  test("renders a task list as its title then assignee and task pairs", () => {
    expect(
      landingDemoStepText({
        capability: "room-memory",
        kind: "task-list",
        taskList: {
          items: [
            { assignee: "You", completed: false, task: "Coffee" },
            { assignee: "Noor", completed: true, task: "Plants" },
          ],
          title: "To Do",
        },
      }),
    ).toBe("To Do You Coffee Noor Plants");
  });

  test("renders a handoff as child, title, day, time, and location", () => {
    expect(
      landingDemoStepText({
        capability: "scheduled-reminder",
        handoff: {
          child: "Ava",
          day: "Friday",
          location: "Mission Rec Field",
          time: "4:30 PM",
          title: "Soccer",
        },
        kind: "handoff",
      }),
    ).toBe("Ava Soccer Friday 4:30 PM Mission Rec Field");
  });

  test("renders an itinerary as its title then stop times and labels", () => {
    expect(
      landingDemoStepText({
        capability: "public-web-search",
        itinerary: {
          stops: [
            { label: "Arrivals", time: "10:20" },
            { label: "Apartment", time: "3:00" },
          ],
          title: "Plan",
        },
        kind: "itinerary",
      }),
    ).toBe("Plan 10:20 Arrivals 3:00 Apartment");
  });

  test("keeps both taxonomy tuples free of duplicate entries", () => {
    expect(new Set(LANDING_DEMO_CAPABILITIES).size).toBe(
      LANDING_DEMO_CAPABILITIES.length,
    );
    expect(new Set(LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES).size).toBe(
      LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES.length,
    );
  });
});
