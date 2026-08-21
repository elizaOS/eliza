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
 * Cloud register + deploy are BROKER-FIRST (#14118): the guidance tells the
 * child to use the canonical app-scoped commands (`apps.create`, managed
 * frontend, optional app database, and optional app-owned container deploy)
 * through the parent-agent broker. The parent keeps account credentials and
 * spend/confirmation policy at the trust boundary; child workers never receive
 * or bridge a raw owner Cloud key.
 *
 * An operator can point the agent at their own **custom static host** entirely
 * through config (a per-user apps dir + public base URL); the framework carries
 * NO knowledge of any specific host — the operator's private character/env
 * config supplies the values, so a personal host is never baked into the repo.
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
 * Whether an app build is MONETIZED — it earns via per-call markup, so it needs
 * Eliza Cloud OAuth + billing (an `appId`) regardless of where the static files
 * are hosted. This is a general rule: a monetized app ALWAYS registers with
 * Cloud. Used so a non-Cloud static host does not tell the sub-agent "don't use
 * Eliza Cloud" for a monetized app — which contradicts the `build-monetized-app`
 * skill and leaves the app unregistered (no sign-in).
 */
const MONETIZED_APP_RE =
  /\b(?:moneti[sz]e[ds]?|monetization|markup|per[-\s]?(?:use|call|request|chat)\s+(?:billing|pricing|charge)|paid\s+(?:app|tiers?|version|plan|feature)|paywall|earn(?:s|ing|ings)?|pay[-\s]?to|subscription|premium\s+tiers?|charges?\s+\$?\d|x402)\b/i;

export function isMonetizedAppTask(
  taskText: string | undefined | null,
): boolean {
  if (typeof taskText !== "string" || taskText.trim().length === 0) {
    return false;
  }
  return MONETIZED_APP_RE.test(taskText);
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

export type AppDeployTarget = "eliza-cloud" | "cloud" | "custom";

export interface AppDeployConfig {
  target: AppDeployTarget;
  /** custom host: absolute dir whose `<slug>/` subdirs are served as apps. */
  customAppsDir?: string;
  /** custom host: public base URL; apps resolve at `<baseUrl>/apps/<slug>/`. */
  customBaseUrl?: string;
  /**
   * custom host: optional operator-supplied notes appended verbatim to the
   * publish guidance (e.g. a host-specific build/deploy caveat). Lives ONLY in
   * the operator's private config — never hardcoded here.
   */
  customPublishNotes?: string;
}

/**
 * Resolve the deploy target from config. The custom static host requires BOTH
 * an apps dir and a base URL to be configured; otherwise we fall back to Eliza
 * Cloud so a half-configured operator override can never strand a normal user.
 */
export function resolveAppDeployConfig(): AppDeployConfig {
  const requested = readConfigEnvKey("ELIZA_APP_DEPLOY_TARGET")
    ?.trim()
    .toLowerCase();
  const customAppsDir = readConfigEnvKey(
    "ELIZA_APP_DEPLOY_CUSTOM_APPS_DIR",
  )?.trim();
  const customBaseUrl = readConfigEnvKey("ELIZA_APP_DEPLOY_CUSTOM_BASE_URL")
    ?.trim()
    .replace(/\/+$/, "");
  const customPublishNotes = readConfigEnvKey(
    "ELIZA_APP_DEPLOY_CUSTOM_NOTES",
  )?.trim();

  if (requested === "custom" && customAppsDir && customBaseUrl) {
    return {
      target: "custom",
      customAppsDir,
      customBaseUrl,
      ...(customPublishNotes ? { customPublishNotes } : {}),
    };
  }
  if (requested === "cloud" || requested === "eliza-cloud") {
    return { target: "eliza-cloud" };
  }
  return { target: "eliza-cloud" };
}

function elizaCloudGuidance(task?: string, monetized?: boolean): string {
  const lines = ["--- App Deployment (Eliza Cloud) ---"];
  // The planner's `monetized` judgment is the primary signal (it understands
  // "people pay $1 to chat" as monetization where a keyword regex does not);
  // the regex remains only as a fallback so detection can never REGRESS. The
  // signal only ever ADDS monetization detection, never removes it.
  if (monetized === true || isMonetizedAppTask(task)) {
    lines.push(
      "USE the `build-monetized-app` skill as the canonical implementation contract; do not invent a parallel Cloud SDK, registration, OAuth proxy, or billing path.",
      "- Preserve the skill's OAuth, same-origin proxy, health-check, and `/api/v1/messages` contract with `x-app-id` + `x-affiliate-code`; adapt the product UI, prompt, model choice, assets, and markup.",
      '- Register exactly ONE Cloud app through the PARENT AGENT (you have no raw Cloud key): `USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.create","params":{"name":"<app name>","app_url":"https://placeholder.invalid","skipGitHubRepo":true}}`. Reuse the returned `appId` for every frontend, database, deploy, review, monetization, and follow-up operation; never create a second registry record for the same project.',
      '- Publish the product UI with `apps.frontend.deploy` using `{"id":"<appId>","files":[{"path":"index.html","content":"..."}],"entrypoint":"index.html","spaFallback":true,"activate":true}`. This is the canonical managed static frontend with version history and rollback. Use `apps.frontend.list` to verify the active deployment.',
      '- If the app needs durable server data, set `apps.database.update` params `{"id":"<appId>","mode":"isolated"}` BEFORE its next backend deploy. Stateless apps keep mode `none`.',
      "- Only when the app needs a server-side runtime, deploy that SAME app with `apps.deploy` and poll `apps.deploy.status`. The app deploy path owns the container identity, injects `ELIZA_APP_ID`, and injects the app database URL when isolated mode is selected. Do not create a parallel generic container with `containers.create`.",
      "- Submit `apps.review.submit` and require an approved `apps.review.get` result before `apps.monetization.update`. Then enable the markup and patch the SAME app URL/origins. Review rejection or a disabled/not-allowlisted deploy is a real blocker to report, not a reason to bypass the app lifecycle.",
      "- The deployed app forwards each signed-in user's bearer token to `/api/v1/messages` with `x-app-id`; it does NOT need or receive the owner's Cloud key. Never request, bridge, store, or inject owner Cloud credentials into child code, frontend files, or app container environment variables.",
    );
  } else {
    lines.push(
      "This task builds an app/site, so it must end up actually HOSTED with a verified live URL — not just local files.",
      "- Build a real, working app and load it to confirm it works before reporting done.",
      '- Host it as exactly ONE Eliza Cloud app through the PARENT AGENT (you have no raw Cloud key): register once with `USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.create","params":{...}}`, then publish static files with `apps.frontend.deploy`. Reuse that `appId` on edits and verify with `apps.frontend.list`; do not create a generic container or a second app record.',
      "- Use `apps.database.update` + `apps.deploy` only if the product truly needs an isolated database and/or server runtime. Poll `apps.deploy.status`; the app-owned deploy path wires container identity and database settings.",
      "- For auth, use Eliza Cloud OAuth via a same-origin proxy that forwards to `/api/v1/messages` with the user's bearer token + `x-app-id` (add `x-affiliate-code` when monetizing). Use Cloud DB / hosted APIs for persistence.",
      "- Do NOT hardcode owner API keys in frontend code, use mock replies, or hand-roll legacy `/messages` routes. Follow the `build-monetized-app` skill for the canonical registration + deploy + domain flow.",
    );
  }
  lines.push(
    "- Custom backend images must use an operator-approved image namespace and registry publication path. If no approved image or registry capability is available, publish the managed frontend and report the backend-deploy blocker; never fall back to an unrelated template, push anonymously, or leak registry credentials.",
    "- Report ONLY the verified live Cloud URL. If you could not deploy or verify it, say that plainly — never report an unverified or guessed URL.",
  );
  return lines.join("\n");
}

function customHostGuidance(
  config: AppDeployConfig,
  _task?: string,
  monetized?: boolean,
): string {
  const dir = config.customAppsDir ?? "";
  const base = config.customBaseUrl ?? "";
  // The monetization line is a self-gating conditional by default ("if the app
  // must earn money …"), but when the planner has JUDGED this task as monetized
  // it becomes a firm directive — a normie "people pay $1 to chat" must not be
  // built as a free static page. Structural: driven by the model's intent
  // signal, not by keyword-matching the task text.
  const monetizeLine =
    monetized === true
      ? "- THIS APP IS MONETIZED: it must charge per use, so a static page is NOT enough. Register it with Eliza Cloud and follow the `build-monetized-app` skill (Cloud SDK app registration → an `appId`, an inference markup, Eliza Cloud OAuth, and a same-origin proxy that forwards to `/api/v1/messages` with `x-app-id` + `x-affiliate-code` — the org-balance billing path). Report the live monetized URL only after a real billed message round-trips."
      : "- If the app must earn money / be monetized: also register it with Eliza Cloud — follow the `build-monetized-app` skill (Cloud SDK registration, an inference markup, per-call billing). Otherwise do not involve Eliza Cloud.";
  // A capability note, NOT an assertion that the current task is an app — it is
  // always available and the agent applies it by judgment. So it must stay
  // correct for a request to BUILD a new app, to EDIT an existing one, OR for a
  // non-web task (which ignores it). No keyword gate decides app-vs-not.
  const lines = [
    "--- Publishing web apps (custom host) ---",
    "If (and only if) your task is to build OR edit a web app, page, or site for the operator — not a script, CLI, library, or backend service — publish it to the operator's configured static host:",
    `- Published apps are plain static files under \`${dir}/<slug>/\` (index.html plus any css/js — there is NO per-app build step), served live at \`${base}/apps/<slug>/\`.`,
    `- To CREATE a new app: pick a fresh, short kebab-case \`<slug>\`, write the files into \`${dir}/<slug>/\`, then open \`${base}/apps/<slug>/\` to confirm it works and report that URL.`,
    `- To EDIT an existing app: the \`<slug>\` is the app's existing folder name under \`${dir}/\` — read its files there, modify them in place, then re-open \`${base}/apps/<slug>/\` to confirm. Do not create a new slug for an edit.`,
    monetizeLine,
  ];
  // Operator-supplied host caveats live only in private config, never in the
  // framework — e.g. "do not run the host's build script" for a host that has
  // one. Appended verbatim when configured.
  if (config.customPublishNotes) {
    lines.push(config.customPublishNotes);
  }
  lines.push("If your task is not a web app, ignore this section.");
  return lines.join("\n");
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

/**
 * When the task's Project is already bound to a Cloud app (`cloudAppId`, #14119),
 * the child must UPDATE that app, not mint a duplicate. One extra line pins the
 * id and flips the create verb to get/update — the rest of the deploy contract
 * is unchanged. Empty string when there is no bound app.
 */
function existingCloudAppLine(cloudAppId?: string): string {
  const id = cloudAppId?.trim();
  if (!id) return "";
  return `- This task's Project is already bound to Cloud app \`${id}\`. Do NOT \`apps.create\` a new app — that duplicates it. Read the existing app with \`apps.get\` (id \`${id}\`) and modify it with \`apps.update\`; deploy a new container revision to the SAME app id.`;
}

/** Build the deploy-guidance block for the configured target. */
export function buildAppDeployGuidance(
  config?: AppDeployConfig,
  task?: string,
  monetized?: boolean,
  cloudAppId?: string,
): string {
  const resolved = config ?? resolveAppDeployConfig();
  const base =
    resolved.target === "custom"
      ? customHostGuidance(resolved, task, monetized)
      : elizaCloudGuidance(task, monetized);
  const boundLine = existingCloudAppLine(cloudAppId);
  return boundLine ? `${base}\n${boundLine}` : base;
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
  opts?: { monetized?: boolean; cloudAppId?: string },
): string {
  // Idempotent: if a deploy block is already present, no-op.
  if (
    task.includes("--- View/Plugin Deployment") ||
    task.includes("--- View Plugin Deployment") ||
    task.includes("--- App Deployment") ||
    task.includes("--- Publishing web apps")
  ) {
    return task;
  }
  const resolved = config ?? resolveAppDeployConfig();
  // The planner's monetization judgment (model intent, not a keyword match).
  const monetized = opts?.monetized === true;
  // View/plugin tasks are a distinct surface (#8918) with their own cloud-vs-local
  // sandbox contract — they are NOT hosted web apps, so they must be routed before
  // the custom-host app note (which would otherwise wrongly tell the agent to
  // publish a plugin as a static page). This check stays keyword-gated at this point;
  // a separate follow-up tracks removing that gate too.
  if (isViewPluginTask(task) && !isAppBuildTask(task)) {
    return `${task.trimEnd()}\n\n${viewPluginGuidance(resolved, {
      sourceDir: extractViewPluginSourceDir(task),
    })}`;
  }
  // custom host: the publish convention is a cheap, always-correct capability
  // note (it self-gates on "if this is a web app … else ignore"), so attach it
  // to EVERY remaining coding task instead of using a keyword regex to guess
  // which tasks are app builds. The regex mis-fired on real phrasings — "add a
  // dark mode toggle … and redeploy it" never matched the build-verb pattern, so
  // the agent got no apps-dir context and could not find or edit the deployed
  // app. Letting the model decide from an always-present note is cleaner.
  if (resolved.target === "custom") {
    // A custom-host app only touches Cloud when it is monetized (it registers
    // for billing); only then does an existing-app binding apply.
    const boundLine = monetized ? existingCloudAppLine(opts?.cloudAppId) : "";
    const custom = customHostGuidance(resolved, task, monetized);
    const block = boundLine ? `${custom}\n${boundLine}` : custom;
    return `${task.trimEnd()}\n\n${block}`;
  }
  // Force the deploy contract for a monetized task even when isAppBuildTask
  // misses it — a monetized request ("an app where people pay $1 to chat …") is
  // by definition an app build, but its phrasing may lack a build verb. The
  // planner's monetized signal is the structural override for that gate.
  if (!monetized && !isAppBuildTask(task)) {
    return task;
  }
  return `${task.trimEnd()}\n\n${buildAppDeployGuidance(resolved, task, monetized, opts?.cloudAppId)}`;
}
