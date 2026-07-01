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
  getEligibleSkills: () => Promise<
    Array<{ slug: string; name: string; description: string }>
  >;
  isSkillEnabled: (slug: string) => boolean;
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
    };
  }

  const eligible = await service.getEligibleSkills();
  const enabledEligible = eligible.filter((skill) =>
    service.isSkillEnabled(skill.slug),
  );

  // onlyEligible defaults to true — for the spawned agent surface we only
  // want skills it can actually invoke.
  const onlyEligible = opts.onlyEligible ?? true;
  const availableSet = onlyEligible ? enabledEligible : eligible;

  const availableEntries: ManifestSkillEntry[] = availableSet.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
  }));

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
  };
}
