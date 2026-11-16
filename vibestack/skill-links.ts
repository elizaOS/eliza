import fs from "node:fs";
import path from "node:path";

const skillRoot = ".agents/skills";
const generatedAgentDirectories = [".claude", ".codex", ".cursor", ".droid", ".factory", ".gemini", ".grok", ".grokbot", ".muse", ".t3"];
const generatedAgentIgnores = ["/.claude/", "/CLAUDE.md", ...generatedAgentDirectories.filter((agent) => agent !== ".claude").map((agent) => `/${agent}/skills`)];

function availableDirectory(directory: string, warn: (message: string) => void): boolean {
  const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!entry || entry.isDirectory()) return true;
  warn(`Preserved ${directory}. Expected a project directory.`);
  return false;
}

export function setupProjectAgents(project: string, warn: (message: string) => void): string[] {
  const pkg = path.resolve(import.meta.dirname, "..");
  const canonical = path.join(project, skillRoot);
  const added: string[] = [];
  const record = (file: string) => added.push(path.relative(project, file).split(path.sep).join("/"));
  const pointsTo = (destination: string, source: string) => fs.lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()
    && path.resolve(path.dirname(destination), fs.readlinkSync(destination)) === source;

  function ensureLink(source: string, destination: string, type: "dir" | "file") {
    if (pointsTo(destination, source)) return;
    if (source === canonical && pointsTo(destination, path.join(project, ".claude/skills"))) fs.unlinkSync(destination);
    if (!fs.lstatSync(destination, { throwIfNoEntry: false })) {
      const parent = path.dirname(destination);
      fs.mkdirSync(parent, { recursive: true });
      try {
        fs.symlinkSync(path.relative(parent, source), destination, type);
        record(destination);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if (!pointsTo(destination, source)) warn(`Preserved ${destination}. Expected a link to ${source}.`);
      }
    } else warn(`Preserved ${destination}. Expected a link to ${source}.`);
  }

  function migrate(source: string, destination: string) {
    if (pointsTo(source, destination) && fs.existsSync(destination)) {
      return;
    }
    if (fs.lstatSync(source).isSymbolicLink()) {
      warn(`Preserved ${source}. Expected legacy skill content, not a redirected path.`);
      return;
    }
    if (pointsTo(destination, source)) fs.unlinkSync(destination);
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (!existing) {
      fs.renameSync(source, destination);
      record(destination);
    } else {
      const entry = fs.lstatSync(source);
      if (entry.isDirectory() && existing.isDirectory()) {
        for (const name of fs.readdirSync(source)) migrate(path.join(source, name), path.join(destination, name));
        if (!fs.readdirSync(source).length) fs.rmdirSync(source);
      } else if (entry.isFile() && existing.isFile() && fs.readFileSync(source).equals(fs.readFileSync(destination))) fs.unlinkSync(source);
      else warn(`Preserved ${source} and ${destination}. Conflicting legacy skill content.`);
    }
  }

  function addSkills(directory: string) {
    const source = path.join(pkg, directory);
    const destination = path.join(project, directory);
    if (source === destination || !fs.existsSync(source)) return;
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory()) return;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) addSkills(file);
      else if (entry.isFile() && !fs.lstatSync(path.join(project, file), { throwIfNoEntry: false })) {
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(path.join(source, entry.name), path.join(project, file));
        record(path.join(project, file));
      }
    }
  }

  const claudeDirectory = path.join(project, ".claude");
  const legacy = path.join(claudeDirectory, "skills");
  const hasAgents = availableDirectory(path.dirname(canonical), warn);
  if (hasAgents && pointsTo(canonical, legacy) && fs.lstatSync(claudeDirectory, { throwIfNoEntry: false })?.isDirectory()
    && fs.lstatSync(legacy, { throwIfNoEntry: false })?.isDirectory()) {
    fs.unlinkSync(canonical);
    fs.renameSync(legacy, canonical);
    record(canonical);
  }
  const hasCanonical = hasAgents && availableDirectory(canonical, warn);
  if (hasCanonical) {
    fs.mkdirSync(canonical, { recursive: true });
    if (fs.lstatSync(claudeDirectory, { throwIfNoEntry: false })?.isDirectory() && fs.lstatSync(legacy, { throwIfNoEntry: false })?.isDirectory()) {
      for (const name of fs.readdirSync(legacy)) migrate(path.join(legacy, name), path.join(canonical, name));
      const remaining = fs.readdirSync(legacy);
      if (remaining.every((name) => pointsTo(path.join(legacy, name), path.join(canonical, name)))) {
        for (const name of remaining) fs.unlinkSync(path.join(legacy, name));
        fs.rmdirSync(legacy);
      }
    }
    for (const name of fs.readdirSync(canonical)) {
      const destination = path.join(canonical, name);
      const source = path.join(legacy, name);
      if (pointsTo(destination, source) && !fs.existsSync(source)) fs.unlinkSync(destination);
    }
    addSkills(skillRoot);
    const settings = ".agents/claude-settings.json";
    if (!fs.lstatSync(path.join(project, settings), { throwIfNoEntry: false }) && fs.existsSync(path.join(pkg, settings))) {
      const { permissions } = JSON.parse(fs.readFileSync(path.join(pkg, settings), "utf8")) as { permissions: { deny: string[]; ask: string[] } };
      fs.writeFileSync(path.join(project, settings), JSON.stringify({ permissions: { ...permissions, deny: permissions.deny.filter((rule) => !rule.includes("/vibestack/")) } }, null, 2) + "\n");
      added.push(settings);
    }
    const skills = fs.readdirSync(canonical, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")
        && fs.statSync(path.join(canonical, entry.name, "SKILL.md"), { throwIfNoEntry: false })?.isFile())
      .map((entry) => entry.name).sort();
    for (const agent of generatedAgentDirectories) {
      const parent = path.join(project, agent);
      if (!availableDirectory(parent, warn)) continue;
      const destination = path.join(parent, "skills");
      if (fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
        for (const name of skills) ensureLink(path.join(canonical, name), path.join(destination, name), "dir");
      } else ensureLink(canonical, destination, "dir");
      if (agent === ".claude" && fs.existsSync(path.join(project, settings))) ensureLink(path.join(project, settings), path.join(parent, "settings.json"), "file");
    }
  }

  const claude = path.join(project, "CLAUDE.md");
  const entry = fs.lstatSync(claude, { throwIfNoEntry: false });
  const own = entry?.isFile() ? fs.readFileSync(claude, "utf8") : undefined;
  if (fs.existsSync(path.join(project, "AGENTS.md"))) {
    if (!entry || own?.trim() === "" || own?.trim() === "@AGENTS.md") {
      if (entry) fs.unlinkSync(claude);
      fs.symlinkSync("AGENTS.md", claude, "file");
      added.push("CLAUDE.md (symlink to AGENTS.md)");
    } else if (own !== undefined && !/^@AGENTS\.md\s*$/m.test(own)) {
      const eol = own.includes("\r\n") ? "\r\n" : "\n";
      fs.writeFileSync(claude, `${own.trimEnd()}${eol}${eol}@AGENTS.md${eol}`);
      added.push("CLAUDE.md (imports AGENTS.md)");
    } else if (own === undefined && !pointsTo(claude, path.join(project, "AGENTS.md"))) warn(`Preserved ${claude}. Expected a link to AGENTS.md.`);
  }

  const ignore = path.join(project, ".gitignore");
  const ignored = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  const missing = ["gen/", ".spec-cache/", ".studio/", "dist/", ".vibe/", "test/__traces__/", ...generatedAgentIgnores].filter((pattern) => !ignored.split(/\r?\n/).includes(pattern));
  if (missing.length) {
    fs.writeFileSync(ignore, ignored + (ignored && !ignored.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n");
    added.push(".gitignore");
  }
  return added;
}

if (import.meta.main) {
  setupProjectAgents(path.resolve(import.meta.dirname, ".."), (message) => process.stderr.write(`Agent setup: ${message}\n`));
}
