import { describe, expect, test } from "bun:test";

import { normalizeNpcGroupMessageResponse } from "../services/npc-group-dynamics-service";

describe("normalizeNpcGroupMessageResponse", () => {
  test("extracts nested response objects", () => {
    expect(
      normalizeNpcGroupMessageResponse({
        response: { message: "alpha circle only" },
      }),
    ).toEqual({ message: "alpha circle only" });
  });

  test("extracts XML-wrapped string responses", () => {
    expect(
      normalizeNpcGroupMessageResponse(
        "<response><message>watch this ticker quietly</message></response>",
      ),
    ).toEqual({ message: "watch this ticker quietly" });
  });

  test("returns plain string payloads directly", () => {
    expect(normalizeNpcGroupMessageResponse("just send the note")).toEqual({
      message: "just send the note",
    });
  });

  test("rejects empty or non-object responses", () => {
    expect(normalizeNpcGroupMessageResponse("   ")).toBeNull();
    expect(normalizeNpcGroupMessageResponse(42)).toBeNull();
  });
});
