import { describe, expect, it } from "vitest";
import {
  selectUserAuthorizedRecurrence,
  textStatesExplicitRecurrence,
} from "./recurrence-markers.ts";

describe("textStatesExplicitRecurrence", () => {
  it("accepts explicit Japanese recurrence in the shipped ja locale", () => {
    expect(
      textStatesExplicitRecurrence("毎日午前9時に水を飲むようにリマインドして"),
    ).toBe(true);
    expect(
      textStatesExplicitRecurrence("毎週月曜日の午前10時にスタンドアップ"),
    ).toBe(true);
    expect(textStatesExplicitRecurrence("毎月1日に家賃を支払う")).toBe(true);
    expect(textStatesExplicitRecurrence("週に一回バックアップする")).toBe(true);
  });

  it("accepts numeric English cadence", () => {
    expect(textStatesExplicitRecurrence("back up every 2 days")).toBe(true);
    expect(textStatesExplicitRecurrence("check every 15 minutes")).toBe(true);
  });

  it("accepts title-case cadence and bounded weekly counts", () => {
    expect(textStatesExplicitRecurrence("Daily standup at 9am")).toBe(true);
    expect(textStatesExplicitRecurrence("only once a week")).toBe(true);
    expect(textStatesExplicitRecurrence("just once every week")).toBe(true);
  });

  it("uses the user's last explicit cadence correction", () => {
    expect(
      textStatesExplicitRecurrence("not every day, every week instead"),
    ).toBe(true);
    expect(
      textStatesExplicitRecurrence("not recurring, make it weekly instead"),
    ).toBe(true);
    expect(
      textStatesExplicitRecurrence(
        "do not repeat daily; actually make it weekly",
      ),
    ).toBe(true);
    expect(textStatesExplicitRecurrence("毎日ではない、毎週にして")).toBe(true);
    expect(textStatesExplicitRecurrence("weekly, actually just once")).toBe(
      false,
    );
  });

  it("lets current one-shot corrections outrank recurrence words", () => {
    expect(
      textStatesExplicitRecurrence("remind me tomorrow, not every day"),
    ).toBe(false);
    expect(
      textStatesExplicitRecurrence(
        "schedule standup Monday, not recurring, just once",
      ),
    ).toBe(false);
    expect(
      textStatesExplicitRecurrence(
        "user: no, just once\nassistant: should this be weekly?",
      ),
    ).toBe(false);
    for (const text of [
      "do not repeat every week",
      "don't repeat this every week",
      "never repeat every day",
      "not recurring every month",
      "no recurrence every year",
      "繰り返さない毎週",
    ]) {
      expect(textStatesExplicitRecurrence(text)).toBe(false);
    }
  });

  it("ignores role-labelled non-user text", () => {
    expect(
      textStatesExplicitRecurrence("assistant: should this be weekly?"),
    ).toBe(false);
    expect(
      textStatesExplicitRecurrence("user: make it weekly\nassistant: okay"),
    ).toBe(true);
  });

  it("parses role labels with adversarial delimiter whitespace", () => {
    const spacing = "\t".repeat(100_000);
    expect(textStatesExplicitRecurrence(`user${spacing}: make it weekly`)).toBe(
      true,
    );
    expect(
      textStatesExplicitRecurrence(`assistant${spacing}: make it weekly`),
    ).toBe(false);
  });

  it("rejects Japanese one-shot windows and name-like cadence words", () => {
    expect(
      textStatesExplicitRecurrence("明日の朝、歯医者の予定を追加して"),
    ).toBe(false);
    expect(
      textStatesExplicitRecurrence("毎日新聞の取材を明日の朝に追加して"),
    ).toBe(false);
    expect(
      textStatesExplicitRecurrence("毎日放送との会議を金曜日に追加して"),
    ).toBe(false);
  });
});

describe("selectUserAuthorizedRecurrence", () => {
  const outerPlanner = ["RRULE:FREQ=WEEKLY;BYDAY=MO"];
  const extracted = ["RRULE:FREQ=DAILY"];

  it("drops every model-authored source for a one-off request", () => {
    expect(
      selectUserAuthorizedRecurrence(
        ["add to my calendar: standup monday at 10am"],
        [outerPlanner, extracted],
      ),
    ).toBeUndefined();
  });

  it("drops every source when the current user negates recurrence", () => {
    expect(
      selectUserAuthorizedRecurrence(
        ["user: no, just once\nassistant: should this be weekly?"],
        [outerPlanner, extracted],
      ),
    ).toBeUndefined();
  });

  it("returns the first source in caller precedence for explicit cadence", () => {
    expect(
      selectUserAuthorizedRecurrence(
        ["schedule standup every monday at 10am"],
        [outerPlanner, extracted],
      ),
    ).toEqual(outerPlanner);
  });
});
