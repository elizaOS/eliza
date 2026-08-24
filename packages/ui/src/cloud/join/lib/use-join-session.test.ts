/**
 * Unit tests for use-join-session: validates hook export.
 */
import { describe, expect, it } from "vitest";
import { useJoinSessionAuth } from "./use-join-session.ts";

describe("use-join-session", () => {
  it("exports useJoinSessionAuth hook function", () => {
    expect(typeof useJoinSessionAuth).toBe("function");
  });
});
