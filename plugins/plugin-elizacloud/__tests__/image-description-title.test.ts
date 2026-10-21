import { describe, expect, it } from "vitest";
import { parseImageDescriptionResponse } from "../src/utils/helpers";

describe("parseImageDescriptionResponse", () => {
  it("reads the title from a bold label", () => {
    const result = parseImageDescriptionResponse(
      "**Title:** Red jacket at the zoo\n\nA man stands by an enclosure."
    );
    expect(result.title).toBe("Red jacket at the zoo");
  });

  it("still reads the title from a plain label", () => {
    const result = parseImageDescriptionResponse(
      "Title: Red jacket at the zoo\n\nA man stands by an enclosure."
    );
    expect(result.title).toBe("Red jacket at the zoo");
  });

  it("handles trailing asterisks in the title", () => {
    const result = parseImageDescriptionResponse(
      "**Title: Red jacket**\n\nA man stands by an enclosure."
    );
    expect(result.title).toBe("Red jacket");
  });
});