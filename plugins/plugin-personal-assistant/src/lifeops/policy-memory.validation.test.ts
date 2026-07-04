/**
 * LifeOps policy-rule validation (#8801). A policy rule governs what an
 * automation may do (read_aloud, delete, send, spend_money…) and with what
 * effect (allow / deny / require_approval). It is loaded from untrusted memory,
 * so a malformed rule must be REJECTED with a precise error rather than silently
 * treated as permissive. Each field check is asserted to fire only when that
 * field is wrong (robust to the rule's other sub-checks).
 */
import { describe, expect, it } from "vitest";
import { validateLifeOpsPolicyRule } from "./policy-memory.ts";

const base = {
  kind: "lifeops_policy_rule",
  id: "rule-1",
  version: 1,
  operations: ["send"],
  effect: "require_approval",
  precedence: 10,
};
const errs = (rule: unknown) => validateLifeOpsPolicyRule(rule).errors;
const has = (rule: unknown, msg: string) =>
  errs(rule).some((e) => e.includes(msg));

describe("validateLifeOpsPolicyRule", () => {
  it("rejects a non-object outright", () => {
    for (const bad of [null, undefined, "rule", 42]) {
      const r = validateLifeOpsPolicyRule(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("rule must be an object");
    }
  });

  it("requires kind === lifeops_policy_rule", () => {
    expect(
      has({ ...base, kind: "other" }, "kind must be lifeops_policy_rule"),
    ).toBe(true);
    expect(has(base, "kind must be lifeops_policy_rule")).toBe(false);
  });

  it("requires a non-empty id (and reports it as ruleId)", () => {
    expect(has({ ...base, id: "" }, "id is required")).toBe(true);
    expect(has(base, "id is required")).toBe(false);
    expect(validateLifeOpsPolicyRule(base).ruleId).toBe("rule-1");
  });

  it("requires version 1", () => {
    expect(has({ ...base, version: 2 }, "version must be 1")).toBe(true);
    expect(has(base, "version must be 1")).toBe(false);
  });

  it("requires at least one operation", () => {
    expect(
      has(
        { ...base, operations: [] },
        "operations must contain at least one operation",
      ),
    ).toBe(true);
    expect(has(base, "operations must contain at least one operation")).toBe(
      false,
    );
  });

  it("requires a supported effect", () => {
    expect(has({ ...base, effect: "nuke" }, "effect is unsupported")).toBe(
      true,
    );
    expect(has(base, "effect is unsupported")).toBe(false);
  });

  it("requires an integer precedence", () => {
    expect(
      has({ ...base, precedence: 1.5 }, "precedence must be an integer"),
    ).toBe(true);
    expect(has(base, "precedence must be an integer")).toBe(false);
  });
});
