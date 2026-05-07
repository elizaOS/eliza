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

type PageActionGroupConfig = {
  name: string;
  contexts: AgentContext[];
  description: string;
  similes?: string[];
};

type PageActionGroup = Action & {
  actionGroup: {
    contexts: AgentContext[];
  };
};

type PageActionGroupParameters = {
  action?: string;
  parameters?: ActionParameters;
};

const ACTION_GROUP_PARAMETER_SCHEMA = [
  {
    name: "action",
    description:
      "The child action name to run, such as BROWSER_SESSION, CHECK_BALANCE, MODIFY_CHARACTER, UPDATE_AI_PROVIDER, or LIST_CONNECTORS.",
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
];

function normalizeActionName(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeContext(context: AgentContext): string {
  return `${context}`.toLowerCase();
}

function readParameters(
  options: HandlerOptions | undefined,
): PageActionGroupParameters {
  const parameters = options?.parameters ?? {};
  return {
    action:
      typeof parameters.action === "string" ? parameters.action : undefined,
    parameters:
      parameters.parameters &&
      typeof parameters.parameters === "object" &&
      !Array.isArray(parameters.parameters)
        ? (parameters.parameters as ActionParameters)
        : undefined,
  };
}

function isPageActionGroup(action: Action): boolean {
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
    if (isPageActionGroup(action)) {
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

function createPageActionGroupAction(
  config: PageActionGroupConfig,
): PageActionGroup {
  return {
    name: config.name,
    similes: config.similes ?? [],
    contexts: ["general", ...config.contexts],
    actionGroup: { contexts: config.contexts },
    roleGate: { minRole: "OWNER" },
    description: `${config.description} Pass { action, parameters } to run one validated child action. Only the owner may use this parent action from main chat; page-scoped chats expose the child actions directly.`,
    descriptionCompressed: `${config.name}: owner-only parent action that delegates to page child actions.`,
    validate: async () => true,
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      state?: State,
      options?: HandlerOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const params = readParameters(options);
      const requestedAction = params.action?.trim();
      if (!requestedAction) {
        return {
          success: false,
          text: `${config.name} requires an action parameter naming the child action to run.`,
        };
      }

      const childAction = findChildAction(
        runtime,
        requestedAction,
        config.contexts,
      );
      if (!childAction) {
        return {
          success: false,
          text: `${requestedAction} is not available through ${config.name}.`,
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
    parameters: ACTION_GROUP_PARAMETER_SCHEMA,
    examples: [],
  };
}

export const browserActionsGroupAction = createPageActionGroupAction({
  name: "BROWSER_ACTIONS",
  contexts: ["browser"],
  similes: ["BROWSER_TOOLS", "BROWSER_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for browser page work including browser sessions, page extraction, app browser workspace control, and browser bridge setup/status.",
});

export const walletActionsGroupAction = createPageActionGroupAction({
  name: "WALLET_ACTIONS",
  contexts: ["wallet"],
  similes: ["WALLET_TOOLS", "WALLET_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for wallet page work including balances, receive addresses, swaps, transfers, wallet signing, and trading actions.",
});

export const characterActionsGroupAction = createPageActionGroupAction({
  name: "CHARACTER_ACTIONS",
  contexts: ["character"],
  similes: ["CHARACTER_TOOLS", "CHARACTER_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for character page work including character edits, owner identity, and profile-related actions.",
});

export const settingsActionsGroupAction = createPageActionGroupAction({
  name: "SETTINGS_ACTIONS",
  contexts: ["settings"],
  similes: ["SETTINGS_TOOLS", "SETTINGS_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for settings page work including identity, AI provider, capability, and training settings.",
});

export const connectorActionsGroupAction = createPageActionGroupAction({
  name: "CONNECTOR_ACTIONS",
  contexts: ["connectors"],
  similes: ["CONNECTOR_TOOLS", "CONNECTOR_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for connector page work including listing, enabling, disabling, configuring, and disconnecting connectors.",
});

export const automationActionsGroupAction = createPageActionGroupAction({
  name: "AUTOMATION_ACTIONS",
  contexts: ["automation"],
  similes: ["AUTOMATION_TOOLS", "AUTOMATION_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for automation page work including triggers, workflows, cron jobs, and task management.",
});

export const phoneActionsGroupAction = createPageActionGroupAction({
  name: "PHONE_ACTIONS",
  contexts: ["phone"],
  similes: ["PHONE_TOOLS", "PHONE_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for phone page work including calls, SMS/message review, contacts, and phone-related LifeOps actions.",
});

export const lifeOpsActionsGroupAction = createPageActionGroupAction({
  name: "LIFEOPS_ACTIONS",
  // Expanded from the legacy "lifeops" alias (see context-registry.ts) so this
  // action is gated by the actual canonical contexts the LifeOps page covers.
  contexts: [
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
  similes: ["LIFEOPS_TOOLS", "LIFEOPS_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for LifeOps page work including goals, reminders, inbox, calendar, browser workflows, health, subscriptions, travel, and approvals.",
});

export const pageActionGroupActions: Action[] = [
  browserActionsGroupAction,
  walletActionsGroupAction,
  characterActionsGroupAction,
  settingsActionsGroupAction,
  connectorActionsGroupAction,
  automationActionsGroupAction,
  phoneActionsGroupAction,
  lifeOpsActionsGroupAction,
];
