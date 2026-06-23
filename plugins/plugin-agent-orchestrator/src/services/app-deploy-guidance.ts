/**
 * App-deployment guidance for spawned coding sub-agents.
 *
 * When a sub-agent is asked to build an app / website, the planner-level
 * app-build contract (in the parent agent's system prompt) does not survive the
 * terse spawn task. Without it the sub-agent just writes local files that are
 * never served, so the user gets "no live URL". This module re-injects a
 * deployment contract into the sub-agent's initial task at the spawn chokepoint
 * so the result is actually hosted and a verified URL is reported.
 *
 * Default target is **Eliza Cloud** (the productized path for every user).
 * Operators can opt into a personal **agent-home** static host via env — that
 * is gated so other users never see it.
 *
 * @module services/app-deploy-guidance
 */

import { readConfigEnvKey } from "./config-env.js";
import { APP_DEPLOY_TASK_RE } from "./skill-recommender.js";
import {
  buildLocalViewPluginPrompt,
  buildViewPluginDeployPrompt,
  type ViewPluginDeployPromptOptions,
} from "./view-deploy-guidance.js";

/**
 * Whether a task builds a HOSTED web surface that should get the deploy
 * contract. Uses the narrow APP_DEPLOY_TASK_RE — a CLI tool / library / doc
 * page must NOT be told to deploy and report a live URL.
 */
export function isAppBuildTask(taskText: string | undefined | null): boolean {
  if (typeof taskText !== "string" || taskText.trim().length === 0) {
    return false;
  }
  return APP_DEPLOY_TASK_RE.test(taskText);
}

/**
 * Whether a task builds an elizaOS VIEW or PLUGIN. These get view-specific
 * cloud/local sandbox guidance (#8918) rather than the generic hosted-app
 * deploy contract.
 */
const VIEW_PLUGIN_TASK_RE =
  /\b(view[-\s]?plugin|plugin[-\s]?view|(creat|build|add|mak)(e|ing)?\s+(?:(?:a|an|new)\s+)*(view|plugin)|register[-\s]?(?:a\s+)?view|viewKind)\b/i;

export function isViewPluginTask(taskText: string | undefined | null): boolean {
  if (typeof taskText !== "string" || taskText.trim().length === 0) {
    return false;
  }
  return VIEW_PLUGIN_TASK_RE.test(taskText);
}

export type AppDeployTarget = "eliza-cloud" | "cloud" | "agent-home";

export interface AppDeployConfig {
  target: AppDeployTarget;
  /** agent-home: absolute dir whose `<slug>/` subdirs are served as apps. */
  agentHomeAppsDir?: string;
  /** agent-home: public base URL; apps resolve at `<baseUrl>/apps/<slug>/`. */
  agentHomeBaseUrl?: string;
}

/**
 * Resolve the deploy target from env. agent-home requires BOTH an apps dir and
 * a base URL to be configured; otherwise we fall back to Eliza Cloud so a
 * half-configured operator override can never strand a normal user.
 */
export function resolveAppDeployConfig(): AppDeployConfig {
  const requested = readConfigEnvKey("ELIZA_APP_DEPLOY_TARGET")
    ?.trim()
    .toLowerCase();
  const agentHomeAppsDir = readConfigEnvKey(
    "ELIZA_AGENT_HOME_APPS_DIR",
  )?.trim();
  const agentHomeBaseUrl = readConfigEnvKey("ELIZA_AGENT_HOME_BASE_URL")
    ?.trim()
    .replace(/\/+$/, "");

  if (requested === "agent-home" && agentHomeAppsDir && agentHomeBaseUrl) {
    return { target: "agent-home", agentHomeAppsDir, agentHomeBaseUrl };
  }
  if (requested === "cloud" || requested === "eliza-cloud") {
    return { target: "eliza-cloud" };
  }
  return { target: "eliza-cloud" };
}

