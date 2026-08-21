/** Unit tests for extractAskedOutputDeliverable — the verbatim relay of a
 *  short plain child response when the user's ask requested output/results.
 *  Deterministic, no runtime. */
import { describe, expect, it } from "vitest";
import { extractAskedOutputDeliverable } from "./sub-agent-router.js";

describe("extractAskedOutputDeliverable", () => {
  it("relays a short plain response for an output ask", () => {
    expect(
      extractAskedOutputDeliverable(
        { response: "Tonight's dinner idea is: Homemade Pizza" },
        "run the dinner picker script and show me the output",
      ),
    ).toBe("Tonight's dinner idea is: Homemade Pizza");
  });

  it("returns undefined when the ask does not request output", () => {
    expect(
      extractAskedOutputDeliverable(
        { response: "done, the page is live" },
        "make me a lil recipe box page",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an empty response", () => {
    expect(
      extractAskedOutputDeliverable(
        { response: "   " },
        "run it and print the result",
      ),
    ).toBeUndefined();
  });

  it("treats a run-it-again ask as an output ask", () => {
    expect(
      extractAskedOutputDeliverable(
        { response: "Fun fact: Venus rotates backwards." },
        "nice, run it again i want another fact",
      ),
    ).toBe("Fun fact: Venus rotates backwards.");
  });

  it("matches the what-is-the-output phrasing", () => {
    expect(
      extractAskedOutputDeliverable(
        { finalText: "42" },
        "what's the output of the script?",
      ),
    ).toBe("42");
  });

  it("falls back to the summarized path for an oversized response", () => {
    expect(
      extractAskedOutputDeliverable(
        { response: "x".repeat(65_536) },
        "run it and show me the output",
      ),
    ).toBeUndefined();
  });
});
