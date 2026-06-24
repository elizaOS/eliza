import { describe, expect, it } from "bun:test";
import {
  getAllDomainCategories,
  getAllSkillCategories,
  validateOASFDomainPath,
  validateOASFSkillPath,
} from "../../shared/src/utils/oasf-skill-mapper";

/**
 * OASF skill/domain path validation gates the agent-capability taxonomy paths.
 * Only lowercase alphanumeric + underscore segments joined by single slashes
 * are valid — a loose check would let malformed/injected paths into discovery.
 */

describe("validateOASFSkillPath / validateOASFDomainPath", () => {
  it("accepts well-formed hierarchical paths", () => {
    expect(validateOASFSkillPath("trading")).toBe(true);
    expect(validateOASFSkillPath("finance_and_business/trading_and_markets")).toBe(
      true,
    );
    expect(validateOASFDomainPath("a/b/c")).toBe(true);
  });

  it("rejects malformed paths", () => {
    expect(validateOASFSkillPath("Invalid!")).toBe(false); // uppercase + punctuation
    expect(validateOASFSkillPath("")).toBe(false);
    expect(validateOASFSkillPath("a//b")).toBe(false); // empty segment
    expect(validateOASFSkillPath("/leading")).toBe(false);
    expect(validateOASFSkillPath("trailing/")).toBe(false);
    expect(validateOASFDomainPath("has space")).toBe(false);
  });
});

describe("category enumerations", () => {
  it("return non-empty arrays of well-formed paths", () => {
    const skills = getAllSkillCategories();
    const domains = getAllDomainCategories();
    expect(skills.length).toBeGreaterThan(0);
    expect(domains.length).toBeGreaterThan(0);
    expect(skills.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
  });
});
