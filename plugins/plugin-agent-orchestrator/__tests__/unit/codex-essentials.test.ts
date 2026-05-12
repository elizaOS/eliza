import { describe, expect, it } from "vitest";
import { CODEX_SKILL_ESSENTIALS } from "../../src/services/codex-essentials.ts";

/**
 * Pinned content for the codex sub-agent brief. The codex brief was
 * previously a single tool-discovery line; it was promoted to a full
 * brief at Claude-parity when the opencode adapter landed. These tests
 * keep that parity intact.
 */
describe("CODEX_SKILL_ESSENTIALS", () => {
  it("anchors on the DECISION protocol", () => {
    expect(CODEX_SKILL_ESSENTIALS).toContain("# DECISION protocol");
    expect(CODEX_SKILL_ESSENTIALS).toContain(
      "greps your stdout for lines starting with",
    );
  });

  it("forbids re-prompting the approval policy or sandbox mode", () => {
    expect(CODEX_SKILL_ESSENTIALS).toContain(
      "Re-prompt for approval or sandbox mode changes",
    );
    expect(CODEX_SKILL_ESSENTIALS).toContain("$CODEX_HOME/config.toml");
  });

  it("blocks the human-handoff escape hatches Claude/OpenCode briefs also block", () => {
    expect(CODEX_SKILL_ESSENTIALS).toContain("run this in your terminal");
    expect(CODEX_SKILL_ESSENTIALS).toContain("there is no human");
  });

  it("documents the parent runtime bridge endpoints", () => {
    expect(CODEX_SKILL_ESSENTIALS).toContain(
      "/api/coding-agents/<sessionId>/parent-context",
    );
    expect(CODEX_SKILL_ESSENTIALS).toContain(
      "/api/coding-agents/<sessionId>/memory",
    );
    expect(CODEX_SKILL_ESSENTIALS).toContain(
      "/api/coding-agents/<sessionId>/active-workspaces",
    );
  });

  it("calls out codex's built-in tool set", () => {
    expect(CODEX_SKILL_ESSENTIALS).toContain("`exec_command`");
    expect(CODEX_SKILL_ESSENTIALS).toContain("`apply_patch`");
    expect(CODEX_SKILL_ESSENTIALS).toContain("`read_file`");
  });

  it("preserves the sealed-env reminder", () => {
    expect(CODEX_SKILL_ESSENTIALS).toContain("Sealed env");
    expect(CODEX_SKILL_ESSENTIALS).toContain("CODEX_HOME");
    expect(CODEX_SKILL_ESSENTIALS).toContain("PARALLAX_SESSION_ID");
  });
});
