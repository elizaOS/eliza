import fs from "node:fs";
import path from "node:path";

const project = fs.realpathSync(path.resolve(import.meta.dirname, ".."));
const canonical = path.join(project, ".claude", "skills");
const aliases = [".agents", ".cursor", ".codex", ".grok", ".gemini", ".factory", ".t3", ".droid"];

function ensureLink(source: string, destination: string) {
  if (!fs.lstatSync(destination, { throwIfNoEntry: false })) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
      fs.symlinkSync(path.relative(path.dirname(destination), source), destination, "dir");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  if (!fs.existsSync(destination) || fs.realpathSync(destination) !== fs.realpathSync(source)) {
    process.stderr.write(`Skill links: preserved ${destination}. Expected a link to ${source}.\n`);
  }
}

if (fs.realpathSync(canonical) !== canonical) {
  throw new Error(`Skill links: expected the project's skill sources at ${canonical}`);
}
const skills = fs.readdirSync(canonical).filter((name) => !name.startsWith(".")
  && fs.existsSync(path.join(canonical, name, "SKILL.md")));

for (const alias of aliases) {
  const parent = path.join(project, alias);
  const entry = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) {
    process.stderr.write(`Skill links: preserved ${parent}. Expected a project directory.\n`);
    continue;
  }
  const destination = path.join(parent, "skills");
  if (alias === ".agents" && !fs.lstatSync(destination, { throwIfNoEntry: false })) {
    fs.mkdirSync(destination, { recursive: true });
  }
  if (fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
    for (const name of skills) {
      ensureLink(path.join(canonical, name), path.join(destination, name));
    }
  } else {
    ensureLink(canonical, destination);
  }
}
