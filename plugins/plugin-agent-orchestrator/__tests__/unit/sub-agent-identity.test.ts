import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUB_AGENT_IDENTITY_MD,
  writeWorkspaceIdentity,
} from "../../src/services/sub-agent-identity.js";

describe("writeWorkspaceIdentity", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "identity-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds both AGENTS.md and CLAUDE.md into a bare workspace", async () => {
    await writeWorkspaceIdentity(dir);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(
      SUB_AGENT_IDENTITY_MD,
    );
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(
      SUB_AGENT_IDENTITY_MD,
    );
  });

  it("states the non-interactive HARD RULE", () => {
    expect(SUB_AGENT_IDENTITY_MD).toMatch(/Non-interactive \(HARD RULE\)/);
    expect(SUB_AGENT_IDENTITY_MD).toMatch(/NEVER ask the user/);
  });

  it("tells the sub-agent to override a parent-dir workspace assignment", () => {
    expect(SUB_AGENT_IDENTITY_MD).toMatch(
      /IGNORE any such parent-directory workspace assignment/,
    );
  });

  it("tells the sub-agent to lead with the deliverable and not narrate process", () => {
    expect(SUB_AGENT_IDENTITY_MD).toMatch(/Lead with the DELIVERABLE/);
    expect(SUB_AGENT_IDENTITY_MD).toMatch(/Do NOT narrate your process/);
    // and to not go hunting for context files a bare workspace lacks
    expect(SUB_AGENT_IDENTITY_MD).toMatch(/SOUL\.md/);
  });

  it("does NOT clobber a real project's existing AGENTS.md", async () => {
    const original = "# my real project\n";
    writeFileSync(join(dir, "AGENTS.md"), original, "utf8");
    await writeWorkspaceIdentity(dir);
    // existing AGENTS.md untouched, and no CLAUDE.md injected alongside it
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(original);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("skips when only a CLAUDE.md already exists", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# existing\n", "utf8");
    await writeWorkspaceIdentity(dir);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });
});
