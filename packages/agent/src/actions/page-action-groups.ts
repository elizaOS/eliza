import type {
  Action,
  ActionParameters,
  ActionResult,
  AgentContext,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { resolveActionContexts } from "@elizaos/core";

/**
 * PAGE_DELEGATE — owner-only main-chat parent that dispatches to the child
 * action set scoped to a named page (browser, wallet, character, settings,
 * connectors, automation, phone, owner).
 *
 * Replaces the per-page `<PAGE>_ACTIONS` parents. The discriminator is `page`;
 * the child action name is `action`; child fields go in `parameters` (or as
 * top-level fields — `allowAdditionalParameters` auto-lifts them).
 */

const PAGE_KEYS = [
  "browser",
  "wallet",
  "character",
  "settings",
  "connectors",
  "automation",
  "phone",
  "owner",
] as const;

type PageKey = (typeof PAGE_KEYS)[number];

const PAGE_CONTEXTS: Record<PageKey, AgentContext[]> = {
  browser: ["browser"],
  wallet: ["wallet"],
  character: ["character"],
  settings: ["settings"],
  connectors: ["connectors"],
  automation: ["automation"],
  phone: ["phone"],
  owner: [
    "tasks",
    "calendar",
    "email",
    "contacts",
    "health",
    "subscriptions",
    "screen_time",
    "automation",
    "messaging",
  ],
};

const ALL_PAGE_CONTEXTS: AgentContext[] = Array.from(
  new Set<AgentContext>(
    PAGE_KEYS.flatMap((page) => PAGE_CONTEXTS[page]),
  ),
);

type PageActionGroup = Action & {
  actionGroup: {
    contexts: AgentContext[];
  };
};

type PageDelegateParameters = {
  page?: string;
  action?: string;
  parameters?: ActionParameters;
};

function normalizeActionName(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeContext(context: AgentContext): string {
  return `${context}`.toLowerCase();
}

function readPageKey(value: unknown): PageKey | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return (PAGE_KEYS as readonly string[]).includes(normalized)
    ? (normalized as PageKey)
    : undefined;
}

/**
 * Parse the delegate call into `{ page, action, parameters }`. Accepts both
 * the canonical nested shape and a flat shape that LLMs commonly emit.
 *
 * Canonical (nested):
 *   `{page: "browser", action: "BROWSER", parameters: {subaction: "navigate", url: "..."}}`
 *
 * Flat (auto-lifted): every key except `page`, `action`, and `parameters` is
 * treated as a child-action parameter and merged into `parameters`:
 *   `{page: "browser", action: "BROWSER", subaction: "navigate", url: "..."}`
 */
function readParameters(
  options: HandlerOptions | undefined,
): PageDelegateParameters {
  const parameters = options?.parameters ?? {};
  const explicitPage =
    typeof parameters.page === "string" ? parameters.page : undefined;
  const explicitAction =
    typeof parameters.action === "string" ? parameters.action : undefined;
  const explicitChildParams =
    parameters.parameters &&
    typeof parameters.parameters === "object" &&
    !Array.isArray(parameters.parameters)
      ? (parameters.parameters as ActionParameters)
      : undefined;
  const lifted: ActionParameters = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (key === "page" || key === "action" || key === "parameters") continue;
    lifted[key] = value as ActionParameters[string];
  }
  const hasLifted = Object.keys(lifted).length > 0;
  let mergedChildParams: ActionParameters | undefined;
  if (explicitChildParams && hasLifted) {
    mergedChildParams = { ...lifted, ...explicitChildParams };
  } else if (explicitChildParams) {
    mergedChildParams = explicitChildParams;
  } else if (hasLifted) {
    mergedChildParams = lifted;
  }
  return {
    page: explicitPage,
    action: explicitAction,
    parameters: mergedChildParams,
  };
}

function isPageDelegate(action: Action): boolean {
  return Array.isArray(
    (action as Partial<PageActionGroup>).actionGroup?.contexts,
  );
}

function actionMatchesName(action: Action, name: string): boolean {
  if (normalizeActionName(action.name) === name) {
    return true;
  }
  return (action.similes ?? []).some(
    (simile) => normalizeActionName(simile) === name,
  );
}

function actionMatchesContexts(
  action: Action,
  allowedContexts: Set<string>,
): boolean {
  return resolveActionContexts(action).some((context) =>
    allowedContexts.has(normalizeContext(context)),
  );
}

