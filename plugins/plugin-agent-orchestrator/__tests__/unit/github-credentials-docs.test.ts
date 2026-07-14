/**
 * Keeps the orchestrator's GitHub credential documentation aligned with the
 * settings its issue and workspace paths actually consume, including the
 * multi-agent process-environment isolation constraint.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(`${pkgRoot}/${rel}`, "utf8");

const workspaceGithubSrc = read("src/services/workspace-github.ts");
const readme = read("README.md");
const claudeMd = read("CLAUDE.md");
const agentsMd = read("AGENTS.md");

// The credential setting names the code actually consults, extracted from source
// rather than hard-coded here, so renaming a setting fails this test until docs follow.
function githubSettingNames(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/getSetting\(\s*["'](GITHUB_[A-Z_]+)["']/g)) {
    names.add(m[1]);
  }
  return [...names];
}

describe("agent-scoped GitHub credential documentation", () => {
  const settings = githubSettingNames(workspaceGithubSrc);

  it("extracts the expected credential settings from workspace-github.ts", () => {
    expect(settings).toEqual(
      expect.arrayContaining(["GITHUB_TOKEN", "GITHUB_OAUTH_CLIENT_ID"]),
    );
  });

  it("README documents every credential setting the code reads", () => {
    for (const name of settings) {
      expect(readme, `README must document ${name}`).toContain(name);
    }
  });

  it("README distinguishes PAT from OAuth device flow", () => {
    expect(readme).toMatch(/PAT|personal access token/i);
    expect(readme).toMatch(/device flow/i);
  });

  it("README states the multi-tenant vault-vs-env safety point", () => {
    expect(readme).toMatch(/vault|settings/i);
    expect(readme).toMatch(/process env/i);
    expect(readme).toMatch(/multi-tenant|shared host|every agent/i);
  });

  it("README names the capabilities that require a token", () => {
    expect(readme).toContain("TASKS_MANAGE_ISSUES");
    expect(readme).toContain("TASKS_SUBMIT_WORKSPACE");
  });

  it("CLAUDE.md and AGENTS.md mirror the key credential point and stay identical", () => {
    expect(claudeMd).toBe(agentsMd);
    for (const name of settings) {
      expect(claudeMd, `CLAUDE.md must document ${name}`).toContain(name);
    }
    expect(claudeMd).toMatch(/vault|getSetting/);
  });
});
