import { describe, expect, it } from "vitest";
import {
  PostMarketplaceInstallRequestSchema,
  PostMarketplaceUninstallRequestSchema,
  PostSkillAcknowledgeRequestSchema,
  PostSkillCatalogInstallRequestSchema,
  PostSkillCatalogUninstallRequestSchema,
  PostSkillCreateRequestSchema,
  PutMarketplaceConfigRequestSchema,
  PutSkillSourceRequestSchema,
} from "./skills-routes.js";

describe("PostSkillCatalogInstallRequestSchema", () => {
  it("accepts slug only and trims", () => {
    const parsed = PostSkillCatalogInstallRequestSchema.parse({
      slug: "  weather  ",
    });
    expect(parsed).toEqual({ slug: "weather" });
  });

  it("accepts slug + version, trims both", () => {
    const parsed = PostSkillCatalogInstallRequestSchema.parse({
      slug: "weather",
      version: "  1.2.3 ",
    });
    expect(parsed).toEqual({ slug: "weather", version: "1.2.3" });
  });

  it("absorbs whitespace-only version as absent", () => {
    const parsed = PostSkillCatalogInstallRequestSchema.parse({
      slug: "weather",
      version: "   ",
    });
    expect(parsed).toEqual({ slug: "weather" });
  });

  it("rejects whitespace-only slug", () => {
    expect(() =>
      PostSkillCatalogInstallRequestSchema.parse({ slug: "   " }),
    ).toThrow(/slug is required/);
  });

  it("rejects missing slug", () => {
    expect(() => PostSkillCatalogInstallRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostSkillCatalogInstallRequestSchema.parse({
        slug: "weather",
        force: true,
      }),
    ).toThrow();
  });
});

describe("PostSkillCatalogUninstallRequestSchema", () => {
  it("trims slug", () => {
    expect(
      PostSkillCatalogUninstallRequestSchema.parse({ slug: " weather " }),
    ).toEqual({ slug: "weather" });
  });

  it("rejects whitespace-only slug", () => {
    expect(() =>
      PostSkillCatalogUninstallRequestSchema.parse({ slug: " " }),
    ).toThrow(/slug is required/);
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostSkillCatalogUninstallRequestSchema.parse({
        slug: "x",
        cascade: true,
      }),
    ).toThrow();
  });
});

describe("PostSkillAcknowledgeRequestSchema", () => {
  it("accepts empty body", () => {
    expect(PostSkillAcknowledgeRequestSchema.parse({})).toEqual({});
  });

  it("accepts enable=true", () => {
    expect(PostSkillAcknowledgeRequestSchema.parse({ enable: true })).toEqual({
      enable: true,
    });
  });

  it("accepts enable=false", () => {
    expect(PostSkillAcknowledgeRequestSchema.parse({ enable: false })).toEqual({
      enable: false,
    });
  });

  it("rejects non-boolean enable", () => {
    expect(() =>
      PostSkillAcknowledgeRequestSchema.parse({ enable: "yes" }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostSkillAcknowledgeRequestSchema.parse({ enable: true, extra: 1 }),
    ).toThrow();
  });
});

describe("PostSkillCreateRequestSchema", () => {
  it("trims name and description", () => {
    expect(
      PostSkillCreateRequestSchema.parse({
        name: "  My Skill  ",
        description: "  does stuff  ",
      }),
    ).toEqual({ name: "My Skill", description: "does stuff" });
  });

  it("absorbs whitespace-only description as absent", () => {
    expect(
      PostSkillCreateRequestSchema.parse({
        name: "skillz",
        description: "   ",
      }),
    ).toEqual({ name: "skillz" });
  });

  it("rejects whitespace-only name", () => {
    expect(() => PostSkillCreateRequestSchema.parse({ name: " " })).toThrow(
      /name is required/,
    );
  });

  it("rejects missing name", () => {
    expect(() => PostSkillCreateRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostSkillCreateRequestSchema.parse({ name: "x", category: "y" }),
    ).toThrow();
  });
});

describe("PutSkillSourceRequestSchema", () => {
  it("accepts arbitrary content (including empty string)", () => {
    expect(PutSkillSourceRequestSchema.parse({ content: "" })).toEqual({
      content: "",
    });
    expect(PutSkillSourceRequestSchema.parse({ content: "# hi" })).toEqual({
      content: "# hi",
    });
  });

  it("rejects missing content", () => {
    expect(() => PutSkillSourceRequestSchema.parse({})).toThrow();
  });

  it("rejects non-string content", () => {
    expect(() => PutSkillSourceRequestSchema.parse({ content: 123 })).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutSkillSourceRequestSchema.parse({ content: "x", path: "/a" }),
    ).toThrow();
  });
});

