/**
 * Unit tests for the per-spawn git identity materialization. Pure functions:
 * a synthetic value source stands in for `readConfigEnvKey`, so no config file,
 * env mutation, or spawn is needed. Covers the fail-safe (nothing configured =>
 * empty patch => untouched spawn env), the half-configured guards, committer
 * defaulting, and the Co-authored-by trailer rendering.
 */

import { describe, expect, it } from "vitest";
import {
  buildGitIdentityEnvPatch,
  GIT_IDENTITY_AUTHOR_EMAIL_KEY,
  GIT_IDENTITY_AUTHOR_NAME_KEY,
  GIT_IDENTITY_CO_AUTHOR_KEY,
  GIT_IDENTITY_COMMITTER_EMAIL_KEY,
  GIT_IDENTITY_COMMITTER_NAME_KEY,
  parseCoAuthor,
  renderCoAuthorTrailer,
  resolveGitIdentityConfig,
  syntheticNoReplyEmail,
} from "../services/git-identity-env";

/** Build a value source from a plain record (missing keys => undefined). */
function source(map: Record<string, string>) {
  return (key: string): string | undefined => map[key];
}

describe("resolveGitIdentityConfig", () => {
  it("returns undefined when nothing is configured (fail-safe)", () => {
    expect(resolveGitIdentityConfig(source({}))).toBeUndefined();
  });

  it("treats whitespace-only values as unconfigured", () => {
    expect(
      resolveGitIdentityConfig(
        source({
          [GIT_IDENTITY_AUTHOR_NAME_KEY]: "   ",
          [GIT_IDENTITY_AUTHOR_EMAIL_KEY]: "\t",
        }),
      ),
    ).toBeUndefined();
  });

  it("trims and returns each configured field", () => {
    const cfg = resolveGitIdentityConfig(
      source({
        [GIT_IDENTITY_AUTHOR_NAME_KEY]: "  Eliza Agent  ",
        [GIT_IDENTITY_AUTHOR_EMAIL_KEY]: " agent@elizaos.ai ",
        [GIT_IDENTITY_COMMITTER_NAME_KEY]: "CI Bot",
        [GIT_IDENTITY_COMMITTER_EMAIL_KEY]: "ci@elizaos.ai",
        [GIT_IDENTITY_CO_AUTHOR_KEY]: "Shadow <shadow@shad0w.xyz>",
      }),
    );
    expect(cfg).toEqual({
      authorName: "Eliza Agent",
      authorEmail: "agent@elizaos.ai",
      committerName: "CI Bot",
      committerEmail: "ci@elizaos.ai",
      coAuthor: "Shadow <shadow@shad0w.xyz>",
    });
  });

  it("returns a config for a co-author-only setup", () => {
    const cfg = resolveGitIdentityConfig(
      source({ [GIT_IDENTITY_CO_AUTHOR_KEY]: "Pair <pair@x.dev>" }),
    );
    expect(cfg).toEqual({ coAuthor: "Pair <pair@x.dev>" });
  });
});

