/**
 * Exercises the local Agent Skills action surface with real storage and strict
 * deterministic routing fixtures; no network service participates.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { postTurnModelFixtures } from "./_helpers/post-turn-model-fixtures.ts";
import { strictActionRouteModelFixtures } from "./_helpers/strict-action-route-model-fixtures.ts";

const guidanceSlug = "scenario-guidance";
const removableSlug = "scenario-removable";
const useText = "Run USE_SKILL for scenario-guidance in guidance mode";
const parentDisableText = 'Disable skill "scenario-guidance"';
const enableText = 'Enable skill "scenario-guidance"';
const uninstallText = 'Uninstall skill "scenario-removable"';
const confirmText = 'yes, run skill uninstall for "scenario-removable"';

function skillMarkdown(slug: string, description: string): string {
  return [
    "---",
    `name: ${slug}`,
    `description: ${description}`,
    "metadata:",
    "  version: 1.0.0",
    "---",
    `Return ${slug}-ok when this deterministic guidance is invoked.`,
    "",
  ].join("\n");
}

const strictRoutes = [
  {
    actionName: "USE_SKILL",
    args: { slug: guidanceSlug, mode: "guidance" },
    contextIds: ["knowledge"],
    input: useText,
    messageToUser: `${guidanceSlug}-ok`,
  },
  {
    actionName: "SKILL",
    args: { action: "toggle", enabled: false, slug: guidanceSlug },
    contextIds: ["settings"],
    input: parentDisableText,
    messageToUser: `Skill ${guidanceSlug} has been disabled.`,
  },
  {
    actionName: "SKILL_TOGGLE",
    args: { action: "toggle", enabled: true, slug: guidanceSlug },
    contextIds: ["settings"],
    input: enableText,
    messageToUser: `Skill ${guidanceSlug} has been enabled.`,
  },
  {
    actionName: "SKILL_UNINSTALL",
    args: { action: "uninstall", slug: removableSlug },
    contextIds: ["settings"],
    input: uninstallText,
    messageToUser: `Reply "yes" to confirm uninstalling ${removableSlug}.`,
  },
  {
    actionName: "SKILL_UNINSTALL",
    args: { action: "uninstall", slug: removableSlug },
    contextIds: ["settings"],
    input: confirmText,
    messageToUser: `Skill ${removableSlug} has been uninstalled.`,
  },
];

interface ScenarioSkillsService {
  getStorage: () => {
    saveSkill: (pkg: {
      slug: string;
      files: Map<
        string,
        { path: string; content: string | Uint8Array; isText: boolean }
      >;
    }) => Promise<void>;
    hasSkill: (slug: string) => Promise<boolean>;
    deleteSkill: (slug: string) => Promise<boolean>;
  };
  loadSkill: (slug: string) => Promise<unknown>;
  setSkillEnabled: (slug: string, enabled: boolean) => boolean;
}

async function seedSkill(
  service: ScenarioSkillsService,
  slug: string,
  description: string,
): Promise<void> {
  await service.getStorage().saveSkill({
    slug,
    files: new Map([
      [
        "SKILL.md",
        {
          path: "SKILL.md",
          content: skillMarkdown(slug, description),
          isText: true,
        },
      ],
    ]),
  });
  await service.loadSkill(slug);
  service.setSkillEnabled(slug, true);
}

async function verifyLocalSideEffects(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as
    | { getService?: (serviceType: string) => unknown }
    | undefined;
  const service = runtime?.getService?.("AGENT_SKILLS_SERVICE") as
    | ScenarioSkillsService
    | undefined;
  if (!service) return "AgentSkillsService unavailable";
  if (await service.getStorage().hasSkill(removableSlug)) {
    return `expected ${removableSlug} to be removed from managed storage`;
  }
  await service.getStorage().deleteSkill(guidanceSlug);
  return undefined;
}

export default scenario({
  id: "deterministic-agent-skills-actions",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      ...strictActionRouteModelFixtures(strictRoutes),
      ...postTurnModelFixtures(
        strictRoutes.map((route) => ({
          name: route.actionName,
          input: route.input,
        })),
      ),
    ],
  },
  title: "Deterministic agent-skills local actions",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "agent-skills"],
  isolation: "shared-runtime",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  seed: [
    {
      type: "custom",
      name: "seed local managed skills",
      apply: async (ctx) => {
        const runtime = ctx.runtime as
          | {
              getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
              getService?: (serviceType: string) => unknown;
            }
          | undefined;
        await runtime?.getServiceLoadPromise?.("AGENT_SKILLS_SERVICE");
        const service = runtime?.getService?.("AGENT_SKILLS_SERVICE") as
          | ScenarioSkillsService
          | undefined;
        if (!service) return "AgentSkillsService unavailable";
        await seedSkill(service, guidanceSlug, "Deterministic guidance skill");
        await seedSkill(
          service,
          removableSlug,
          "Deterministic removable skill",
        );
        return undefined;
      },
    },
  ],
  rooms: [
    { id: "main", source: "telegram", title: "Deterministic Agent Skills" },
  ],
  turns: [
    { kind: "message", text: useText, responseIncludesAny: [guidanceSlug] },
    {
      kind: "message",
      text: parentDisableText,
      responseIncludesAny: ["disabled", guidanceSlug],
    },
    {
      kind: "message",
      text: enableText,
      responseIncludesAny: ["enabled", guidanceSlug],
    },
    {
      kind: "message",
      text: uninstallText,
      responseIncludesAny: ["confirm", removableSlug],
    },
    {
      kind: "message",
      text: confirmText,
      responseIncludesAny: ["uninstalled", removableSlug],
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "USE_SKILL", status: "success" },
    { type: "actionCalled", actionName: "SKILL", status: "success" },
    { type: "actionCalled", actionName: "SKILL_TOGGLE", status: "success" },
    {
      type: "actionCalled",
      actionName: "SKILL_UNINSTALL",
      status: "success",
      minCount: 2,
    },
    {
      type: "custom",
      name: "local managed skill side effects are exact",
      predicate: verifyLocalSideEffects,
    },
  ],
});
