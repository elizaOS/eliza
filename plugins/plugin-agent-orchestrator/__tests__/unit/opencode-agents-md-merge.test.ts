import { describe, expect, it } from "vitest";
import {
  mergeOpencodeAgentsMd,
  OPENCODE_AGENTS_MD_BEGIN_MARKER,
  OPENCODE_AGENTS_MD_END_MARKER,
} from "../../src/services/pty-service.ts";

/**
 * The orchestrator writes `<workdir>/AGENTS.md` before spawning opencode.
 * If the workdir already has an AGENTS.md (e.g. the user is running
 * inside a project that ships its own rules) we must not clobber it.
 * The merge helper is responsible for that — these tests pin the
 * contract so future refactors can't regress it.
 */
describe("mergeOpencodeAgentsMd", () => {
  const brief = "DECISION protocol. NEVER do X. workspace-locked.";

  it("creates a marker-wrapped block when no existing AGENTS.md is present", () => {
    const result = mergeOpencodeAgentsMd("", brief);
    expect(result).toBe(
      `${OPENCODE_AGENTS_MD_BEGIN_MARKER}\n${brief}\n${OPENCODE_AGENTS_MD_END_MARKER}`,
    );
  });

  it("prepends the brief block above existing project rules", () => {
    const existing = "# Project Rules\n\nUse snake_case.\n";
    const result = mergeOpencodeAgentsMd(existing, brief);
    expect(result.startsWith(OPENCODE_AGENTS_MD_BEGIN_MARKER)).toBe(true);
    expect(result).toContain(OPENCODE_AGENTS_MD_END_MARKER);
    expect(result).toContain("# Project Rules");
    expect(result).toContain("Use snake_case.");
    // Brief block must end before the user's content starts
    const endIdx = result.indexOf(OPENCODE_AGENTS_MD_END_MARKER);
    const projectIdx = result.indexOf("# Project Rules");
    expect(endIdx).toBeLessThan(projectIdx);
  });

  it("is idempotent — re-running on its own output yields the same content", () => {
    const existing = "# Project Rules\n\nUse snake_case.\n";
    const once = mergeOpencodeAgentsMd(existing, brief);
    const twice = mergeOpencodeAgentsMd(once, brief);
    expect(twice).toBe(once);
  });

  it("strips an outdated brief block before injecting the new one", () => {
    const stale = `${OPENCODE_AGENTS_MD_BEGIN_MARKER}\nOLD STALE BRIEF\n${OPENCODE_AGENTS_MD_END_MARKER}\n\n# Project Rules\n\nUse snake_case.\n`;
    const result = mergeOpencodeAgentsMd(stale, brief);
    expect(result).not.toContain("OLD STALE BRIEF");
    expect(result).toContain(brief);
    expect(result).toContain("# Project Rules");
  });

  it("preserves the user's content as the second section after the markers", () => {
    const existing = "Custom project rule one.\nCustom project rule two.\n";
    const result = mergeOpencodeAgentsMd(existing, brief);
    const stripped = result
      .replace(
        new RegExp(
          `${OPENCODE_AGENTS_MD_BEGIN_MARKER}[\\s\\S]*?${OPENCODE_AGENTS_MD_END_MARKER}\\n*`,
        ),
        "",
      )
      .trim();
    expect(stripped).toBe(existing.trim());
  });

  it("does not produce a trailing-marker block when existing was only a prior brief", () => {
    const onlyOldBrief = `${OPENCODE_AGENTS_MD_BEGIN_MARKER}\nOLD\n${OPENCODE_AGENTS_MD_END_MARKER}`;
    const result = mergeOpencodeAgentsMd(onlyOldBrief, brief);
    expect(result).toBe(
      `${OPENCODE_AGENTS_MD_BEGIN_MARKER}\n${brief}\n${OPENCODE_AGENTS_MD_END_MARKER}`,
    );
  });
});
