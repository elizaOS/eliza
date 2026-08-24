import { describe, expect, it } from "vitest";
import { BlockRuleRowError, rowToBlockRule } from "./block-rule-schema.ts";

describe("rowToBlockRule", () => {
  it("parses a valid row", () => {
    const rule = rowToBlockRule({
      id: "1",
      user_id: "u1",
      agent_id: "a1",
      profile: "default",
      created_at: 123,
      active: true,
      websites: '["facebook.com","youtube.com"]',
      gate_type: "fixed_duration",
      minutes: 30,
    });
    expect(rule.websites).toEqual(["facebook.com", "youtube.com"]);
    expect(rule.gateType).toBe("fixed_duration");
  });

  it("accepts websites as arrays", () => {
    const rule = rowToBlockRule({
      id: "1",
      user_id: "u1",
      agent_id: "a1",
      profile: "default",
      created_at: 123,
      active: true,
      websites: ["a.com"],
      gate_type: "fixed_duration",
      minutes: 30,
    });
    expect(rule.websites).toEqual(["a.com"]);
  });

  it("rejects malformed websites json", () => {
    expect(() =>
      rowToBlockRule({
        id: "1",
        user_id: "u1",
        agent_id: "a1",
        profile: "default",
        created_at: 123,
        active: true,
        websites: "not-json",
        gate_type: "fixed_duration",
        minutes: 30,
      }),
    ).toThrow(Error);
  });

  it("rejects non-finite numbers", () => {
    expect(() =>
      rowToBlockRule({
        id: "1",
        user_id: "u1",
        agent_id: "a1",
        profile: "default",
        created_at: 123,
        active: true,
        websites: ["a.com"],
        gate_type: "fixed_duration",
        fixed_duration_ms: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(BlockRuleRowError);
  });

  it("rejects unknown gate types", () => {
    expect(() =>
      rowToBlockRule({
        id: "1",
        user_id: "u1",
        agent_id: "a1",
        profile: "default",
        created_at: 123,
        active: true,
        websites: ["a.com"],
        gate_type: "bogus",
        minutes: 30,
      }),
    ).toThrow(BlockRuleRowError);
  });
});
