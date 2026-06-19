import { describe, expect, it } from "vitest";
import { PostRelationshipLinkRequestSchema } from "./relationships-routes.js";

describe("PostRelationshipLinkRequestSchema", () => {
  it("trims targetEntityId", () => {
    expect(
      PostRelationshipLinkRequestSchema.parse({
        targetEntityId: "  e1  ",
      }),
    ).toEqual({ targetEntityId: "e1" });
  });

  it("accepts optional evidence", () => {
    expect(
      PostRelationshipLinkRequestSchema.parse({
        targetEntityId: "e1",
        evidence: { source: "manual", confidence: 0.9 },
      }),
    ).toEqual({
      targetEntityId: "e1",
      evidence: { source: "manual", confidence: 0.9 },
    });
  });

  it("rejects whitespace-only targetEntityId", () => {
    expect(() =>
      PostRelationshipLinkRequestSchema.parse({ targetEntityId: " " }),
    ).toThrow(/targetEntityId is required/);
  });

  it("rejects missing targetEntityId", () => {
    expect(() => PostRelationshipLinkRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostRelationshipLinkRequestSchema.parse({
        targetEntityId: "e1",
        confidence: 0.5,
      }),
    ).toThrow();
  });
});
