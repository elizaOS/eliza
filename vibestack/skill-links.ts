import fs from "node:fs";
import path from "node:path";

export const skillRoot = ".claude/skills";
const agentDirectories = [".agents", ".cursor", ".codex", ".grok", ".gemini", ".factory", ".t3", ".droid"];

export function availableDirectory(directory: string, warn: (message: string) => void): boolean {
  const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!entry || entry.isDirectory()) return true;
  warn(`Preserved ${directory}. Expected a project directory.`);
  return false;
}

export function linkProjectSkills(project: string, warn: (message: string) => void): string[] {
  const canonical = path.join(project, skillRoot);
  if (!availableDirectory(path.dirname(canonical), warn) || !availableDirectory(canonical, warn) || !fs.existsSync(canonical)) return [];
  const skills = fs.readdirSync(canonical, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")
      && fs.statSync(path.join(canonical, entry.name, "SKILL.md"), { throwIfNoEntry: false })?.isFile())
    .map((entry) => entry.name).sort();
  const added: string[] = [];

  function ensureLink(source: string, destination: string) {
    if (!fs.lstatSync(destination, { throwIfNoEntry: false })) {
      const parent = path.dirname(destination);
      fs.mkdirSync(parent, { recursive: true });
      try {
        fs.symlinkSync(path.relative(parent, source), destination, "dir");
        added.push(path.relative(project, destination).split(path.sep).join("/"));
        return;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    if (!fs.existsSync(destination) || fs.realpathSync(destination) !== fs.realpathSync(source)) {
      warn(`Preserved ${destination}. Expected a link to ${source}.`);
    }
  }

  for (const agent of agentDirectories) {
    const parent = path.join(project, agent);
    if (!availableDirectory(parent, warn)) continue;
    const destination = path.join(parent, "skills");
    if (agent === ".agents" && !fs.lstatSync(destination, { throwIfNoEntry: false })) {
      fs.mkdirSync(destination, { recursive: true });
    }
    if (fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
      for (const name of skills) ensureLink(path.join(canonical, name), path.join(destination, name));
    } else {
      ensureLink(canonical, destination);
    }
  }
  return added;
}

if (import.meta.main) {
  linkProjectSkills(path.resolve(import.meta.dirname, ".."), (message) => process.stderr.write(`Skill links: ${message}\n`));
}
