/**
 * Verifies that the landing animation declares advanced capability claims and
 * keeps capability claims scoped to the natural-language reply that shows them.
 */

import { describe, expect, test } from "bun:test";
import {
  findUndeclaredLandingDemoClaims,
  findUnsupportedLandingDemoClaims,
  LANDING_DEMO_CAPABILITIES,
  LANDING_DEMO_MEMBER_AVATARS,
  LANDING_DEMO_SCENARIOS,
  landingDemoStepText,
} from "../src/lib/landing-demo";

const LANDING_DEMO = LANDING_DEMO_SCENARIOS.flatMap(
  (scenario) => scenario.steps,
);

describe("landing Shared-agent capability contract", () => {
  test("declares every capability portrayed in the five rooms", () => {
    const declaredCapabilities = LANDING_DEMO.flatMap((step) =>
      step.kind === "user" || step.kind === "member" ? [] : [step.capability],
    );

    expect(LANDING_DEMO_CAPABILITIES).toEqual([
      "conversation-memory",
      "connected-calendar",
      "public-web-search",
      "room-memory",
      "scheduled-reminder",
    ]);
    expect(new Set(declaredCapabilities)).toEqual(
      new Set(LANDING_DEMO_CAPABILITIES),
    );
  });

  test("never scripts a claim outside its declared capability", () => {
    const violations = LANDING_DEMO.flatMap((step, index) =>
      findUndeclaredLandingDemoClaims(step).map((category) => ({
        category,
        index,
        text: landingDemoStepText(step),
      })),
    );

    expect(violations).toEqual([]);
  });

  test("does not let a conversation-memory label smuggle in a connected claim", () => {
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "conversation-memory",
        kind: "eliza",
        text: "I searched the public web.",
      }),
    ).toEqual(["web-search"]);
    expect(
      findUndeclaredLandingDemoClaims({
        capability: "public-web-search",
        kind: "eliza",
        text: "I searched the public web.",
      }),
    ).toEqual([]);
  });

  test("keeps connected capabilities inside ordinary Eliza messages", () => {
    for (const scenario of LANDING_DEMO_SCENARIOS) {
      const connectedSteps = scenario.steps.filter(
        (step) =>
          step.kind !== "member" &&
          step.kind !== "user" &&
          step.capability !== "conversation-memory",
      );
      expect(connectedSteps.length).toBeGreaterThan(0);
      expect(
        connectedSteps.every(
          (step) =>
            step.kind === "eliza" ||
            step.kind === "place" ||
            step.kind === "task-list",
        ),
      ).toBe(true);
    }
  });

  test("does not confuse a conversational seat idiom with seat assignment", () => {
    expect(
      findUnsupportedLandingDemoClaims(
        "Grab a seat while I recap what you told me in this conversation.",
      ),
    ).toEqual([]);
  });

  test("defines all five finite rooms in the promised order", () => {
    expect(LANDING_DEMO_SCENARIOS.map(({ id }) => id)).toEqual([
      "household",
      "co-parenting",
      "friends",
      "trip",
      "community",
    ]);
    expect(
      new Set(LANDING_DEMO_SCENARIOS.map(({ roomName }) => roomName)).size,
    ).toBe(LANDING_DEMO_SCENARIOS.length);
  });

  test("gives every room a longer mini-story with evolving recaps", () => {
    for (const scenario of LANDING_DEMO_SCENARIOS) {
      const expectedAttachment =
        scenario.id === "friends"
          ? "place"
          : scenario.id === "household"
            ? "task-list"
            : null;
      expect(scenario.steps).toHaveLength(expectedAttachment ? 21 : 20);
      expect(scenario.steps.at(-1)?.kind).toBe(expectedAttachment ?? "eliza");
      expect(
        scenario.steps.filter((step) => step.kind === "eliza").length,
      ).toBeGreaterThanOrEqual(5);
    }
  });

  test("structures every room as four humans followed by Eliza", () => {
    for (const scenario of LANDING_DEMO_SCENARIOS) {
      expect(
        scenario.steps
          .slice(0, 4)
          .every((step) => step.kind === "member" || step.kind === "user"),
      ).toBe(true);
      expect(scenario.steps[4]?.kind).toBe("eliza");
    }
  });

  test("uses one real place attachment as the Friends visual prototype", () => {
    const attachments = LANDING_DEMO_SCENARIOS.flatMap((scenario) =>
      scenario.steps.filter((step) => step.kind === "place"),
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      capability: "public-web-search",
      kind: "place",
      place: {
        name: "Cypress Table",
        neighborhood: "Noe Valley",
      },
    });
  });

  test("keeps the Household task list synced with the final chat state", () => {
    const household = LANDING_DEMO_SCENARIOS.find(
      (scenario) => scenario.id === "household",
    );
    const attachment = household?.steps.find(
      (step) => step.kind === "task-list",
    );

    expect(attachment).toMatchObject({
      capability: "room-memory",
      kind: "task-list",
      taskList: {
        title: "To Do List",
      },
    });
    expect(
      attachment?.kind === "task-list"
        ? attachment.taskList.items.filter((item) => item.completed)
        : [],
    ).toHaveLength(2);
  });

  test("keeps every attributed speaker inside that room's member list", () => {
    for (const scenario of LANDING_DEMO_SCENARIOS) {
      const speakers = scenario.steps.flatMap((step) =>
        step.kind === "member" ? [step.name] : [],
      );
      expect(
        speakers.every((speaker) => scenario.members.includes(speaker)),
      ).toBe(true);
      expect(new Set(speakers)).toEqual(new Set(scenario.members));
    }
  });

  test("gives every room its own cast and every cast member a unique photo", () => {
    const members = LANDING_DEMO_SCENARIOS.flatMap((scenario) =>
      Array.from(scenario.members),
    );
    const avatars = members.map(
      (member) =>
        LANDING_DEMO_MEMBER_AVATARS[
          member as keyof typeof LANDING_DEMO_MEMBER_AVATARS
        ],
    );

    expect(new Set(members).size).toBe(members.length);
    expect(avatars.every(Boolean)).toBe(true);
    expect(new Set(avatars).size).toBe(avatars.length);
  });

  test("keeps every room and scripted beat distinct inside the rotation", () => {
    const allText = LANDING_DEMO.map(landingDemoStepText);

    expect(new Set(LANDING_DEMO_SCENARIOS.map(({ id }) => id)).size).toBe(5);
    expect(new Set(allText).size).toBe(allText.length);
  });

  test("lets people talk normally instead of prompting Eliza's plumbing", () => {
    const humanCopy = LANDING_DEMO.flatMap((step) =>
      step.kind === "user" || step.kind === "member" ? [step.text] : [],
    ).join(" ");

    expect(humanCopy).not.toMatch(
      /compare the calendars|mine is connected|check transit|ping me|save oat milk/i,
    );
  });

  test("keeps human texts casual and free of ad-copy punctuation", () => {
    for (const scenario of LANDING_DEMO_SCENARIOS) {
      for (const step of scenario.steps) {
        if (step.kind === "member" || step.kind === "user") {
          expect(step.text).not.toContain(";");
        }
      }
    }
  });

  test("makes the friends room proactively verify its allergy protocol", () => {
    const friends = LANDING_DEMO_SCENARIOS.find(
      (scenario) => scenario.id === "friends",
    );
    const copy = friends?.steps.map(landingDemoStepText).join(" ") ?? "";
    const capabilities = new Set(
      friends?.steps.flatMap((step) =>
        step.kind === "member" || step.kind === "user" ? [] : [step.capability],
      ),
    );

    expect(capabilities).toEqual(
      new Set([
        "connected-calendar",
        "conversation-memory",
        "public-web-search",
        "room-memory",
      ]),
    );
    expect(copy).toContain("severe peanut allergy");
    expect(copy).toContain("I remembered");
    expect(copy).not.toContain("shared room profile");
    expect(copy).not.toContain("no peanuts for me");
    expect(copy).toContain("checked its current allergy policy");
    expect(copy).toContain("separate tools and a manager check");
    expect(copy).not.toMatch(/allergy-safe|guaranteed safe|zero risk/i);
  });

  test("lets Eliza answer the co-parenting handoff question from chat context", () => {
    const coParenting = LANDING_DEMO_SCENARIOS.find(
      (scenario) => scenario.id === "co-parenting",
    );
    const copy = coParenting?.steps.map(landingDemoStepText).join(" ") ?? "";

    expect(copy).toContain("ok her blue bag is packed");
    expect(copy).not.toContain("inhaler is in front");
    expect(copy).toContain(
      "Yep, front pocket of the blue backpack. That's where Ava's inhaler stays.",
    );
    expect(copy).not.toContain("yes. consensus. unsettling.");
  });

  test("lets Eliza run the household rotation instead of waiting for volunteers", () => {
    const household = LANDING_DEMO_SCENARIOS.find(
      (scenario) => scenario.id === "household",
    );
    const copy = household?.steps.map(landingDemoStepText).join(" ") ?? "";
    const humanCopy =
      household?.steps
        .flatMap((step) =>
          step.kind === "member" || step.kind === "user" ? [step.text] : [],
        )
        .join(" ") ?? "";

    expect(copy).toContain("I checked the house rotation");
    expect(copy).toContain("keeps anyone else from getting stuck with a third");
    expect(copy).toContain("Two each");
    expect(humanCopy).not.toMatch(/I'll get coffee|I'll empty|I'll go if/i);
  });

  test("lets the trip room reconcile schedules before adding live logistics", () => {
    const trip = LANDING_DEMO_SCENARIOS.find(
      (scenario) => scenario.id === "trip",
    );
    const copy = trip?.steps.map(landingDemoStepText).join(" ") ?? "";
    const firstFour = trip?.steps.slice(0, 4) ?? [];

    expect(
      firstFour.every((step) =>
        step.kind === "member" || step.kind === "user"
          ? !/\b9:40\b|\b10:15\b/.test(step.text)
          : false,
      ),
    ).toBe(true);
    expect(copy).toContain("I matched all four travel calendars");
    expect(copy).toContain("covered route");
    expect(copy).toContain("good vegetarian food for Emi");
    expect(copy).toContain("plenty of non-veg options for Theo");
    expect(copy).not.toContain("we haven't picked anywhere");
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
    ["I saved this preference", "durable-memory"],
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
