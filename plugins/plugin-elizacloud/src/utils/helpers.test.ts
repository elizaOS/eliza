import { describe, expect, it } from "vitest";
import { parseImageDescriptionResponse } from "./helpers";

describe("parseImageDescriptionResponse", () => {
  it.each([
    ["Title: Red jacket at the zoo\nA man stands by an enclosure."],
    ["**Title:** Red jacket at the zoo\n\n**Description:** A man stands by an enclosure."],
    ["**Title**: Red jacket at the zoo\nA man stands by an enclosure."],
    ["  **Title: Red jacket at the zoo**\nA man stands by an enclosure."],
    ["**Title:** **Red jacket at the zoo**\nA man stands by an enclosure."],
  ])("reads the leading title label from %j", (response) => {
    expect(parseImageDescriptionResponse(response)).toEqual({
      title: "Red jacket at the zoo",
      description: response,
    });
  });

  it("does not take a title mentioned after the first line", () => {
    const response = "A poster on a wall.\nTitle: Concert Night";
    expect(parseImageDescriptionResponse(response).title).toBe("Image Analysis");
  });
});
