import { describe, expect, it } from "vitest";
import { pageDelegateAction } from "./page-action-groups";

describe("PAGE_DELEGATE routing hint", () => {
  it("excludes UI view switching so the planner routes it to VIEWS", () => {
    expect(pageDelegateAction.routingHint).toContain(
      "Do not use PAGE_DELEGATE",
    );
    expect(pageDelegateAction.routingHint).toContain("opening/closing views");
    expect(pageDelegateAction.routingHint).toContain("those belong to VIEWS");
  });
});
