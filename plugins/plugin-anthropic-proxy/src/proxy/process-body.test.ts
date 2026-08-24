/**
 * Unit tests for process-body: validates instance session ID generation
 * and process body pipeline.
 */
import { describe, expect, it } from "vitest";
import { INSTANCE_SESSION_ID } from "./process-body.ts";

describe("process-body", () => {
  it("exports a valid UUID for INSTANCE_SESSION_ID", () => {
    expect(typeof INSTANCE_SESSION_ID).toBe("string");
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(INSTANCE_SESSION_ID)
    ).toBe(true);
  });
});
