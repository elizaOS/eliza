/**
 * CREDENTIALS umbrella — folds browser-extension form fill (AUTOFILL) and
 * password manager CLI clipboard inject (PASSWORD_MANAGER) into a single
 * umbrella keyed only by action name (the verbs are unique across the union).
 *
 * Actions:
 *   fill | whitelist_add | whitelist_list -> AUTOFILL backend
 *   search | list | inject_username | inject_password -> PASSWORD_MANAGER backend
 */
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { runAutofillHandler } from "./autofill.js";
import { runPasswordManagerHandler } from "./password-manager.js";

const ACTION_NAME = "CREDENTIALS";

type AutofillSubaction = "fill" | "whitelist_add" | "whitelist_list";
type PasswordManagerSubaction =
  | "search"
  | "list"
  | "inject_username"
  | "inject_password";
type CredentialsSubaction = AutofillSubaction | PasswordManagerSubaction;

const AUTOFILL_SUBACTIONS: ReadonlySet<string> = new Set([
  "fill",
  "whitelist_add",
  "whitelist_list",
]);

const ALL_SUBACTIONS: readonly CredentialsSubaction[] = [
  "fill",
  "whitelist_add",
  "whitelist_list",
  "search",
  "list",
  "inject_username",
  "inject_password",
];

function readPlannerParams(
  options: HandlerOptions | undefined,
): Record<string, unknown> {
  const raw = (options as Record<string, unknown> | undefined)?.parameters;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "Can you log me into github? I'm on the sign-in page." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Requested password autofill on github.com via the browser extension.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Yes, trust notion.so for autofill going forward." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Added notion.so to the autofill whitelist.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    { name: "{{name1}}", content: { text: "Find my GitHub login" } },
    {
      name: "{{agentName}}",
      content: {
        text: "Searching your password manager for GitHub.",
        actions: [ACTION_NAME],
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Copy my AWS password to clipboard" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Copied the AWS password to your clipboard (clears in 30s).",
        actions: [ACTION_NAME],
      },
    },
  ],
];

export const credentialsAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    // Legacy umbrella names — keep so cached planner outputs and the
    // `lifeops` provider's route hints keep resolving.
    "AUTOFILL",
    "PASSWORD_MANAGER",
    // Legacy similes from the two folded actions.
    "FILL_PASSWORD",
    "TRUST_SITE",
    "SHOW_AUTOFILL_DOMAINS",
    "ONEPASSWORD",
    "PROTONPASS",
    "CREDENTIAL_LOOKUP",
    "COPY_CREDENTIAL",
    "SHOW_LOGINS",
  ],
  tags: [
    "domain:meta",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:execute",
    "surface:device",
    "surface:internal",
    "risk:irreversible",
  ],
  description:
    "Owner-only credentials. Browser autofill + OS password manager (1Password/ProtonPass). " +
    "Actions fill whitelisted one-field; whitelist_add domain confirmed:true; whitelist_list; search query; list bounded; inject_username|inject_password OS clipboard confirmed:true. " +
    "No plaintext credentials in chat; clipboard only.",
  descriptionCompressed:
    "CREDENTIALS fill|whitelist_add|list|search|inject_username|inject_password; clipboard-only",
  routingHint:
    "credentials search/list/copy/inject -> CREDENTIALS action=search|list|inject_*; on-page form fill -> action=fill",
  contexts: ["browser", "secrets", "settings", "automation"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async () => true,

  parameters: [
    {
      name: "action",
      description:
        "fill | whitelist_add | whitelist_list | search | list | inject_username | inject_password.",
      required: true,
      schema: { type: "string" as const, enum: [...ALL_SUBACTIONS] },
    },
    // Autofill-side params.
    {
      name: "field",
      description: "(action=fill) email | password | name | phone | custom.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "domain",
      description:
        "(action=fill|whitelist_add) Domain. fill fallback when url omitted.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "url",
      description: "(action=fill) Optional tab URL; whitelist enforcement.",
      required: false,
      schema: { type: "string" as const },
    },
    // Password-manager-side params.
    {
      name: "intent",
      description: "(action=search) Lookup intent text.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description: "(action=search) Match title, URL, username, tags.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "itemId",
      description:
        "(action=inject_username|inject_password) Password manager item id.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "(action=list) Item limit. Default 20.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "confirmed",
      description: "true required for whitelist_add and inject_*; owner gate.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],

  examples,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: HandlerOptions | undefined,
  ): Promise<ActionResult> => {
    const params = readPlannerParams(options);
    const subactionRaw = params.action ?? params.subaction;
    const subaction =
      typeof subactionRaw === "string" ? subactionRaw.trim().toLowerCase() : "";

    const forwardedOptions = {
      ...(options ?? {}),
      parameters: { ...params, subaction },
    } as HandlerOptions;

    if (AUTOFILL_SUBACTIONS.has(subaction)) {
      return runAutofillHandler(runtime, message, state, forwardedOptions);
    }
    return runPasswordManagerHandler(runtime, message, state, forwardedOptions);
  },
};
