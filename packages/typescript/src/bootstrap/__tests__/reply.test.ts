import { replyAction } from "../actions/reply.ts";
import { describe, expect, it } from "bun:test";

describe("reply action", () => {
  it("validates required context", () => {
    expect(() => replyAction({} as any)).toThrow();
  });

  it("validates required parameters", () => {
    expect(() => replyAction({ context: {} } as any)).toThrow(); 
  });

  it("requires content parameter", () => {
    expect(() => 
      replyAction({ context: {}, parameters: {} } as any)
    ).toThrow();
  });

  it("validates content must be non-empty", () => {
    expect(() =>
      replyAction({ 
        context: {},
        parameters: {
          content: ""
        }
      } as any)
    ).toThrow();
  });
});
