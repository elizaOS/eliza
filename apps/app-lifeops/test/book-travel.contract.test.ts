import { describe, expect, it } from "vitest";
import { bookTravelAction } from "../src/actions/book-travel.js";

describe("BOOK_TRAVEL contract", () => {
  it("owns the turn and suppresses post-action continuation", () => {
    expect(bookTravelAction.suppressPostActionContinuation).toBe(true);
  });
});