function findChildAction(
  runtime: IAgentRuntime,
  actionName: string,
  contexts: AgentContext[],
): Action | null {
  const normalizedName = normalizeActionName(actionName);
  const allowedContexts = new Set(contexts.map(normalizeContext));
  for (const action of runtime.actions) {
    if (isPageDelegate(action)) {
      continue;
    }
    if (!actionMatchesName(action, normalizedName)) {
      continue;
    }
    if (!actionMatchesContexts(action, allowedContexts)) {
      continue;
    }
    return action;
  }
  return null;
}

export const pageDelegateAction: PageActionGroup = {
  name: "PAGE_DELEGATE",
  similes: [
    "PAGE_ACTIONS",
    "BROWSER_TOOLS",
    "WALLET_TOOLS",
    "CHARACTER_TOOLS",
    "SETTINGS_TOOLS",
    "CONNECTOR_TOOLS",
    "AUTOMATION_TOOLS",
    "PHONE_TOOLS",
    "OWNER_TOOLS",
    "PERSONAL_ASSISTANT_ACTIONS",
  ],
  contexts: ["general", ...ALL_PAGE_CONTEXTS],
  actionGroup: { contexts: ALL_PAGE_CONTEXTS },
  roleGate: { minRole: "OWNER" },
  // Outer envelope accepts unknown top-level keys (auto-lifted to the child
  // action's parameters). Smaller LLMs commonly emit the flat shape
  // `{page, action, url, selector}` instead of nested
  // `{page, action, parameters:{url, selector}}`.
  allowAdditionalParameters: true,
  description: `Owner-only main-chat parent action. Routes a request to a child action under one of the page contexts (${PAGE_KEYS.join(", ")}). Call shape: { page: "<PAGE>", action: "<CHILD_NAME>", ...child fields }. The child action's parameter names go at the top level alongside \`page\` and \`action\` — for example, to navigate the browser: \`{ "page": "browser", "action": "BROWSER", "subaction": "navigate", "url": "https://example.com" }\`. The legacy nested shape \`{ page, action, parameters: { ... } }\` is also accepted. Page-scoped chats expose the child actions directly without going through PAGE_DELEGATE.`,
  descriptionCompressed:
    "PAGE_DELEGATE: owner-only parent; { page: <browser|wallet|character|settings|connectors|automation|phone|owner>, action: <CHILD>, ...child fields }.",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = readParameters(options);
    const page = readPageKey(params.page);
    if (!page) {
      return {
        success: false,
        text: `PAGE_DELEGATE requires a page parameter (one of: ${PAGE_KEYS.join(", ")}).`,
      };
    }

    const requestedAction = params.action?.trim();
    if (!requestedAction) {
      return {
        success: false,
        text: `PAGE_DELEGATE requires an action parameter naming the child action to run on the ${page} page.`,
      };
    }

    const childContexts = PAGE_CONTEXTS[page];
    const childAction = findChildAction(runtime, requestedAction, childContexts);
    if (!childAction) {
      return {
        success: false,
        text: `${requestedAction} is not available on the ${page} page.`,
      };
    }

    if (!(await childAction.validate(runtime, message, state))) {
      return {
        success: false,
        text: `${childAction.name} is not available for this request.`,
      };
    }

    return (
      (await childAction.handler(
        runtime,
        message,
        state,
        {
          ...options,
          parameters: params.parameters ?? {},
        },
        callback,
      )) ?? {
        success: true,
        text: `${childAction.name} completed.`,
      }
    );
  },
  parameters: [
    {
      name: "page",
      description:
        "Page context to dispatch under. Selects the allowed child-action context set.",
      required: true,
      schema: { type: "string" as const, enum: [...PAGE_KEYS] },
    },
    {
      name: "action",
      description:
        "Child action name to run, e.g. BROWSER, CHECK_BALANCE, MODIFY_CHARACTER, UPDATE_AI_PROVIDER, LIST_CONNECTORS.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "parameters",
      description:
        "Parameters forwarded to the selected child action. Use the child action's parameter names.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Open example.com in the browser." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Routing to BROWSER for navigation.",
          actions: ["PAGE_DELEGATE"],
          thought:
            "Owner asked for a browser navigation; PAGE_DELEGATE dispatches to the BROWSER child action under the browser page.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Show my wallet balance." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Pulling wallet balances.",
          actions: ["PAGE_DELEGATE"],
          thought:
            "Balance request maps to the wallet page; PAGE_DELEGATE dispatches to the CHECK_BALANCE child action.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What's on my calendar tomorrow?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Pulling tomorrow's events.",
          actions: ["PAGE_DELEGATE"],
          thought:
            "Calendar query falls under the owner page; PAGE_DELEGATE dispatches to the CALENDAR action=feed child.",
        },
      },
    ],
  ],
};
