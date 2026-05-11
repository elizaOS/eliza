import type {
  Action,
  ActionExample,
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
  examples?: ActionExample[][];
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
      "The child action name to run, such as BROWSER, CHECK_BALANCE, MODIFY_CHARACTER, UPDATE_AI_PROVIDER, or LIST_CONNECTORS.",
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
    examples: config.examples ?? [],
  };
}

export const browserActionsGroupAction = createPageActionGroupAction({
  name: "BROWSER_ACTIONS",
  contexts: ["browser"],
  similes: ["BROWSER_TOOLS", "BROWSER_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for browser page work including browser sessions, page extraction, app browser workspace control, and browser bridge setup/status.",
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
          actions: ["BROWSER_ACTIONS"],
          thought:
            "Owner asked for a browser navigation; BROWSER_ACTIONS forwards to the BROWSER child action.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Pull the article text from the page I'm on." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Extracting the page contents now.",
          actions: ["BROWSER_ACTIONS"],
          thought:
            "Page-text request maps to EXTRACT_PAGE; BROWSER_ACTIONS dispatches to it under the browser context.",
        },
      },
    ],
  ],
});

export const walletActionsGroupAction = createPageActionGroupAction({
  name: "WALLET_ACTIONS",
  contexts: ["wallet"],
  similes: ["WALLET_TOOLS", "WALLET_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for wallet page work including balances, receive addresses, swaps, transfers, wallet signing, and trading actions.",
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show my wallet balance." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Pulling wallet balances.",
          actions: ["WALLET_ACTIONS"],
          thought:
            "Balance request belongs to the wallet page; WALLET_ACTIONS forwards to the CHECK_BALANCE child action.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Send 0.1 ETH to my savings address." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Preparing the transfer.",
          actions: ["WALLET_ACTIONS"],
          thought:
            "Transfer intent under the wallet page routes through WALLET_ACTIONS to the EVM_TRANSFER child action.",
        },
      },
    ],
  ],
});

export const characterActionsGroupAction = createPageActionGroupAction({
  name: "CHARACTER_ACTIONS",
  contexts: ["character"],
  similes: ["CHARACTER_TOOLS", "CHARACTER_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for character page work including character edits, owner identity, and profile-related actions.",
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Update my character bio to mention I work in design.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Updating the character bio.",
          actions: ["CHARACTER_ACTIONS"],
          thought:
            "Character bio edit belongs to the character page; CHARACTER_ACTIONS forwards to the MODIFY_CHARACTER child action.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Set my owner display name to Pat." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Setting your display name.",
          actions: ["CHARACTER_ACTIONS"],
          thought:
            "Owner identity update routes through CHARACTER_ACTIONS to the owner identity child action.",
        },
      },
    ],
  ],
});

export const settingsActionsGroupAction = createPageActionGroupAction({
  name: "SETTINGS_ACTIONS",
  contexts: ["settings"],
  similes: ["SETTINGS_TOOLS", "SETTINGS_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for settings page work including identity, AI provider, capability, and training settings.",
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Switch the LLM provider to Anthropic." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Switching the AI provider.",
          actions: ["SETTINGS_ACTIONS"],
          thought:
            "AI provider change is a settings-page concern; SETTINGS_ACTIONS forwards to the UPDATE_AI_PROVIDER child action.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Turn on autonomy mode in settings." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Enabling autonomy mode.",
          actions: ["SETTINGS_ACTIONS"],
          thought:
            "Capability toggle is a settings-page concern; SETTINGS_ACTIONS forwards to the TOGGLE_FEATURE / SETTINGS child action.",
        },
      },
    ],
  ],
});

export const connectorActionsGroupAction = createPageActionGroupAction({
  name: "CONNECTOR_ACTIONS",
  contexts: ["connectors"],
  similes: ["CONNECTOR_TOOLS", "CONNECTOR_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for connector page work including listing, enabling, disabling, configuring, and disconnecting connectors.",
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me which connectors are enabled." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Listing your connectors.",
          actions: ["CONNECTOR_ACTIONS"],
          thought:
            "Connector inventory belongs to the connectors page; CONNECTOR_ACTIONS forwards to the LIST_CONNECTORS child action.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Disconnect the Slack integration." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Disconnecting Slack.",
          actions: ["CONNECTOR_ACTIONS"],
          thought:
            "Disconnect intent on the connectors page routes through CONNECTOR_ACTIONS to the CONNECTOR action=disconnect child.",
        },
      },
    ],
  ],
});

export const automationActionsGroupAction = createPageActionGroupAction({
  name: "AUTOMATION_ACTIONS",
  contexts: ["automation"],
  similes: ["AUTOMATION_TOOLS", "AUTOMATION_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for automation page work including triggers, workflows, cron jobs, and task management.",
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Schedule a daily standup reminder at 9am on weekdays.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Setting up the recurring reminder.",
          actions: ["AUTOMATION_ACTIONS"],
          thought:
            "Cron-style schedule belongs to the automation page; AUTOMATION_ACTIONS forwards to the SCHEDULED_TASKS action=create child.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "List the workflows I have running." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Pulling your workflows.",
          actions: ["AUTOMATION_ACTIONS"],
          thought:
            "Workflow inventory routes through AUTOMATION_ACTIONS to the WORKFLOW / TRIGGER child action.",
        },
      },
    ],
  ],
});

export const phoneActionsGroupAction = createPageActionGroupAction({
  name: "PHONE_ACTIONS",
  contexts: ["phone"],
  similes: ["PHONE_TOOLS", "PHONE_PAGE_ACTIONS"],
  description:
    "Main-chat parent action for phone page work including calls, SMS/message review, contacts, and phone-related LifeOps actions.",
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Call Pat back." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Placing the call.",
          actions: ["PHONE_ACTIONS"],
          thought:
            "Outgoing call belongs to the phone page; PHONE_ACTIONS forwards to the VOICE_CALL child action.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Look up the number for Pat in my contacts." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Searching your contacts.",
          actions: ["PHONE_ACTIONS"],
          thought:
            "Contact lookup on the phone page routes through PHONE_ACTIONS to the CONTACT action=search child.",
        },
      },
    ],
  ],
});

export const ownerActionsGroupAction = createPageActionGroupAction({
  name: "OWNER_ACTIONS",
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
  similes: ["OWNER_TOOLS", "OWNER_PAGE_ACTIONS", "PERSONAL_ASSISTANT_ACTIONS"],
  description:
    "Main-chat parent action for owner page work including goals, reminders, inbox, calendar, browser workflows, health, subscriptions, travel, and approvals.",
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What's on my calendar tomorrow?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Pulling tomorrow's events.",
          actions: ["OWNER_ACTIONS"],
          thought:
            "Calendar query is an owner-page concern; OWNER_ACTIONS forwards to the CALENDAR action=feed child.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Triage my inbox." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Triaging messages now.",
          actions: ["OWNER_ACTIONS"],
          thought:
            "Inbox triage on the owner page routes through OWNER_ACTIONS to the MESSAGE action=triage child.",
        },
      },
    ],
  ],
});

export const pageActionGroupActions: Action[] = [
  browserActionsGroupAction,
  walletActionsGroupAction,
  characterActionsGroupAction,
  settingsActionsGroupAction,
  connectorActionsGroupAction,
  automationActionsGroupAction,
  phoneActionsGroupAction,
  ownerActionsGroupAction,
];
