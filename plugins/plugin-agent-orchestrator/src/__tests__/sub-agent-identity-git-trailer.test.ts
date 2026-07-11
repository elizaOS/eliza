/**
 * Tests that the operating manual renders/strips the git commit-trailer section
 * correctly, and that a fully-unconfigured render never leaves a dangling
 * `{{GIT_TRAILER_SECTION}}` placeholder or advertises a trailer the spawn env
 * did not pin.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/config-env.js", () => ({
  readConfigEnvKey: (key: string): string | undefined => process.env[key],
}));

import {
  buildSubAgentIdentityMd,
  writeWorkspaceIdentity,
} from "../services/sub-agent-identity";

describe("buildSubAgentIdentityMd git-trailer section", () => {
  it("strips the placeholder when no co-author trailer is provided", () => {
    const md = buildSubAgentIdentityMd({});
    expect(md).not.toContain("{{GIT_TRAILER_SECTION}}");
    expect(md).not.toContain("Commit message trailer");
    expect(md).not.toContain("Co-authored-by:");
  });

  it("embeds the trailer instruction + exact line when configured", () => {
    const md = buildSubAgentIdentityMd({
      coAuthorTrailer: "Co-authored-by: Shadow <shadow@shad0w.xyz>",
    });
    expect(md).not.toContain("{{GIT_TRAILER_SECTION}}");
    expect(md).toContain(
      "## Commit message trailer (REQUIRED when you commit)",
    );
    expect(md).toContain("Co-authored-by: Shadow <shadow@shad0w.xyz>");
    // It must tell the agent NOT to set its own identity (that's env-pinned).
    expect(md).toContain("do not run `git config user.name/email`");
  });

  it("still fills the broker placeholder independently of the trailer", () => {
    const md = buildSubAgentIdentityMd({
      brokerWired: true,
      coAuthorTrailer: "Co-authored-by: Pair <pair@x.dev>",
    });
    expect(md).not.toContain("{{BROKER_SECTION}}");
    expect(md).not.toContain("{{GIT_TRAILER_SECTION}}");
    expect(md).toContain("Co-authored-by: Pair <pair@x.dev>");
  });
});

describe("writeWorkspaceIdentity — never mutates a real repo's tracked manuals", () => {
  let dir: string;
  const prevCoAuthor = process.env.ELIZA_CODING_GIT_CO_AUTHOR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acp-identity-"));
    delete process.env.ELIZA_CODING_GIT_CO_AUTHOR;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevCoAuthor === undefined)
      delete process.env.ELIZA_CODING_GIT_CO_AUTHOR;
    else process.env.ELIZA_CODING_GIT_CO_AUTHOR = prevCoAuthor;
  });

  it("leaves an existing AGENTS.md byte-identical even with a co-author configured", async () => {
    // A tracked repo manual must NEVER be dirtied by a spawn — appending an
    // Eliza stanza would leak into the agent's own `git add -A` commit/PR.
    const agentsPath = join(dir, "AGENTS.md");
    const original = "# Real repo manual\n\nDo the project-specific thing.\n";
    writeFileSync(agentsPath, original, "utf8");
    await writeWorkspaceIdentity(dir, {
      coAuthorTrailer: "Co-authored-by: Shadow <shadow@shad0w.xyz>",
    });
    expect(readFileSync(agentsPath, "utf8")).toBe(original);
  });

  it("scaffolds the trailer into a BARE workspace's manual", async () => {
    await writeWorkspaceIdentity(dir, {
      coAuthorTrailer: "Co-authored-by: Shadow <shadow@shad0w.xyz>",
    });
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("Commit message trailer");
    expect(agents).toContain("Co-authored-by: Shadow <shadow@shad0w.xyz>");
  });

  it("scaffolds a bare workspace WITHOUT the trailer section when unconfigured", async () => {
    await writeWorkspaceIdentity(dir, {});
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).not.toContain("{{GIT_TRAILER_SECTION}}");
    expect(agents).not.toContain("Commit message trailer");
  });
});
