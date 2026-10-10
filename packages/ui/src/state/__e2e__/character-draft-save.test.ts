import { describe, expect, it } from "vitest";
import { prepareDraftForSave } from "../character-draft-helpers";

// `PUT /api/character` keeps every field the request omits, so these
// assertions pin the request body the Character editor sends on save.
describe("prepareDraftForSave", () => {
  it("sends fields the user emptied so the server clears them", () => {
    const body = prepareDraftForSave({
      name: "Ada",
      username: "Ada",
      bio: "",
      system: "",
      adjectives: [],
      topics: [""],
      postExamples: [],
      messageExamples: [],
      style: { all: [], chat: [], post: [] },
    });

    expect(body).toEqual({
      name: "Ada",
      username: "Ada",
      bio: [],
      system: "",
      adjectives: [],
      topics: [],
      postExamples: [],
      messageExamples: [],
      style: { all: [], chat: [], post: [] },
    });
  });

  it("clears message examples whose rows the user emptied", () => {
    const body = prepareDraftForSave({
      name: "Ada",
      messageExamples: [
        { examples: [{ name: "{{user1}}", content: { text: "" } }] },
      ],
    });

    expect(body.messageExamples).toEqual([]);
  });

  it("omits fields the draft never loaded", () => {
    expect(prepareDraftForSave({ name: "Ada" })).toEqual({
      name: "Ada",
      username: "Ada",
    });
  });
});