describe("PostMarketplaceInstallRequestSchema", () => {
  it("accepts slug-only ClawHub install", () => {
    const parsed = PostMarketplaceInstallRequestSchema.parse({
      slug: "  weather  ",
    });
    expect(parsed).toEqual({ slug: "weather" });
  });

  it("accepts githubUrl-only install with optional name/description", () => {
    const parsed = PostMarketplaceInstallRequestSchema.parse({
      githubUrl: " https://github.com/foo/bar ",
      name: "Foo",
      description: " bar ",
    });
    expect(parsed).toEqual({
      githubUrl: "https://github.com/foo/bar",
      name: "Foo",
      description: "bar",
    });
  });

  it("accepts repository + path + source", () => {
    const parsed = PostMarketplaceInstallRequestSchema.parse({
      repository: "foo/bar",
      path: "skills/x",
      source: "manual",
    });
    expect(parsed).toEqual({
      repository: "foo/bar",
      path: "skills/x",
      source: "manual",
    });
  });

  it("rejects when slug, githubUrl, and repository all missing/whitespace", () => {
    expect(() =>
      PostMarketplaceInstallRequestSchema.parse({
        slug: " ",
        githubUrl: "",
        repository: "  ",
      }),
    ).toThrow(/at least one of/);
  });

  it("rejects when nothing is provided", () => {
    expect(() => PostMarketplaceInstallRequestSchema.parse({})).toThrow(
      /at least one of/,
    );
  });

  it("rejects unknown source value", () => {
    expect(() =>
      PostMarketplaceInstallRequestSchema.parse({
        slug: "x",
        source: "github",
      }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostMarketplaceInstallRequestSchema.parse({
        slug: "x",
        force: true,
      }),
    ).toThrow();
  });
});

describe("PostMarketplaceUninstallRequestSchema", () => {
  it("trims id", () => {
    expect(
      PostMarketplaceUninstallRequestSchema.parse({ id: "  weather  " }),
    ).toEqual({ id: "weather" });
  });

  it("rejects whitespace-only id", () => {
    expect(() =>
      PostMarketplaceUninstallRequestSchema.parse({ id: " " }),
    ).toThrow(/id is required/);
  });

  it("rejects missing id", () => {
    expect(() => PostMarketplaceUninstallRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostMarketplaceUninstallRequestSchema.parse({ id: "x", soft: true }),
    ).toThrow();
  });
});

describe("PutMarketplaceConfigRequestSchema", () => {
  it("trims apiKey", () => {
    expect(
      PutMarketplaceConfigRequestSchema.parse({ apiKey: "  secret  " }),
    ).toEqual({ apiKey: "secret" });
  });

  it("rejects whitespace-only apiKey", () => {
    expect(() =>
      PutMarketplaceConfigRequestSchema.parse({ apiKey: "   " }),
    ).toThrow(/apiKey is required/);
  });

  it("rejects missing apiKey", () => {
    expect(() => PutMarketplaceConfigRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutMarketplaceConfigRequestSchema.parse({
        apiKey: "x",
        endpoint: "https://api.foo",
      }),
    ).toThrow();
  });
});