describe("buildGitIdentityEnvPatch", () => {
  it("returns an empty patch for undefined config (spawn env untouched)", () => {
    expect(buildGitIdentityEnvPatch(undefined)).toEqual({});
  });

  it("returns an empty patch for a co-author-only config (trailer, not env)", () => {
    expect(
      buildGitIdentityEnvPatch({ coAuthor: "Pair <pair@x.dev>" }),
    ).toEqual({});
  });

  it("materializes author + defaults committer to the author", () => {
    const patch = buildGitIdentityEnvPatch({
      authorName: "Eliza Agent",
      authorEmail: "agent@elizaos.ai",
    });
    expect(patch).toEqual({
      GIT_AUTHOR_NAME: "Eliza Agent",
      GIT_AUTHOR_EMAIL: "agent@elizaos.ai",
      GIT_COMMITTER_NAME: "Eliza Agent",
      GIT_COMMITTER_EMAIL: "agent@elizaos.ai",
    });
  });

  it("honors a distinct committer identity", () => {
    const patch = buildGitIdentityEnvPatch({
      authorName: "Eliza Agent",
      authorEmail: "agent@elizaos.ai",
      committerName: "CI Bot",
      committerEmail: "ci@elizaos.ai",
    });
    expect(patch).toEqual({
      GIT_AUTHOR_NAME: "Eliza Agent",
      GIT_AUTHOR_EMAIL: "agent@elizaos.ai",
      GIT_COMMITTER_NAME: "CI Bot",
      GIT_COMMITTER_EMAIL: "ci@elizaos.ai",
    });
  });

  it("synthesizes a no-reply email when only the author name is configured", () => {
    const patch = buildGitIdentityEnvPatch({ authorName: "Eliza Agent" });
    expect(patch.GIT_AUTHOR_NAME).toBe("Eliza Agent");
    expect(patch.GIT_AUTHOR_EMAIL).toBe("eliza-agent.no-reply@elizaos.local");
    // committer defaults to the (now fully-formed) author.
    expect(patch.GIT_COMMITTER_NAME).toBe("Eliza Agent");
    expect(patch.GIT_COMMITTER_EMAIL).toBe(
      "eliza-agent.no-reply@elizaos.local",
    );
  });

  it("drops an email-only config (no name => git can't use it)", () => {
    expect(
      buildGitIdentityEnvPatch({ authorEmail: "agent@elizaos.ai" }),
    ).toEqual({});
  });

  it("seeds the author from a committer-only config (no leak / no fresh-box fail)", () => {
    // Committer-only must NOT leave GIT_AUTHOR_* unset — git would then resolve
    // the author from the child's global config or fail on a fresh host.
    const patch = buildGitIdentityEnvPatch({
      committerName: "CI Bot",
      committerEmail: "ci@elizaos.ai",
    });
    expect(patch).toEqual({
      GIT_AUTHOR_NAME: "CI Bot",
      GIT_AUTHOR_EMAIL: "ci@elizaos.ai",
      GIT_COMMITTER_NAME: "CI Bot",
      GIT_COMMITTER_EMAIL: "ci@elizaos.ai",
    });
  });

  it("seeds the author from a committer-name-only config with a synthetic email", () => {
    const patch = buildGitIdentityEnvPatch({ committerName: "CI Bot" });
    expect(patch).toEqual({
      GIT_AUTHOR_NAME: "CI Bot",
      GIT_AUTHOR_EMAIL: "ci-bot.no-reply@elizaos.local",
      GIT_COMMITTER_NAME: "CI Bot",
      GIT_COMMITTER_EMAIL: "ci-bot.no-reply@elizaos.local",
    });
  });

  it("synthesizes a committer email when only a committer name is given", () => {
    const patch = buildGitIdentityEnvPatch({
      authorName: "Eliza Agent",
      authorEmail: "agent@elizaos.ai",
      committerName: "CI Bot",
    });
    expect(patch.GIT_COMMITTER_NAME).toBe("CI Bot");
    expect(patch.GIT_COMMITTER_EMAIL).toBe("ci-bot.no-reply@elizaos.local");
  });
});

describe("syntheticNoReplyEmail", () => {
  it("slugifies the name into a stable local no-reply address", () => {
    expect(syntheticNoReplyEmail("Eliza Agent")).toBe(
      "eliza-agent.no-reply@elizaos.local",
    );
    expect(syntheticNoReplyEmail("  Weird!!Name## ")).toBe(
      "weird-name.no-reply@elizaos.local",
    );
  });

  it("falls back to `agent` when the name slugifies to empty", () => {
    expect(syntheticNoReplyEmail("###")).toBe("agent.no-reply@elizaos.local");
  });
});

describe("parseCoAuthor", () => {
  it("splits `Name <email>`", () => {
    expect(parseCoAuthor("Shadow <shadow@shad0w.xyz>")).toEqual({
      name: "Shadow",
      email: "shadow@shad0w.xyz",
    });
  });

  it("returns a bare name when no email is present", () => {
    expect(parseCoAuthor("Just A Name")).toEqual({ name: "Just A Name" });
  });

  it("returns undefined for empty / whitespace", () => {
    expect(parseCoAuthor(undefined)).toBeUndefined();
    expect(parseCoAuthor("   ")).toBeUndefined();
  });

  it("rejects an angle-only string with no name", () => {
    expect(parseCoAuthor("<only@email.dev>")).toBeUndefined();
  });
});

describe("renderCoAuthorTrailer", () => {
  it("renders the trailer line from a Name <email> config", () => {
    expect(
      renderCoAuthorTrailer({ coAuthor: "Shadow <shadow@shad0w.xyz>" }),
    ).toBe("Co-authored-by: Shadow <shadow@shad0w.xyz>");
  });

  it("synthesizes an email for a bare-name co-author", () => {
    expect(renderCoAuthorTrailer({ coAuthor: "Shadow" })).toBe(
      "Co-authored-by: Shadow <shadow.no-reply@elizaos.local>",
    );
  });

  it("returns undefined when no co-author is configured", () => {
    expect(renderCoAuthorTrailer(undefined)).toBeUndefined();
    expect(renderCoAuthorTrailer({ authorName: "X" })).toBeUndefined();
  });
});
