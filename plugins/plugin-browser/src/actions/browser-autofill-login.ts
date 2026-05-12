/**
 * BROWSER autofill-login subaction — agent-driven browser login autofill.
 *
 * Invoked via BROWSER with `subaction: "autofill-login"` (canonical). The legacy
 * planner action name `BROWSER_AUTOFILL_LOGIN` normalizes to BROWSER with this
 * subaction in the planner dispatch pipeline.
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
 *     BROWSER (open/navigate).
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
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  createManager,
  getAutofillAllowed,
  getSavedLogin,
  listSavedLogins,
  type Vault,
} from "@elizaos/vault";
import {
  evaluateBrowserWorkspaceTab,
  isBrowserWorkspaceBridgeConfigured,
  listBrowserWorkspaceTabs,
} from "../workspace/browser-workspace.js";

interface BrowserAutofillLoginParameters {
  domain?: string;
  username?: string;
  /** When true, attempt to submit the form after filling. Default: false. */
  submit?: boolean;
}

const AUTOFILL_SUBACTION = "autofill-login";

const MAX_BROWSER_TAB_SCAN = 100;
const MAX_FILL_REASON_CHARS = 240;

let cachedVault: Vault | null = null;

function sharedAutofillVault(): Vault {
  cachedVault ??= createManager().vault;
  return cachedVault;
}

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

function narrowSnippetResult(raw: unknown): {
  filled: boolean;
  fillReason: string | null;
} {
  if (!raw || typeof raw !== "object") {
    return { filled: false, fillReason: null };
  }
  const obj = raw as { filled?: { username?: boolean; password?: boolean } };
  const hasFilledProp = "filled" in obj && Boolean(obj.filled);
  let fillReason: string | null = null;
  const reasonVal = "reason" in obj ? obj.reason : undefined;
  if (typeof reasonVal === "string") {
    fillReason = reasonVal.slice(0, MAX_FILL_REASON_CHARS);
  }
  return { filled: hasFilledProp, fillReason };
}

/**
 * Executes the vault-gated workspace autofill flow for {@link AUTOFILL_SUBACTION}.
 */
export async function executeBrowserAutofillLogin(
  _runtime: IAgentRuntime,
  _message: Memory | undefined,
  options: HandlerOptions | undefined,
): Promise<ActionResult> {
  const params = options?.parameters as
    | BrowserAutofillLoginParameters
    | undefined;
  const domain = params?.domain?.trim().toLowerCase() ?? "";
  const requestedUsername = params?.username?.trim();
  const submit = params?.submit === true;

  if (!domain) {
    return {
      text: `BROWSER requires subaction "${AUTOFILL_SUBACTION}" and a \`domain\` parameter.`,
      success: false,
      values: {
        success: false,
        error: "BROWSER_AUTOFILL_BAD_PARAMS",
        subaction: AUTOFILL_SUBACTION,
      },
      data: { actionName: "BROWSER", subaction: AUTOFILL_SUBACTION },
    };
  }

  if (!isBrowserWorkspaceBridgeConfigured(process.env)) {
    return {
      text: `BROWSER ${AUTOFILL_SUBACTION} requires the desktop browser workspace bridge.`,
      success: false,
      values: {
        success: false,
        error: "BROWSER_BRIDGE_UNAVAILABLE",
        subaction: AUTOFILL_SUBACTION,
      },
      data: { actionName: "BROWSER", subaction: AUTOFILL_SUBACTION },
    };
  }

  const vault = sharedAutofillVault();

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
        subaction: AUTOFILL_SUBACTION,
      },
      data: {
        actionName: "BROWSER",
        subaction: AUTOFILL_SUBACTION,
        domain,
        reason: text,
      },
    };
  }

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
          subaction: AUTOFILL_SUBACTION,
        },
        data: { actionName: "BROWSER", subaction: AUTOFILL_SUBACTION },
      };
    }
  } else {
    const summaries = await listSavedLogins(vault, domain);
    if (summaries.length === 0) {
      return {
        text: `No saved logins for ${domain}.`,
        success: false,
        values: {
          success: false,
          error: "AGENT_AUTOFILL_NO_LOGIN",
          domain,
          subaction: AUTOFILL_SUBACTION,
        },
        data: { actionName: "BROWSER", subaction: AUTOFILL_SUBACTION },
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
          subaction: AUTOFILL_SUBACTION,
        },
        data: { actionName: "BROWSER", subaction: AUTOFILL_SUBACTION },
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
          subaction: AUTOFILL_SUBACTION,
        },
        data: { actionName: "BROWSER", subaction: AUTOFILL_SUBACTION },
      };
    }
  }

  const tabs = await listBrowserWorkspaceTabs();
  const matchingTab = tabs
    .slice(0, MAX_BROWSER_TAB_SCAN)
    .find((t) => tabUrlMatchesDomain(t.url, domain));
  if (!matchingTab) {
    return {
      text: `No open browser tab on ${domain}. Open one with BROWSER (open/navigate) first.`,
      success: false,
      values: {
        success: false,
        error: "AGENT_AUTOFILL_NO_TAB",
        domain,
        subaction: AUTOFILL_SUBACTION,
      },
      data: { actionName: "BROWSER", subaction: AUTOFILL_SUBACTION },
    };
  }

  const script = buildAutofillScript({
    username: savedLogin.username,
    password: savedLogin.password,
    submit,
  });
  const rawResult = await evaluateBrowserWorkspaceTab({
    id: matchingTab.id,
    script,
  });
  const { filled, fillReason } = narrowSnippetResult(rawResult);

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
      subaction: AUTOFILL_SUBACTION,
      ...(fillReason ? { fillReason } : {}),
    },
    data: {
      actionName: "BROWSER",
      subaction: AUTOFILL_SUBACTION,
      domain,
      tabId: matchingTab.id,
      filled,
      ...(fillReason ? { fillReason } : {}),
    },
  };
}
