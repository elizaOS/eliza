/**
 * BROWSER_AUTOFILL_LOGIN — agent-driven browser login autofill.
 *
 * Lets the agent say "log into github.com for me" and have the saved
 * credentials filled into an open Eliza browser tab without a per-call
 * consent prompt.
 *
 * Authorization model (mirrors the user-driven autofill flow):
 *   - The user must have set `creds.<domain>.:autoallow = "1"` on the
 *     domain. This is the same vault key the React-side consent flow
 *     uses; toggling it from Settings -> Vault -> Logins is the
 *     SOLE way to let the agent autofill silently.
 *   - Without that flag, this action returns
 *     `{ ok: false, reason: "user has not pre-authorized agent autofill for <domain>" }`.
 *     The agent should NOT fall back to the user-driven flow on its own
 *     because the user-driven flow is gated by an interactive React
 *     modal that an autonomous agent cannot consent to.
 *
 * Tab selection:
 *   - Lists the live browser-workspace tabs and picks the first one
 *     whose URL hostname matches `domain` (registrable hostname,
 *     case-insensitive). Returns a clean error when no such tab exists
 *     so the agent can decide whether to open one first via
 *     BROWSER_SESSION.
 *
 * Fill mechanism:
 *   - Injects a small JS snippet that mirrors the same form-detection
 *     and `setNativeInputValue` helpers the in-tab preload uses, so
 *     React-controlled inputs see the change.
 *   - When `submit: true`, the snippet also calls `form.submit()` (or
 *     clicks a likely submit button) after filling. Off by default —
 *     the safer behaviour is fill-only and let the user click submit.
 */

import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  getAutofillAllowed,
  getSavedLogin,
  listSavedLogins,
} from "@elizaos/vault";
import { hasOwnerAccess } from "../security/access.js";
import {
  evaluateBrowserWorkspaceTab,
  isBrowserWorkspaceBridgeConfigured,
  listBrowserWorkspaceTabs,
} from "../services/browser-workspace.js";

interface BrowserAutofillLoginParameters {
  domain?: string;
  username?: string;
  /** When true, attempt to submit the form after filling. Default: false. */
  submit?: boolean;
}
const MAX_BROWSER_TAB_SCAN = 100;
const MAX_FILL_REASON_CHARS = 240;

function tabUrlMatchesDomain(tabUrl: string, domain: string): boolean {
  if (!tabUrl) return false;
  let hostname: string;
  try {
    hostname = new URL(tabUrl).hostname;
  } catch {
    return false;
  }
  return hostname.toLowerCase() === domain.toLowerCase();
}

function buildAutofillScript(args: {
  username: string;
  password: string;
  submit: boolean;
}): string {
  // Inline snippet — runs in the OOPIF (the page's content world) via
  // electrobun tab eval. Uses setNativeInputValue to bypass React's
  // value-setter override.
  return `
(() => {
  const USERNAME = ${JSON.stringify(args.username)};
  const PASSWORD = ${JSON.stringify(args.password)};
  const SUBMIT = ${args.submit ? "true" : "false"};

  function setNativeInputValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findPrecedingTextInput(passwordInput) {
    const root = passwordInput.form || document.body;
    const candidates = root.querySelectorAll(
      'input[type="text"], input[type="email"], input:not([type])'
    );
    let lastBefore = null;
    for (const el of candidates) {
      if (el.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING) {
        lastBefore = el;
      }
    }
    return lastBefore;
  }

  const password = document.querySelector('input[type="password"]');
  if (!password) {
    return { ok: false, reason: "no_password_input" };
  }
  const form = password.form;
  const username =
    (form && form.querySelector(
      'input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i]'
    )) || findPrecedingTextInput(password);

  if (username) setNativeInputValue(username, USERNAME);
  setNativeInputValue(password, PASSWORD);

  if (SUBMIT) {
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else if (form && typeof form.submit === "function") {
      form.submit();
    } else {
      const button =
        (form && form.querySelector('button[type="submit"], input[type="submit"]')) ||
        document.querySelector('button[type="submit"], input[type="submit"]');
      if (button) (button).click();
    }
  }

  return {
    ok: true,
    filled: { username: !!username, password: true },
    submitted: SUBMIT,
  };
})();
`;
}

