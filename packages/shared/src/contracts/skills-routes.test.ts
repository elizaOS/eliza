/**
 * Exercises the real request schemas for local skill management and direct
 * GitHub installation, including strict-input rejection.
 */

import { describe, expect, it } from "vitest";
import {
  PostSkillAcknowledgeRequestSchema,
  PostSkillCreateRequestSchema,
  PostSkillInstallRequestSchema,
  PutSkillSourceRequestSchema,
} from "./skills-routes.js";

describe("PostSkillInstallRequestSchema", () => {
  it("accepts and trims a GitHub URL", () => {
    expect(
      PostSkillInstallRequestSchema.parse({
        githubUrl: " https://github.com/foo/bar ",
      }),
    ).toEqual({ githubUrl: "https://github.com/foo/bar" });
  });

  it("rejects non-GitHub URLs and extra fields", () => {
    expect(() =>
      PostSkillInstallRequestSchema.parse({
        githubUrl: "https://example.com/foo/bar",
      }),
    ).toThrow(/github\.com/);
    expect(() =>
      PostSkillInstallRequestSchema.parse({
        githubUrl: "https://github.com/foo/bar",
        slug: "bar",
      }),
    ).toThrow();
  });
});

describe("PostSkillAcknowledgeRequestSchema", () => {
  it("accepts the optional boolean and rejects extras", () => {
    expect(PostSkillAcknowledgeRequestSchema.parse({})).toEqual({});
    expect(PostSkillAcknowledgeRequestSchema.parse({ enable: true })).toEqual({
      enable: true,
    });
    expect(() =>
      PostSkillAcknowledgeRequestSchema.parse({ enable: "yes" }),
    ).toThrow();
  });
});

describe("PostSkillCreateRequestSchema", () => {
  it("trims required and optional text", () => {
    expect(
      PostSkillCreateRequestSchema.parse({
        name: "  My Skill  ",
        description: "  does stuff  ",
      }),
    ).toEqual({ name: "My Skill", description: "does stuff" });
  });

  it("rejects empty names and extra fields", () => {
    expect(() => PostSkillCreateRequestSchema.parse({ name: " " })).toThrow(
      /name is required/,
    );
    expect(() =>
      PostSkillCreateRequestSchema.parse({ name: "x", category: "y" }),
    ).toThrow();
  });
});

describe("PutSkillSourceRequestSchema", () => {
  it("accepts arbitrary content and rejects extra fields", () => {
    expect(PutSkillSourceRequestSchema.parse({ content: "" })).toEqual({
      content: "",
    });
    expect(() =>
      PutSkillSourceRequestSchema.parse({ content: "x", path: "/a" }),
    ).toThrow();
  });
});
