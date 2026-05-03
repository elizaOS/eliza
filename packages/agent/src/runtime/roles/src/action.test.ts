import { describe, expect, it } from "vitest";
import { updateRoleAction } from "./action";

describe("updateRoleAction", () => {
  it("suppresses post-action continuation because it already emits its own reply", () => {
    expect(updateRoleAction.suppressPostActionContinuation).toBe(true);
  });
});