export const browserAutofillLoginAction: Action = {
  name: "BROWSER_AUTOFILL_LOGIN",
  contexts: ["browser", "web", "secrets"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "AGENT_AUTOFILL",
    "AUTOFILL_BROWSER_LOGIN",
    "AUTOFILL_LOGIN",
    "FILL_BROWSER_CREDENTIALS",
    "LOG_INTO_SITE",
    "SIGN_IN_TO_SITE",
  ],
  description:
    "Autofill saved credentials into an open Eliza browser tab for the requested domain. Requires the user to have pre-authorized agent autofill for the domain via Settings -> Vault -> Logins (`creds.<domain>.:autoallow = 1`).",
  descriptionCompressed:
    "autofill save credential open Eliza browser tab request domain require user pre-authorize agent autofill domain via Settings - Vault - Logins (cred domain: autoallow 1)",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return hasOwnerAccess(runtime, message);
  },
  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may run BROWSER_AUTOFILL_LOGIN.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "BROWSER_AUTOFILL_LOGIN" },
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters as
      | BrowserAutofillLoginParameters
      | undefined;
    const domain = params?.domain?.trim().toLowerCase() ?? "";
    const requestedUsername = params?.username?.trim();
    const submit = params?.submit === true;

    if (!domain) {
      return {
        text: "BROWSER_AUTOFILL_LOGIN requires a `domain` parameter.",
        success: false,
        values: {
          success: false,
          error: "BROWSER_AUTOFILL_LOGIN_BAD_PARAMS",
        },
        data: { actionName: "BROWSER_AUTOFILL_LOGIN" },
      };
    }

    if (!isBrowserWorkspaceBridgeConfigured(process.env)) {
      return {
        text: "BROWSER_AUTOFILL_LOGIN requires the desktop browser workspace bridge.",
        success: false,
        values: {
          success: false,
          error: "BROWSER_BRIDGE_UNAVAILABLE",
        },
        data: { actionName: "BROWSER_AUTOFILL_LOGIN" },
      };
    }

    // Resolve the shared vault via dynamic import — the agent package
    // doesn't directly depend on @elizaos/app-core to avoid a circular
    // graph; the runtime bootstraps app-core before any action runs.
    const { sharedVault } = (await import(
      "@elizaos/app-core/services/vault-mirror"
    )) as typeof import("@elizaos/app-core/services/vault-mirror");
    const vault = sharedVault();

    // ── Authorization gate: per-domain autoallow flag ─────────────
    const allowed = await getAutofillAllowed(vault, domain);
    if (!allowed) {
      const text = `User has not pre-authorized agent autofill for ${domain}. Toggle "Allow agent to autofill" for this domain under Settings -> Vault -> Logins.`;
      return {
        text,
        success: false,
        values: {
          success: false,
          error: "AGENT_AUTOFILL_NOT_AUTHORIZED",
          domain,
        },
        data: { actionName: "BROWSER_AUTOFILL_LOGIN", domain, reason: text },
      };
    }

    // ── Look up credentials ──────────────────────────────────────
    let savedLogin: Awaited<ReturnType<typeof getSavedLogin>> = null;
    if (requestedUsername) {
      savedLogin = await getSavedLogin(vault, domain, requestedUsername);
      if (!savedLogin) {
        return {
          text: `No saved login for ${requestedUsername} on ${domain}.`,
          success: false,
          values: {
            success: false,
            error: "AGENT_AUTOFILL_NO_LOGIN",
            domain,
            username: requestedUsername,
          },
          data: { actionName: "BROWSER_AUTOFILL_LOGIN" },
        };
      }
    } else {
      // No username supplied — pick the most recently modified entry.
      const summaries = await listSavedLogins(vault, domain);
      if (summaries.length === 0) {
        return {
          text: `No saved logins for ${domain}.`,
          success: false,
          values: {
            success: false,
            error: "AGENT_AUTOFILL_NO_LOGIN",
            domain,
          },
          data: { actionName: "BROWSER_AUTOFILL_LOGIN" },
        };
      }
      const sorted = [...summaries].sort(
        (a, b) => b.lastModified - a.lastModified,
      );
      const chosen = sorted[0];
      if (!chosen) {
        return {
          text: `No saved logins for ${domain}.`,
          success: false,
          values: {
            success: false,
            error: "AGENT_AUTOFILL_NO_LOGIN",
            domain,
          },
          data: { actionName: "BROWSER_AUTOFILL_LOGIN" },
        };
      }
      savedLogin = await getSavedLogin(vault, domain, chosen.username);
      if (!savedLogin) {
        return {
          text: `Saved login ${chosen.username} on ${domain} disappeared between list and reveal.`,
          success: false,
          values: {
            success: false,
            error: "AGENT_AUTOFILL_RACE",
            domain,
          },
          data: { actionName: "BROWSER_AUTOFILL_LOGIN" },
        };
      }
    }

    // ── Locate the open tab ──────────────────────────────────────
    const tabs = await listBrowserWorkspaceTabs();
    const matchingTab = tabs
      .slice(0, MAX_BROWSER_TAB_SCAN)
      .find((t) => tabUrlMatchesDomain(t.url, domain));
    if (!matchingTab) {
      return {
        text: `No open browser tab on ${domain}. Open one with BROWSER_SESSION first.`,
        success: false,
        values: {
          success: false,
          error: "AGENT_AUTOFILL_NO_TAB",
          domain,
        },
        data: { actionName: "BROWSER_AUTOFILL_LOGIN" },
      };
    }

    // ── Inject and evaluate the autofill script ──────────────────
    const script = buildAutofillScript({
      username: savedLogin.username,
      password: savedLogin.password,
      submit,
    });
    const rawResult = await evaluateBrowserWorkspaceTab({
      id: matchingTab.id,
      script,
    });
    // The injected snippet returns
    //   { ok: boolean; reason?: string; filled?: { username, password }; submitted?: boolean }
    // — narrow to the fields we surface in `values` so the action result
    // is plain JSON.
    const filled =
      rawResult &&
      typeof rawResult === "object" &&
      "filled" in (rawResult as Record<string, unknown>)
        ? Boolean((rawResult as { filled?: unknown }).filled)
        : false;
    const fillReason =
      rawResult &&
      typeof rawResult === "object" &&
      typeof (rawResult as { reason?: unknown }).reason === "string"
        ? (rawResult as { reason: string }).reason.slice(0, MAX_FILL_REASON_CHARS)
        : null;

    logger.info(
      `[browser-autofill-login] domain=${domain} tabId=${matchingTab.id} submit=${submit} filled=${filled}`,
    );

    return {
      text: submit
        ? `Filled and submitted login on ${domain} (tab ${matchingTab.id}).`
        : `Filled login on ${domain} (tab ${matchingTab.id}). User must click submit.`,
      success: true,
      values: {
        success: true,
        domain,
        tabId: matchingTab.id,
        submitted: submit,
        filled,
        ...(fillReason ? { fillReason } : {}),
      },
      data: {
        actionName: "BROWSER_AUTOFILL_LOGIN",
        domain,
        tabId: matchingTab.id,
        filled,
        ...(fillReason ? { fillReason } : {}),
      },
    };
  },
  parameters: [
    {
      name: "domain",
      description:
        "Registrable hostname to autofill (e.g. `github.com`, no protocol or path).",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "username",
      description:
        "Specific saved login to use. When omitted, the most recently modified saved login for the domain is selected.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "submit",
      description:
        "When true, submit the form after filling. Defaults to false (fill-only).",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Log into github.com for me" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Filled login on github.com. Click submit when ready.",
          actions: ["BROWSER_AUTOFILL_LOGIN"],
        },
      },
    ],
  ],
};
