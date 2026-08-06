import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkills } from "./skills";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverSkills", () => {
  it("discovers project skills from parent directories up to the git root", () => {
    const repoRoot = makeTempDir("grok-skills-root-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const nested = path.join(repoRoot, "tmp", "app");
    fs.mkdirSync(nested, { recursive: true });

    writeSkill(repoRoot, "agent-browser", "Host browser smoke testing");

    const skills = discoverSkills(nested);
    expect(skills.map((skill) => skill.name)).toContain("agent-browser");
    expect(skills.find((skill) => skill.name === "agent-browser")?.scope).toBe("project");
  });

  it("lets nearer project skills override parent project skills", () => {
    const repoRoot = makeTempDir("grok-skills-override-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const nested = path.join(repoRoot, "tmp", "app");
    fs.mkdirSync(nested, { recursive: true });

    writeSkill(repoRoot, "agent-browser", "Root browser skill");
    writeSkill(path.join(repoRoot, "tmp"), "agent-browser", "Nested browser skill");

    const skills = discoverSkills(nested);
    expect(skills.find((skill) => skill.name === "agent-browser")?.description).toBe("Nested browser skill");
  });
});
