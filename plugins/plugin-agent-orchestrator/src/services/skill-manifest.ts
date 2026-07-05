/**
 * Skill manifest builder.
 *
 * Renders a Markdown SKILLS.md document for spawned task agents so they have
 * full visibility into the skills installed in the parent runtime. The parent
 * agent owns skill execution; spawned agents request skill invocation by
 * calling back to the parent (see skill callback bridge in send-to-agent.ts
 * via the child→parent USE_SKILL skill callback bridge).
 *
 * Source of truth is the AGENT_SKILLS_SERVICE (`@elizaos/plugin-agent-skills`).
 *
 * @module services/skill-manifest
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IAgentRuntime, Logger, Service } from "@elizaos/core";

const LOG_PREFIX = "[SkillManifest]";
const MAX_DESCRIPTION_CHARS = 200;

export interface ManifestSkillEntry {
  slug: string;
  name: string;
  description: string;
  /** Task-scoped invocation guidance for virtual broker skills. */
  guidance?: string;
}

/**
 * Minimal shape of the AgentSkillsService surface we depend on. We avoid a
 * type-level import because plugin-agent-orchestrator must not have a hard
 * dependency on @elizaos/plugin-agent-skills (it is optional at runtime).
 */
interface SkillsServiceShape {
  getEligibleSkills?: () => Promise<
    Array<{ slug: string; name: string; description: string }>
  >;
  getLoadedSkills?: () => Array<{
    slug: string;
    name: string;
    description: string;
  }>;
  isSkillEnabled?: (slug: string) => boolean;
  getSkillInstructions?: (
    slug: string,
  ) => { slug: string; body: string; estimatedTokens: number } | null;
}

export interface BuildSkillsManifestOptions {
  /** Restrict the "All available skills" section to eligible-and-enabled skills. */
  onlyEligible?: boolean;
  /**
   * Slugs to highlight in a dedicated "Recommended for this task" section.
   * Slugs not present in the eligible/enabled set are silently dropped — the
   * recommender does not guarantee installed status.
   */
  recommendedSlugs?: string[];
  /** Additional task-scoped skills handled by the orchestrator bridge. */
  virtualSkills?: ManifestSkillEntry[];
  /**
   * Append a "View kind" contract section so a Cloud-deploying sub-agent
   * categorizes any `Plugin.views` entry it ships (release default / preview /
   * developer; never system). Only relevant to app-building / economics tasks,
   * so it is opt-in and off by default for the generic manifest. (#8917)
   */
  includeViewKindContract?: boolean;
}

export interface SkillsManifestResult {
  /** Markdown document suitable for writing to SKILLS.md inside a workspace. */
  markdown: string;
  /** Slugs that the spawned agent can actually request via USE_SKILL. */
  slugs: string[];
  /** Requestable entries backing the rendered manifest. */
  entries: ManifestSkillEntry[];
}

export interface SkillInstructionsResult {
  slug: string;
  body: string;
  estimatedTokens: number | null;
  source: "installed" | "virtual";
}

function truncateDescription(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_DESCRIPTION_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

function getLogger(runtime: IAgentRuntime): Logger | Console {
  const candidate = (runtime as { logger?: Logger }).logger;
  return candidate ?? console;
}

async function getAvailableSkillEntries(
  service: SkillsServiceShape,
  onlyEligible: boolean,
): Promise<ManifestSkillEntry[]> {
  const rawSkills = service.getEligibleSkills
    ? await service.getEligibleSkills()
    : (service.getLoadedSkills?.() ?? []);
  return rawSkills
    .filter(
      (skill) =>
        !onlyEligible || (service.isSkillEnabled?.(skill.slug) ?? true),
    )
    .map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
    }));
}

function renderEntries(entries: ManifestSkillEntry[]): string {
  if (entries.length === 0) {
    return "_(none)_";
  }
  return entries
    .map((entry) => {
      const description = truncateDescription(entry.description);
      const tail = description ? ` — ${description}` : "";
      const guidance = entry.guidance
        ? `\n  - Protocol: ${entry.guidance}`
        : "";
      return `- **${entry.name}** (\`${entry.slug}\`)${tail}${guidance}`;
    })
    .join("\n");
}

/**
 * The ViewKind taxonomy a Cloud-deploying sub-agent must set on any view it
 * ships. Kept in sync with `resolveViewKind` in
 * `packages/core/src/types/view-kind.ts` (default `release`). (#8917)
 */
function renderViewKindContract(): string[] {
  return [
    "## View kind (if you ship a view)",
    "",
    "Any `Plugin.views` entry you create must set `viewKind` so the shell categorizes it correctly. The four kinds:",
    "",
    "- `release` — a finished, public, production-ready view. **This is the default** for a user-facing view; omitting `viewKind` resolves to `release`.",
    "- `preview` — unfinished/experimental; hidden until the user enables it in Settings.",
    "- `developer` — dev tooling (logs, DB inspectors, trajectory viewers); shown in dev builds, hidden in production until enabled.",
    "- `system` — reserved for built-in core views. **Do not use** for a view you create.",
    "",
    "Pick `release` for anything you intend users to see, `preview` while it is still rough, and `developer` for an inspector/diagnostic surface.",
    "",
  ];
}

