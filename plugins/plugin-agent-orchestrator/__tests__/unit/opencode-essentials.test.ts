import { describe, expect, it } from "vitest";
import { OPENCODE_SKILL_ESSENTIALS } from "../../src/services/opencode-essentials.ts";

/**
 * Pinned content for the opencode sub-agent brief.
 *
 * Background: opencode is the third coding-agent adapter wired in (after
 * Claude and Codex). It runs through the shell adapter under the hood, so
 * the orchestrator writes its brief explicitly to `<workdir>/AGENTS.md`
 * before spawn. These tests pin the must-have rules so a future "let's
 * simplify the brief" refactor cannot silently drop the sub-agent
 * contract.
 */
describe("OPENCODE_SKILL_ESSENTIALS", () => {
  it("anchors on the DECISION protocol", () => {
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("# DECISION protocol");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain(
      "greps your stdout for lines starting with",
    );
  });

  it("forbids re-auth / provider switching that breaks the injected config", () => {
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("opencode auth");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("OPENCODE_CONFIG_CONTENT");
  });

  it("blocks the human-handoff escape hatches Claude/Codex briefs also block", () => {
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("run this in your terminal");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("there is no human");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain(
      "Push to git remotes, write outside your workdir, print secret env values",
    );
  });

  it("documents the parent runtime bridge endpoints", () => {
    expect(OPENCODE_SKILL_ESSENTIALS).toContain(
      "/api/coding-agents/<sessionId>/parent-context",
    );
    expect(OPENCODE_SKILL_ESSENTIALS).toContain(
      "/api/coding-agents/<sessionId>/memory",
    );
    expect(OPENCODE_SKILL_ESSENTIALS).toContain(
      "/api/coding-agents/<sessionId>/active-workspaces",
    );
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("Loopback-only");
  });

  it("calls out the opencode tool set (so the model doesn't fish for tools it doesn't have)", () => {
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("`bash`");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("`read`");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("`write`");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("`edit`");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("`grep`");
  });

  it("preserves the sealed-env reminder", () => {
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("Sealed env");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("PARALLAX_SESSION_ID");
    expect(OPENCODE_SKILL_ESSENTIALS).toContain("OPENCODE_CONFIG_CONTENT");
  });
});