function elizaCloudGuidance(): string {
  return [
    "--- App Deployment (Eliza Cloud) ---",
    "This task builds an app/site, so it must end up actually HOSTED with a verified live URL — not just local files.",
    "- Build a real, working app and load it to confirm it works before reporting done.",
    "- Host it on Eliza Cloud: use `@elizaos/cloud-sdk` when available, register the app to get an `appId`, and deploy via the Cloud container/app flow.",
    "- For auth, use Eliza Cloud OAuth via a same-origin proxy to `/api/v1/apps/<appId>/chat` with the user's bearer token (add `X-Affiliate-Code` when monetizing). Use Cloud DB / hosted APIs for persistence.",
    "- Do NOT hardcode owner API keys in frontend code, use mock replies, or hand-roll legacy `/messages` routes. Follow the `build-monetized-app` skill for the canonical registration + deploy + domain flow.",
    "- Report ONLY the verified live Cloud URL. If you could not deploy or verify it, say that plainly — never report an unverified or guessed URL.",
  ].join("\n");
}

function agentHomeGuidance(config: AppDeployConfig): string {
  const dir = config.agentHomeAppsDir ?? "";
  const base = config.agentHomeBaseUrl ?? "";
  return [
    "--- App Deployment (agent-home) ---",
    "This is a quick static/fun app for the operator's personal agent-home host. Do NOT use Eliza Cloud for this one.",
    "- Pick a fresh, short kebab-case `<slug>` from the request.",
    `- Write the app's static files (index.html + css/js — there is NO per-app build step) into \`${dir}/<slug>/\`.`,
    `- It is then served immediately at \`${base}/apps/<slug>/\` — load that URL to confirm it works, then report it as the live link.`,
    "- Do NOT run `deploy.sh` (operator-only; only needed when adding a new Next.js backend route). Static apps need no build/restart.",
  ].join("\n");
}

/**
 * Cloud-vs-local-sandbox contract for a view/plugin task (#8918). A view-plugin
 * follows the configured target: Eliza Cloud gets the full publish/register
 * contract, while non-cloud targets stay local-sandbox only.
 */
export function viewPluginGuidance(
  config?: AppDeployConfig,
  options?: ViewPluginDeployPromptOptions,
): string {
  const resolved = config ?? resolveAppDeployConfig();
  return isCloudDeployTarget(resolved)
    ? buildViewPluginDeployPrompt(options)
    : buildLocalViewPluginPrompt();
}

/** Build the deploy-guidance block for the configured target. */
export function buildAppDeployGuidance(config?: AppDeployConfig): string {
  const resolved = config ?? resolveAppDeployConfig();
  return resolved.target === "agent-home"
    ? agentHomeGuidance(resolved)
    : elizaCloudGuidance();
}

function isCloudDeployTarget(config: AppDeployConfig): boolean {
  return config.target === "eliza-cloud" || config.target === "cloud";
}

function extractViewPluginSourceDir(task: string): string | undefined {
  return (
    task
      .match(/plugin source directory is\s+(.+?)(?:\. It|\n|$)/i)?.[1]
      ?.trim() ?? task.match(/source lives in\s+(.+?)(?:\.|\n|$)/i)?.[1]?.trim()
  );
}

/**
 * Append the deploy contract to an app-build task; pass non-app tasks through
 * unchanged. Idempotent — skips if the block is already present.
 */
export function augmentTaskWithDeployGuidance(
  task: string,
  config?: AppDeployConfig,
): string {
  // Idempotent: if either deploy block is already present, no-op. Checked first
  // because each guidance block itself contains app/view keywords that would
  // otherwise re-trigger detection on a second pass.
  if (
    task.includes("--- View/Plugin Deployment") ||
    task.includes("--- View Plugin Deployment") ||
    task.includes("--- App Deployment")
  ) {
    return task;
  }
  // View/plugin tasks get the cloud-vs-local sandbox contract (#8918), checked
  // before the hosted-app contract so a "build a view plugin" task isn't
  // mis-routed to "deploy + report a live URL".
  if (isViewPluginTask(task) && !isAppBuildTask(task)) {
    return `${task.trimEnd()}\n\n${viewPluginGuidance(config, {
      sourceDir: extractViewPluginSourceDir(task),
    })}`;
  }
  if (!isAppBuildTask(task)) {
    return task;
  }
  return `${task.trimEnd()}\n\n${buildAppDeployGuidance(config)}`;
}
