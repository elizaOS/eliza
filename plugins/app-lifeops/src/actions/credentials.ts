/**
 * CREDENTIALS umbrella — Audit B Defer #5.
 *
 * Folds the previous standalone `AUTOFILL` (browser-extension form fill, 3
 * actions) and `PASSWORD_MANAGER` (1Password / ProtonPass CLI clipboard
 * inject, 4 actions) actions into a single umbrella keyed only by the
 * action name (no `target` field - the verbs are unique across the union).
 *
 * Action enum (union of both legacy surfaces):
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
    "Owner-only password and autofill operations across browser autofill (LifeOps extension) and the OS password manager (1Password / ProtonPass). " +
    "Actions: fill (one-field autofill on a whitelisted site), whitelist_add (add a domain; requires confirmed:true), whitelist_list, search (match items by query), list (bounded), inject_username, inject_password (copy to OS clipboard; both require confirmed:true). " +
    "Plaintext credentials never appear in chat — only the OS clipboard.",
  descriptionCompressed:
    "credentials: fill|whitelist_add|whitelist_list|search|list|inject_username|inject_password; clipboard-only; confirmed:true required for inject and whitelist_add",
  routingHint:
    "credential search/list/copy/inject -> CREDENTIALS action=search|list|inject_*; on-page form fill -> CREDENTIALS action=fill",
  contexts: ["browser", "secrets", "settings", "automation"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async () => true,

  parameters: [
    {
      name: "action",
      description:
        "fill | whitelist_add | whitelist_list (autofill) | search | list | inject_username | inject_password (password manager).",
      required: true,
      schema: { type: "string" as const, enum: [...ALL_SUBACTIONS] },
    },
    // Autofill-side params.
    {
      name: "field",
      description:
        "(action=fill) One of email, password, name, phone, custom. Tells the password manager which field to resolve.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "domain",
      description:
        "(action=fill | whitelist_add) Domain to act on. For fill, used as the tab URL when url is omitted.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "url",
      description:
        "(action=fill) Optional explicit tab URL (used for whitelist enforcement).",
      required: false,
      schema: { type: "string" as const },
    },
    // Password-manager-side params.
    {
      name: "intent",
      description:
        "(action=search) Natural-language description of the lookup intent.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "(action=search) Search string matched against item title, URL, username, and tags.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "itemId",
      description:
        "(action=inject_username | inject_password) Password manager item id.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "(action=list) Optional item limit (default 20).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "confirmed",
      description:
        "Required true for whitelist_add and for either inject_* action. Ensures the owner approved the change.",
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
