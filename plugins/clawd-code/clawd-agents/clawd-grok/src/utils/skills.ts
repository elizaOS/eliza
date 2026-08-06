import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findGitRoot } from "./git-root";

export type SkillScope = "project" | "user";

export interface DiscoveredSkill {
  name: string;
  description: string;
  skillMdPath: string;
  rootDir: string;
  scope: SkillScope;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\n/g, "\n");
  }
  return t;
}

/** Minimal YAML frontmatter key extraction for flat `key: value` and optional `|` / `>` blocks after description. */
function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const lines = raw.split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameM = line.match(/^name:\s*(.*)$/);
    if (nameM) {
      const rest = nameM[1].trim();
      out.name = stripQuotes(rest);
      continue;
    }
    const descM = line.match(/^description:\s*(.*)$/);
    if (descM) {
      const rest = descM[1].trim();
      if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
        i++;
        const block: string[] = [];
        while (i < lines.length) {
          const L = lines[i];
          if (L.match(/^[a-zA-Z0-9_-]+:\s/) && !/^\s/.test(L)) break;
          if (/^\s/.test(L) || (block.length > 0 && L === "")) {
            block.push(L.replace(/^\s+/, ""));
            i++;
          } else if (block.length > 0) {
            break;
          } else {
            break;
          }
        }
        i--;
        out.description = block.join("\n").trim();
      } else {
        out.description = stripQuotes(rest);
      }
    }
  }
  return out;
}

function extractFrontmatter(fileContent: string): { frontmatter: string; ok: boolean } {
  const trimmed = fileContent.trimStart();
  if (!trimmed.startsWith("---")) return { frontmatter: "", ok: false };
  const afterFirst = trimmed.slice(3).split(/\r?\n/);
  const restLines = afterFirst.slice(1);
  const end = restLines.findIndex((l) => l.trim() === "---");
  if (end < 0) return { frontmatter: "", ok: false };
  return { frontmatter: restLines.slice(0, end).join("\n"), ok: true };
}

function loadSkillFromDir(rootDir: string, scope: SkillScope): DiscoveredSkill | null {
  const skillMdPath = path.join(rootDir, "SKILL.md");
  try {
    if (!fs.existsSync(skillMdPath) || !fs.statSync(skillMdPath).isFile()) return null;
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const { frontmatter, ok } = extractFrontmatter(content);
    if (!ok) return null;
    const meta = parseSkillFrontmatter(frontmatter);
    const name = meta.name?.trim();
    const description = meta.description?.trim();
    if (!name || !description) return null;
    return {
      name,
      description,
      skillMdPath: path.resolve(skillMdPath),
      rootDir: path.resolve(rootDir),
      scope,
    };
  } catch {
    return null;
  }
}

function listSkillDirectories(skillsRoot: string): string[] {
  try {
    if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) return [];
    const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    const dirs: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      dirs.push(path.join(skillsRoot, e.name));
    }
    return dirs.sort();
  } catch {
    return [];
  }
}

function listProjectSkillRoots(projectRoot: string): string[] {
  const start = path.resolve(projectRoot);
  const gitRoot = findGitRoot(start);
  const roots: string[] = [];
  let current = start;

  while (true) {
    roots.push(path.join(current, ".agents", "skills"));
    if (gitRoot ? current === gitRoot : path.dirname(current) === current) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots.reverse();
}

/**
 * Discover Agent Skills under ~/.agents/skills and from <projectRoot> upward through
 * parent directories to the git root. The nearest project-level skill overrides
 * user-level and higher-level project skills with the same `name` (frontmatter).
 */
export function discoverSkills(projectRoot: string): DiscoveredSkill[] {
  const userRoot = path.join(os.homedir(), ".agents", "skills");

  const byName = new Map<string, DiscoveredSkill>();

  for (const dir of listSkillDirectories(userRoot)) {
    const s = loadSkillFromDir(dir, "user");
    if (s) byName.set(s.name, s);
  }
  for (const skillsRoot of listProjectSkillRoots(projectRoot)) {
    for (const dir of listSkillDirectories(skillsRoot)) {
      const s = loadSkillFromDir(dir, "project");
      if (s) byName.set(s.name, s);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const SKILLS_INSTRUCTIONS = `AGENT SKILLS (optional):
The following <available_skills> list specialized workflows. Use them when they might help the user's request — not only on exact keyword matches.
If a skill's description fits the task or could improve consistency, read that skill's instructions first using read_file with the path from <location>, then follow the SKILL.md body.
Paths inside a skill (scripts/, references/, assets/) are relative to the skill directory (the folder containing SKILL.md); prefer absolute paths in tool calls.`;

/** OpenCode-style XML catalog plus activation instructions for read_file. Returns null if no skills. */
export function formatSkillsForPrompt(skills: DiscoveredSkill[]): string | null {
  if (skills.length === 0) return null;
  const parts = skills.map(
    (s) =>
      `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.skillMdPath)}</location>\n  </skill>`,
  );
  return `${SKILLS_INSTRUCTIONS}\n\n<available_skills>\n${parts.join("\n")}\n</available_skills>`;
}

/** Plain-text listing for /skills slash command in the TUI. */
export function formatSkillsForChat(skills: DiscoveredSkill[], projectRoot: string): string {
  if (skills.length === 0) {
    return [
      "No Agent Skills found.",
      "",
      `Add skills under ${path.join(projectRoot, ".agents", "skills", "<name>", "SKILL.md")} or ~/.agents/skills/<name>/SKILL.md`,
      "Install manually or use scripts such as skills.sh; see https://agentskills.io",
    ].join("\n");
  }
  const lines = [
    `Agent Skills (${skills.length})`,
    "",
    ...skills.map((s) => `- ${s.name} [${s.scope}]\n  ${s.description}\n  ${s.skillMdPath}`),
  ];
  return lines.join("\n");
}
