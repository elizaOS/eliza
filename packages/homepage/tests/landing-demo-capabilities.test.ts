/**
 * Verifies the landing animation against the post-rollback capability boundary
 * for a fresh immediate agent rather than snapshotting marketing copy alone.
 */

import { describe, expect, test } from "bun:test";
import {
  findUnsupportedLandingDemoClaims,
  LANDING_DEMO_CAPABILITIES,
  LANDING_DEMO_INTRO,
  LANDING_DEMO_LOOP,
  landingDemoStepText,
} from "../src/lib/landing-demo";

const LANDING_DEMO = [...LANDING_DEMO_INTRO, ...LANDING_DEMO_LOOP];

describe("landing Shared-agent capability contract", () => {
  test("portrays only bounded conversation memory", () => {
    const declaredCapabilities = LANDING_DEMO.flatMap((step) =>
      step.kind === "user" || step.kind === "member" ? [] : [step.capability],
    );

    expect(LANDING_DEMO_CAPABILITIES).toEqual(["conversation-memory"]);
    expect(new Set(declaredCapabilities)).toEqual(
      new Set(LANDING_DEMO_CAPABILITIES),
    );
  });

  test("never scripts an unsupported action or information source", () => {
    const violations = LANDING_DEMO.flatMap((step, index) =>
      findUnsupportedLandingDemoClaims(landingDemoStepText(step)).map(
        (category) => ({ category, index, text: landingDemoStepText(step) }),
      ),
    );

    expect(violations).toEqual([]);
  });

  test("does not confuse a conversational seat idiom with seat assignment", () => {
    expect(
      findUnsupportedLandingDemoClaims(
        "Grab a seat while I recap what you told me in this conversation.",
      ),
    ).toEqual([]);
  });

  test("keeps the deterministic reduced-motion composition stable", () => {
    expect(LANDING_DEMO_INTRO).toHaveLength(17);
    expect(
      LANDING_DEMO_INTRO.filter((step) => step.kind === "card"),
    ).toHaveLength(3);
  });

  test("paces distinct context cards between conversational beats", () => {
    const cardIndexes = LANDING_DEMO_INTRO.flatMap((step, index) =>
      step.kind === "card" ? [index] : [],
    );
    const cards = LANDING_DEMO_INTRO.flatMap((step) =>
      step.kind === "card" ? [step.card] : [],
    );

    expect(cardIndexes).toEqual([5, 11, 16]);
    expect(new Set(cards.map((card) => card.label)).size).toBe(cards.length);
    expect(
      cards.every((card) =>
        [
          "Kept with this group",
          "Updated from this group",
          "Waiting on the group",
        ].includes(card.status ?? ""),
      ),
    ).toBe(true);
  });

  test("shows a real multi-person room with attributable messages", () => {
    const members = LANDING_DEMO_INTRO.flatMap((step) =>
      step.kind === "member" ? [step.name] : [],
    );

    expect(new Set(members)).toEqual(
      new Set(["Maya", "Leo", "Priya", "Jamie"]),
    );
    expect(
      LANDING_DEMO_INTRO.some(
        (step) => step.kind === "eliza" && step.text.includes("Jamie"),
      ),
    ).toBe(true);
  });

  test.each([
    [
      "I'm here to save you time and take things off your plate. Should we start with your email?",
      "email",
    ],
    [
      "Looks like you've got 2 important emails you haven't followed up on — one looks like an important work thing. Should I draft a reply?",
      "email",
    ],
    [
      "Okay, I've drafted the reply and saved it in your inbox. Want to look it over before I send it?",
      "email",
    ],
    ["Mail Re: Q3 partnership Draft saved to your inbox", "email"],
    [
      "Sent to your inbox. Also — you've got a call in an hour with an investor. Want me to give you a ring a few minutes before so you don't forget?",
      "external-communication",
    ],
    [
      "Will do. I've also prepared a dossier for the call — they've made some similar investments, I think you'll be a good fit.",
      "note",
    ],
    [
      "Notes Investor brief — Arc Capital Recent: 3 similar investments 2 pages",
      "note",
    ],
    [
      "Calendar Call with Arc Capital Today, 2:00 PM I'll call you at 1:55",
      "calendar",
    ],
    [
      "Via Carota has one table for 4 left at 7:30 on Thursday. Should I book it?",
      "booking",
    ],
    ["Reservation Via Carota Thursday, 7:30 PM Party of 4 Booked", "booking"],
    [
      "Done. Want me to send the details to the group?",
      "external-communication",
    ],
    [
      "I see it — UA 512 out of JFK, 9:15 AM. Want me to check you in when it opens and grab your usual aisle seat?",
      "external-account-or-device",
    ],
    [
      "Flight UA 512 — JFK to SFO Friday, 9:15 AM Seat 14C Check-in scheduled",
      "external-account-or-device",
    ],
    [
      "Set. One thing — your 9 AM standup overlaps with boarding. Should I move it?",
      "calendar",
    ],
    [
      "The 2019 Barolo from Cascina Fontana. You mentioned wanting it for your dad's birthday — that's in 12 days. Should I order a bottle?",
      "purchase",
    ],
    [
      "Reminders Dad's birthday Barolo, Cascina Fontana '19 Birthday card Reminder set",
      "reminder",
    ],
    [
      "Morning. Quick brief: 3 meetings today, rain at 4 so take a jacket. Inbox is triaged — nothing urgent.",
      "calendar",
    ],
  ])("keeps an exact legacy demo claim blocked: %s", (copy, category) => {
    expect(findUnsupportedLandingDemoClaims(copy)).toContain(category);
  });

  test.each([
    ["I moved tomorrow's standup to 11", "calendar"],
    ["I ordered the bottle", "purchase"],
    ["I searched the public web", "web-search"],
    ["I ran that shell command", "shell"],
    ["I changed the files in your workspace", "filesystem"],
    ["I opened Gmail in the browser", "browser-or-cloud-app"],
    ["I ran the repository tests", "coding-execution"],
  ])("keeps another unsupported policy class blocked: %s", (copy, category) => {
    expect(findUnsupportedLandingDemoClaims(copy)).toContain(category);
  });

  test.each([
    ["I scheduled that for tomorrow", "calendar"],
    ["I added it to your agenda", "calendar"],
    ["I messaged Alex with the details", "external-communication"],
    ["I paid for the tickets", "purchase"],
    ["I researched three options online", "web-search"],
    ["I saved it to your documents", "filesystem"],
    ["I opened your CRM", "browser-or-cloud-app"],
    ["I pushed the patch", "coding-execution"],
  ])("blocks an equivalent unsupported action claim: %s", (copy, category) => {
    expect(findUnsupportedLandingDemoClaims(copy)).toContain(category);
  });

  test.each([
    "You said you scheduled that for tomorrow.",
    "You added it to your agenda.",
    "Alex messaged you with the details.",
    "You paid for the tickets.",
    "Research is one of your interests.",
    "Your documents are about Rome.",
    "CRM is the acronym you used.",
    "The patch is part of your project.",
  ])("allows a benign conversation-memory statement: %s", (copy) => {
    expect(findUnsupportedLandingDemoClaims(copy)).toEqual([]);
  });
});
