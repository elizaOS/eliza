/**
 * Deterministic coverage for the explicit-recurrence guard on model-inferred
 * RRULEs: cadence-flavored event nouns ("standup") and time-of-day window
 * phrases ("in the morning") must not become repeating events; explicit
 * recurrence in any supported language must keep them, including recurrence
 * stated in a prior clarify turn carried via the conversation window.
 */
import { describe, expect, it } from "vitest";
import { intentStatesRecurrence } from "./calendar-handler.js";

describe("intentStatesRecurrence", () => {
  it("rejects one-off asks with cadence-flavored nouns", () => {
    // Live repro: the extraction model emitted RRULE:FREQ=WEEKLY;BYDAY=MO for
    // this exact ask and the built-in calendar hard-400'd on recurrence.
    expect(
      intentStatesRecurrence("add to my calendar: standup monday at 10am"),
    ).toBe(false);
    expect(intentStatesRecurrence("dentist appointment tomorrow at 3pm")).toBe(
      false,
    );
    expect(intentStatesRecurrence("lunch with sam friday")).toBe(false);
  });

  it("rejects time-of-day window phrases in one-shot asks", () => {
    // Window phrases live in the lifeops_cadence doc for WINDOW extraction;
    // they are not recurrence statements and must not open the gate.
    expect(intentStatesRecurrence("remind me to call mom in the morning")).toBe(
      false,
    );
    expect(intentStatesRecurrence("dentist tomorrow in the morning")).toBe(
      false,
    );
    expect(intentStatesRecurrence("take out the trash before bed")).toBe(false);
    expect(intentStatesRecurrence("gym after work today")).toBe(false);
  });

  it("rejects name-like cadence words (title-cased daily/diario)", () => {
    expect(
      intentStatesRecurrence("Daily Planet interview tomorrow at 3pm"),
    ).toBe(false);
    expect(intentStatesRecurrence("recuérdame comprar el Diario mañana")).toBe(
      false,
    );
  });

  it("rejects quantifier uses of every/each", () => {
    expect(
      intentStatesRecurrence("invite every member to the launch party"),
    ).toBe(false);
    expect(
      intentStatesRecurrence("add each attendee to the meeting invite"),
    ).toBe(false);
  });

  it("accepts explicit English recurrence phrasings", () => {
    expect(intentStatesRecurrence("standup every monday at 10am")).toBe(true);
    expect(intentStatesRecurrence("gym weekly on wednesdays")).toBe(true);
    expect(intentStatesRecurrence("water the plants daily at 9")).toBe(true);
    expect(intentStatesRecurrence("team sync, repeats each friday")).toBe(true);
    expect(intentStatesRecurrence("recurring rent payment on the 1st")).toBe(
      true,
    );
    expect(intentStatesRecurrence("yoga on tuesdays")).toBe(true);
    expect(intentStatesRecurrence("review twice a week")).toBe(true);
    expect(intentStatesRecurrence("standup every other friday")).toBe(true);
    expect(intentStatesRecurrence("backup runs nightly")).toBe(true);
  });

  it("accepts explicit recurrence in the shipped locales", () => {
    expect(intentStatesRecurrence("reunión cada lunes a las 10")).toBe(true);
    expect(intentStatesRecurrence("gimnasio todos los martes")).toBe(true);
    expect(intentStatesRecurrence("academia todas as segundas")).toBe(true);
    expect(intentStatesRecurrence("họp mỗi tuần")).toBe(true);
    expect(intentStatesRecurrence("simba araw-araw")).toBe(true);
    expect(intentStatesRecurrence("每周一开站会")).toBe(true);
    expect(intentStatesRecurrence("天天锻炼")).toBe(true);
    expect(intentStatesRecurrence("월요일마다 스탠드업")).toBe(true);
    expect(intentStatesRecurrence("매주 회의")).toBe(true);
    expect(intentStatesRecurrence("gimnasio los martes a las 10")).toBe(true);
    expect(intentStatesRecurrence("una vez a la semana yoga")).toBe(true);
    expect(intentStatesRecurrence("toda segunda tem reunião")).toBe(true);
    expect(intentStatesRecurrence("周一到周五提醒我吃药")).toBe(true);
  });

  it("grounds recurrence in any provided text (multi-turn clarify)", () => {
    // "confirm" alone says nothing; the prior turn's "make it weekly" arrives
    // via the recent-conversation window and keeps the stated recurrence.
    expect(intentStatesRecurrence("confirm")).toBe(false);
    expect(
      intentStatesRecurrence("confirm", "user: make it weekly\nagent: ok"),
    ).toBe(true);
  });

  it("is empty-safe", () => {
    expect(intentStatesRecurrence("")).toBe(false);
    expect(intentStatesRecurrence("   ")).toBe(false);
    expect(intentStatesRecurrence(undefined, null, "")).toBe(false);
  });
});
