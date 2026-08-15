/** Pins mixed owner surfaces to the tracked-work egress contract. */
import { describe, expect, it, vi } from "vitest";
import { OWNER_OPERATION_TAGS } from "./life.js";

// life.js reaches the scheduling runner through the LifeOps service; the tag
// contract under test is module-scope metadata, so the service module is
// stubbed the same way life.review-definitions.test.ts does.
vi.mock("../lifeops/service.js", () => {
  class LifeOpsServiceError extends Error {}
  class LifeOpsService {}
  return { LifeOpsService, LifeOpsServiceError };
});

describe("owner-surface tracked-work grounding tags", () => {
  it("declares both tracked-work read and mutation capabilities", () => {
    expect(OWNER_OPERATION_TAGS).toContain("resource:tracked-work");
    expect(OWNER_OPERATION_TAGS).toContain("capability:read");
    expect(OWNER_OPERATION_TAGS).toContain("capability:write");
    expect(OWNER_OPERATION_TAGS).toContain("capability:update");
    expect(OWNER_OPERATION_TAGS).toContain("capability:delete");
  });
});
