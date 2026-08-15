/**
 * Contract test pinning the owner-surface umbrellas as grounded tracked-work
 * readers. The core planned-reply egress guard only lets an "empty tracked
 * state" reply through when the authoring action carries both
 * `resource:tracked-work` and `capability:read`; without the pair a verified
 * OWNER_TODOS "nothing on the list." review is replaced with a canned
 * inability message. Every owner record umbrella in owner-surfaces.ts takes
 * its tags from OWNER_OPERATION_TAGS (by reference or spread), so the shared
 * array is the single contract surface. Deterministic — asserts exported
 * metadata only.
 */
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
  it("declares the shared owner-operation tag set as a grounded tracked-work reader", () => {
    expect(OWNER_OPERATION_TAGS).toContain("resource:tracked-work");
    expect(OWNER_OPERATION_TAGS).toContain("capability:read");
  });
});
