import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findKeywordTermMatch: vi.fn(),
  getValidationKeywordTerms: vi.fn(),
}));

vi.mock("@elizaos/shared", () => mocks);

import { looksLikeCodingTaskRequest } from "./coding-task-request";

describe("looksLikeCodingTaskRequest", () => {
  it("returns false and skips keyword loading for blank input", () => {
    expect(looksLikeCodingTaskRequest("")).toBe(false);
    expect(looksLikeCodingTaskRequest("   ")).toBe(false);
    expect(mocks.getValidationKeywordTerms).not.toHaveBeenCalled();
  });

  it("loads the coding-task keyword set with all locales", () => {
    mocks.getValidationKeywordTerms.mockReturnValue([["app", "build"]]);
    mocks.findKeywordTermMatch.mockReturnValue(undefined);
    looksLikeCodingTaskRequest("hello world");
    expect(mocks.getValidationKeywordTerms).toHaveBeenCalledWith(
      "validate.codingTaskRequest",
      { includeAllLocales: true },
    );
  });

  it("returns true when a keyword term matches", () => {
    mocks.getValidationKeywordTerms.mockReturnValue([["build"]]);
    mocks.findKeywordTermMatch.mockReturnValue("build");
    expect(looksLikeCodingTaskRequest("build an app")).toBe(true);
  });

  it("returns false when no keyword term matches", () => {
    mocks.getValidationKeywordTerms.mockReturnValue([["build", "create"]]);
    mocks.findKeywordTermMatch.mockReturnValue(undefined);
    expect(looksLikeCodingTaskRequest("remind me to stretch")).toBe(false);
  });

  it("passes the trimmed text to the matcher", () => {
    mocks.getValidationKeywordTerms.mockReturnValue([["build"]]);
    mocks.findKeywordTermMatch.mockReturnValue(undefined);
    looksLikeCodingTaskRequest("  build an app  ");
    expect(mocks.findKeywordTermMatch).toHaveBeenCalledWith("build an app", [
      ["build"],
    ]);
  });

  it("does not match a whitespace-only string after trimming", () => {
    mocks.getValidationKeywordTerms.mockReset();
    mocks.findKeywordTermMatch.mockReset();
    expect(looksLikeCodingTaskRequest("\t\n ")).toBe(false);
    expect(mocks.getValidationKeywordTerms).not.toHaveBeenCalled();
  });
});
