/**
 * Verifies writeWorkspaceIdentity.
 * Runs against a real temporary filesystem; deterministic.
 */
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
  buildSubAgentIdentityMd,
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
    // Default (no broker) renders the manual with the placeholder stripped.
    const expected = buildSubAgentIdentityMd({ brokerWired: false });
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(expected);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(expected);
  });

  it("omits the broker section when the broker is not wired", async () => {
    await writeWorkspaceIdentity(dir, { brokerWired: false });
    const manual = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(manual).not.toMatch(/Asking the parent Eliza agent to act/);
    expect(manual).not.toContain("{{BROKER_SECTION}}");
  });

  it("includes the broker section only when the broker is wired", async () => {
    await writeWorkspaceIdentity(dir, { brokerWired: true });
    const manual = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(manual).toMatch(/Asking the parent Eliza agent to act \(broker\)/);
    expect(manual).toMatch(/USE_SKILL parent-agent/);
    // Discovery is advertised, but the spend/mutation gate is stated too.
    expect(manual).toMatch(
      /mutating\/paid\/destructive Cloud commands stay gated/,
    );
    // #14118: Cloud is broker-first — register + deploy run through the parent
    // (apps.create / containers.create), and the child is told it does not hold
    // the owner key; a container-runtime secret comes from the credential bridge.
    expect(manual).toMatch(/Cloud is BROKER-FIRST/);
    expect(manual).toContain('"command":"apps.create"');
    expect(manual).toContain('"command":"containers.create"');
    expect(manual).toContain("environmentVars.ELIZA_CLOUD_API_KEY");
    expect(manual).not.toContain("{{BROKER_SECTION}}");
  });

  it("buildSubAgentIdentityMd never leaves the placeholder in either mode", () => {
    expect(buildSubAgentIdentityMd({ brokerWired: true })).not.toContain(
      "{{BROKER_SECTION}}",
    );
    expect(buildSubAgentIdentityMd({ brokerWired: false })).not.toContain(
      "{{BROKER_SECTION}}",
    );
  });

  it("advertises the skills bridge endpoints and originatingTask read-back", () => {
    const manual = buildSubAgentIdentityMd();
    expect(manual).toMatch(/\/skills\b/);
    expect(manual).toMatch(/skills\/<slug>/);
    expect(manual).toMatch(/originatingTask/);
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
