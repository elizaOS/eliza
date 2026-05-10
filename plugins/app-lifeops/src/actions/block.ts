/**
 * BLOCK umbrella — Audit B Defer #1.
 *
 * Folds the previous standalone `APP_BLOCK` (phone apps) and `WEBSITE_BLOCK`
 * (desktop hosts file / SelfControl) actions into a single umbrella keyed by
 * `target: "app" | "website"`. The runtime backends stay untouched: each
 * subaction dispatches into the existing backend handlers.
 *
 * Subactions (union of both legacy surfaces):
 *   block | unblock | status | request_permission | release | list_active
 *
 * Target/subaction support matrix:
 *   app:     block, unblock, status
 *   website: block, unblock, status, request_permission, release, list_active
 *
 * Calls with an `(app, <unsupported>)` pair raise `BlockTargetUnsupportedError`
 * — there is no app-side equivalent for hosts-file rule lifecycle, so silently
 * ignoring the verb would hide a real planner bug.
 */
import type {
  Action,
  ActionExample,
  ActionParameters,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { appBlockActionImpl } from "./app-block.js";
import { websiteBlockActionImpl } from "./website-block.js";

const ACTION_NAME = "BLOCK";

type BlockTarget = "app" | "website";

type BlockSubaction =
  | "block"
  | "unblock"
  | "status"
  | "request_permission"
  | "release"
  | "list_active";

const APP_SUBACTIONS: ReadonlySet<BlockSubaction> = new Set([
  "block",
  "unblock",
  "status",
]);

const WEBSITE_SUBACTIONS: ReadonlySet<BlockSubaction> = new Set([
  "block",
  "unblock",
  "status",
  "request_permission",
  "release",
  "list_active",
]);

const ALL_SUBACTIONS: readonly BlockSubaction[] = [
  "block",
  "unblock",
  "status",
  "request_permission",
  "release",
  "list_active",
];

const ALL_TARGETS: readonly BlockTarget[] = ["app", "website"];

export class BlockTargetUnsupportedError extends Error {
  readonly target: BlockTarget;
  readonly subaction: string;
  readonly supportedSubactions: readonly BlockSubaction[];
  constructor(target: BlockTarget, subaction: string) {
    const supported = target === "app" ? APP_SUBACTIONS : WEBSITE_SUBACTIONS;
    super(
      `BLOCK target=${target} does not support subaction=${subaction}. Supported: ${[...supported].join(", ")}`,
    );
    this.name = "BlockTargetUnsupportedError";
    this.target = target;
    this.subaction = subaction;
    this.supportedSubactions = [...supported];
  }
}

function readPlannerParams(
  options: HandlerOptions | undefined,
): Record<string, unknown> {
  const raw = (options as Record<string, unknown> | undefined)?.parameters;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function inferTargetFromSubaction(
  subaction: string | undefined,
): BlockTarget | null {
  if (!subaction) return null;
  if (
    subaction === "request_permission" ||
    subaction === "release" ||
    subaction === "list_active"
  ) {
    return "website";
  }
  return null;
}

function inferTargetFromParams(
  params: Record<string, unknown>,
): BlockTarget | null {
  // App-only params unambiguously identify the app surface.
  if (params.packageNames !== undefined || params.appTokens !== undefined) {
    return "app";
  }
  // Website-only params unambiguously identify the website surface.
  if (
    params.hostnames !== undefined ||
    params.ruleId !== undefined ||
    params.includeLiveStatus !== undefined ||
    params.includeManagedRules !== undefined
  ) {
    return "website";
  }
  return null;
}

function inferTargetFromText(text: string): BlockTarget | null {
  const lower = text.toLowerCase();
  // App hints win when present — phrases like "block twitter on my phone"
  // would otherwise score as a website match because of "twitter". Match the
  // app surface first, then fall through to website hints.
  //
  // The bare "apps" / "app" tokens are matched with word boundaries so
  // "unblock my apps" / "is anything blocked on my apps" route to app, while
  // legacy strings like "block apps" are still caught.
  const appHints = [
    /\bphone apps?\b/,
    /\bon my phone\b/,
    /\biphone\b/,
    /\bandroid\b/,
    /\bfamily controls\b/,
    /\bapp block\b/,
    /\bblock apps?\b/,
    /\bblock all games?\b/,
    /\bmy apps?\b/,
    /\bmobile apps?\b/,
  ];
  const websiteHints = [
    /\bwebsite\b/,
    /\bsite\b/,
    /\bdomain\b/,
    /\burl\b/,
    /\bhosts file\b/,
    /\bselfcontrol\b/,
    /\bx\.com\b/,
    /\btwitter\.com\b/,
    /\breddit\.com\b/,
    /\byoutube\.com\b/,
    /\binstagram\.com\b/,
    /\btiktok\.com\b/,
    /\bfacebook\.com\b/,
  ];
  if (appHints.some((hint) => hint.test(lower))) return "app";
  if (websiteHints.some((hint) => hint.test(lower))) return "website";
  return null;
}

function resolveTarget(
  params: Record<string, unknown>,
  message: Memory,
): BlockTarget | null {
  const explicit = params.target;
  if (typeof explicit === "string") {
    const trimmed = explicit.trim().toLowerCase();
    if (trimmed === "app" || trimmed === "website") return trimmed;
  }
  // Param-shape inference outranks subaction inference: a planner that supplied
  // `packageNames` or `hostnames` already declared its surface.
  const fromParams = inferTargetFromParams(params);
  if (fromParams) return fromParams;
  const subactionRaw = params.subaction;
  const fromSubaction = inferTargetFromSubaction(
    typeof subactionRaw === "string" ? subactionRaw.trim().toLowerCase() : undefined,
  );
  if (fromSubaction) return fromSubaction;
  const text = typeof message.content?.text === "string" ? message.content.text : "";
  return inferTargetFromText(text);
}

function targetSupports(
  target: BlockTarget,
  subaction: string,
): subaction is BlockSubaction {
  const set = target === "app" ? APP_SUBACTIONS : WEBSITE_SUBACTIONS;
  return set.has(subaction as BlockSubaction);
}

function withTarget(
  options: HandlerOptions | undefined,
  _target: BlockTarget,
): HandlerOptions {
  const incoming = (options ?? {}) as HandlerOptions;
  const incomingParams: ActionParameters = (incoming.parameters ??
    {}) as ActionParameters;
  // Strip the `target` from the params we forward — the underlying actions do
  // not understand it.
  const next: ActionParameters = { ...incomingParams };
  delete (next as Record<string, unknown>).target;
  return { ...incoming, parameters: next };
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "Block x.com and twitter.com for 2 hours." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: 'Ready to block x.com, twitter.com for 120 minutes. Reply "confirm" or re-issue with confirmed: true to start the block.',
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Block Twitter and Instagram on my phone for 2 hours." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Started blocking 2 apps until the block expires.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    { name: "{{name1}}", content: { text: "Is there a website block running?" } },
    {
      name: "{{agentName}}",
      content: {
        text: "A website block is active for x.com, twitter.com until 2026-04-04T13:44:54.000Z.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    { name: "{{name1}}", content: { text: "Unblock my phone apps." } },
    {
      name: "{{agentName}}",
      content: {
        text: "Removed the app block. All apps are unblocked now.",
        action: ACTION_NAME,
      },
    },
  ],
];

export const blockAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    // Legacy umbrella names — keep so cached planner outputs and the
    // `lifeops` provider's route hints keep resolving.
    "WEBSITE_BLOCK",
    "APP_BLOCK",
    // Legacy similes from the two folded actions.
    "WEBSITE_BLOCKER",
    "SELFCONTROL",
    "SITE_BLOCKER",
    "HOSTS_BLOCK",
    "FOCUS_BLOCK",
    "AUTOMATION_FOCUS_BLOCK",
    "BLOCK_WEBSITE",
    "APP_BLOCKER",
    "SHIELD_APPS",
    "FAMILY_CONTROLS",
    "PHONE_FOCUS",
    "SET_APP_BLOCK",
    "PHONE_SET_APP_BLOCK",
    "PHONE_BLOCK_APPS",
    "BLOCK_APPS",
  ],
  description:
    "Owner-only. Manage native blocking for phone apps OR desktop websites. " +
    "Pick `target: app` for phone-app blocking (Family Controls / Usage Access) and `target: website` for desktop website blocking (hosts file / SelfControl). " +
    "Subactions (target=app supports: block, unblock, status; target=website supports all six): " +
    "block (start a focus/site/app block; website block always drafts first and requires confirmed:true), " +
    "unblock (remove the active block), " +
    "status (whether a block is active and when it ends), " +
    "request_permission (website-only: request administrator/root approval for hosts-file edits), " +
    "release (website-only: release a managed block rule by id; requires confirmed:true), " +
    "list_active (website-only: list live OS-level + managed website block rules).",
  descriptionCompressed:
    "block app|website (phone-Family-Controls|hosts-file/SelfControl): block unblock status request_permission(web) release(web,ruleId,confirmed) list_active(web)",
  contexts: ["screen_time", "browser", "automation", "tasks", "settings"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async (runtime, message, state) => {
    // Either backend's gate must be open. Each action validates against its
    // own owner/permission rules — accept when at least one passes so the
    // umbrella matches whatever target the planner ultimately picks.
    const [appOk, webOk] = await Promise.all([
      appBlockActionImpl.validate(runtime, message, state),
      websiteBlockActionImpl.validate(runtime, message, state),
    ]);
    return appOk || webOk;
  },

  parameters: [
    {
      name: "target",
      description:
        "Which surface to act on: 'app' (phone apps) or 'website' (desktop hosts-file/SelfControl). " +
        "Inferred from `subaction` (request_permission/release/list_active → website), from app/website-only param shape, or from the user's text when omitted.",
      required: false,
      schema: { type: "string" as const, enum: [...ALL_TARGETS] },
    },
    {
      name: "subaction",
      description:
        "One of: block, unblock, status, request_permission, release, list_active. " +
        "request_permission, release, and list_active are website-only.",
      required: true,
      schema: { type: "string" as const, enum: [...ALL_SUBACTIONS] },
    },
    // Shared website + app params. The merged surface is intentionally
    // permissive: each backend reads only the keys it understands.
    {
      name: "intent",
      description:
        "Free-form description of what the owner wants. Used by the block subaction to extract apps/hostnames + duration.",
      required: false,
      schema: { type: "string" as const },
    },
    // Website-specific.
    {
      name: "hostnames",
      description:
        "(target=website) Public hostnames or URLs to block, e.g. ['x.com','twitter.com'].",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "confirmed",
      description:
        "(target=website) Set true only when the owner has explicitly confirmed the block. Without it, block returns a draft confirmation request. Required by release.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "ruleId",
      description: "(target=website, subaction=release) ID of the managed block rule to release.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "(target=website, subaction=release) Optional reason recorded on the rule when released.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "includeLiveStatus",
      description:
        "(target=website, subaction=list_active) Include the current hosts-file/SelfControl live block state. Default true.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "includeManagedRules",
      description:
        "(target=website, subaction=list_active) Include managed LifeOps block rules. Default true.",
      required: false,
      schema: { type: "boolean" as const },
    },
    // App-specific.
    {
      name: "packageNames",
      description:
        "(target=app, Android) Package names to block, e.g. ['com.twitter.android'].",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "appTokens",
      description:
        "(target=app, iOS) iPhone app tokens from a previous selectApps() call.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    // Shared duration param (semantics differ slightly; each backend honors its own bounds).
    {
      name: "durationMinutes",
      description:
        "How long to block, in minutes. Omit/null for an indefinite block that stays active until manually removed.",
      required: false,
      schema: { type: "number" as const },
    },
  ],

  examples,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: HandlerOptions | undefined,
    callback,
    responses,
  ): Promise<ActionResult> => {
    const params = readPlannerParams(options);
    const target = resolveTarget(params, message);
    if (!target) {
      return {
        success: false,
        text: "BLOCK requires `target: \"app\"` or `target: \"website\"`.",
        data: { actionName: ACTION_NAME, error: "MISSING_TARGET" },
      };
    }

    const subactionRaw = params.subaction;
    const subaction =
      typeof subactionRaw === "string"
        ? subactionRaw.trim().toLowerCase()
        : undefined;

    if (subaction && !targetSupports(target, subaction)) {
      throw new BlockTargetUnsupportedError(target, subaction);
    }

    const forwarded = withTarget(options, target);
    if (target === "app") {
      return appBlockActionImpl.handler(
        runtime,
        message,
        state,
        forwarded,
        callback,
        responses,
      );
    }
    return websiteBlockActionImpl.handler(
      runtime,
      message,
      state,
      forwarded,
      callback,
      responses,
    );
  },
};
