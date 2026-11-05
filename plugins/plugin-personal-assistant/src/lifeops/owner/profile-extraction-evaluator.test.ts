/**
 * Owner facts come only from phrasings that state them. A bare "call me" or
 * "I'm in" turned everyday requests into the owner's name and location.
 */
import { expect, it } from "vitest";
import { extractProfileDetails } from "./profile-extraction-evaluator.ts";

const now = new Date("2026-11-05T12:00:00Z");

it("does not read everyday phrases as the owner's name or location", () => {
  const extraction = extractProfileDetails(
    "Call me back when the report is ready, I'm in a meeting until three.",
    now,
  );
  expect(extraction.facts).toEqual({});
});

it("still reads stated name and location", () => {
  expect(
    extractProfileDetails("My name is Dana. I live in Austin.", now).facts,
  ).toEqual({ preferredName: "Dana", location: "Austin" });
});