function renderManifest(
  recommended: ManifestSkillEntry[],
  available: ManifestSkillEntry[],
  virtualSkills: ManifestSkillEntry[],
  includeViewKindContract = false,
): string {
  const lines: string[] = [];
  lines.push("# Available skills");
  lines.push("");
  lines.push(
    "These skills are installed or task-scoped in the parent agent. To use one, send a USE_SKILL request back via the parent (slug + optional args).",
  );
  lines.push("");
  lines.push(
    "Protocol: send a message to the parent of the form `USE_SKILL <slug> <json_args>` and the parent will execute the skill and return the result. The `<json_args>` portion is optional; omit it for skills that take no parameters or use defaults.",
  );
  lines.push("");

  if (recommended.length > 0) {
    lines.push("## Recommended for this task");
    lines.push("");
    lines.push(renderEntries(recommended));
    lines.push("");
  }

  lines.push("## All enabled skills");
  lines.push("");
  lines.push(renderEntries(available));
  lines.push("");

  if (virtualSkills.length > 0) {
    lines.push("## Task-scoped broker skills");
    lines.push("");
    lines.push(
      "These slugs are requestable only for this spawned task because the parent orchestrator allow-listed them.",
    );
    lines.push("");
    lines.push(renderEntries(virtualSkills));
    lines.push("");
  }

  if (includeViewKindContract) {
    lines.push(...renderViewKindContract());
  }
  return lines.join("\n");
}

/**
 * Build a SKILLS.md markdown document plus the canonical slug list.
 *
 * The slug list is the deduplicated union of recommended + available slugs,
 * so callers can persist it for trajectory annotation or programmatic checks
 * without re-resolving against the service.
 */
export async function buildSkillsManifest(
  runtime: IAgentRuntime,
  opts: BuildSkillsManifestOptions = {},
): Promise<SkillsManifestResult> {
  const log = getLogger(runtime);
  const service = runtime.getService("AGENT_SKILLS_SERVICE") as
    | (Service & SkillsServiceShape)
    | undefined;

  if (!service) {
    log.debug(
      `${LOG_PREFIX} AGENT_SKILLS_SERVICE not registered; emitting empty manifest`,
    );
    const virtualEntries = opts.virtualSkills ?? [];
    const virtualBySlug = new Map(
      virtualEntries.map((entry) => [entry.slug, entry]),
    );
    const recommendedVirtualEntries = (opts.recommendedSlugs ?? [])
      .map((slug) => virtualBySlug.get(slug))
      .filter((entry): entry is ManifestSkillEntry => Boolean(entry));
    return {
      markdown: renderManifest(
        recommendedVirtualEntries,
        [],
        virtualEntries,
        opts.includeViewKindContract ?? false,
      ),
      slugs: virtualEntries.map((entry) => entry.slug),
      entries: virtualEntries,
    };
  }

  // onlyEligible defaults to true — for the spawned agent surface we only
  // want skills it can actually invoke.
  const onlyEligible = opts.onlyEligible ?? true;
  const availableEntries = await getAvailableSkillEntries(
    service,
    onlyEligible,
  );

  const virtualEntries = opts.virtualSkills ?? [];
  const requestableBySlug = new Map<string, ManifestSkillEntry>();
  for (const entry of [...availableEntries, ...virtualEntries]) {
    requestableBySlug.set(entry.slug, entry);
  }

  const recommendedSlugs = opts.recommendedSlugs ?? [];
  const recommendedEntries: ManifestSkillEntry[] = [];
  for (const slug of recommendedSlugs) {
    const entry = requestableBySlug.get(slug);
    if (entry) {
      recommendedEntries.push(entry);
    }
  }

  const dedupedSlugs = Array.from(
    new Set([
      ...recommendedEntries.map((entry) => entry.slug),
      ...availableEntries.map((entry) => entry.slug),
      ...virtualEntries.map((entry) => entry.slug),
    ]),
  );

  return {
    markdown: renderManifest(
      recommendedEntries,
      availableEntries,
      virtualEntries,
      opts.includeViewKindContract ?? false,
    ),
    slugs: dedupedSlugs,
    entries: [...availableEntries, ...virtualEntries],
  };
}

export async function writeSkillsManifest(
  runtime: IAgentRuntime,
  workdir: string,
  opts: BuildSkillsManifestOptions = {},
): Promise<SkillsManifestResult> {
  const manifest = await buildSkillsManifest(runtime, opts);
  await writeFile(join(workdir, "SKILLS.md"), manifest.markdown, "utf8");
  return manifest;
}

export async function readSkillInstructions(
  runtime: IAgentRuntime,
  slug: string,
  opts: BuildSkillsManifestOptions = {},
): Promise<SkillInstructionsResult | null> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;

  const virtualSkill = (opts.virtualSkills ?? []).find(
    (entry) => entry.slug.toLowerCase() === normalized,
  );
  if (virtualSkill) {
    return {
      slug: virtualSkill.slug,
      source: "virtual",
      estimatedTokens: null,
      body: [
        `# ${virtualSkill.name}`,
        "",
        virtualSkill.description,
        "",
        virtualSkill.guidance
          ? `Protocol: ${virtualSkill.guidance}`
          : `Protocol: USE_SKILL ${virtualSkill.slug} <json_args>`,
      ].join("\n"),
    };
  }

  const service = runtime.getService("AGENT_SKILLS_SERVICE") as
    | (Service & SkillsServiceShape)
    | undefined;
  if (!service) return null;

  const canCheckAvailability = Boolean(
    service.getEligibleSkills || service.getLoadedSkills,
  );
  let installedSlug = slug;
  if (canCheckAvailability) {
    const availableEntries = await getAvailableSkillEntries(
      service,
      opts.onlyEligible ?? true,
    );
    const availableEntry = availableEntries.find(
      (entry) => entry.slug.toLowerCase() === normalized,
    );
    if (!availableEntry) return null;
    installedSlug = availableEntry.slug;
  }

  const instructions = service.getSkillInstructions?.(installedSlug);
  if (!instructions) return null;
  return {
    slug: instructions.slug,
    body: instructions.body,
    estimatedTokens: instructions.estimatedTokens,
    source: "installed",
  };
}
