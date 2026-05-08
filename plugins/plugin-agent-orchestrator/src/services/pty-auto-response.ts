/**
 * Auto-response rule management for PTY sessions (bypass-fix).
 *
 * Contains logic for pushing default auto-response rules per agent type
 * and handling Gemini authentication flow.
 *
 * @module services/pty-auto-response
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  AutoResponseRule,
  BunCompatiblePTYManager,
  PTYManager,
} from "pty-manager";
import { readConfigEnvKey } from "./config-env.js";

export interface AutoResponseContext {
  manager: PTYManager | BunCompatiblePTYManager;
  usingBunWorker: boolean;
  runtime: IAgentRuntime;
  log: (msg: string) => void;
}

const CODEX_KEEP_CURRENT_MODEL_NEVER_PROMPT_RE =
  /keep\s+current\s+model\s*\(never\s+show\s+again\)|hide\s+future\s+rate\s+limit\s+reminders\s+about\s+switching\s+models/i;
const CODEX_KEEP_CURRENT_MODEL_PROMPT_RE =
  /^(?![\s\S]*(?:never\s+show\s+again|hide\s+future\s+rate\s+limit\s+reminders))(?=[\s\S]*\bkeep\s+current\s+model\b)(?=[\s\S]*(?:efficient\s+model|less\s+capable|faster|rate\s+limit|switching\s+models))/i;
const CODEX_DEFAULT_ACCOUNT_SELECTION_PROMPT_RE =
  /(?:organization|account|team)\s+selection|select\s+(?:an?\s+)?(?:organization|account|team)\b/i;

/**
 * Push session-specific auto-response rules that depend on runtime config.
 * Trust prompts, update notices, and other static rules are handled by
 * adapter built-in rules (coding-agent-adapters). This only pushes rules
 * that need runtime values (e.g. API keys).
 */
export async function pushDefaultRules(
  ctx: AutoResponseContext,
  sessionId: string,
  agentType: string,
): Promise<void> {
  const rules: AutoResponseRule[] = [];

  // Codex sometimes renders the workspace trust screen incrementally.
  // The upstream adapter rule is one-shot; if it fires before the menu is fully
  // interactive, Codex can keep showing the same prompt and block the session.
  // Keep this session rule active until the prompt actually clears.
  if (agentType === "codex") {
    rules.push({
      pattern: CODEX_KEEP_CURRENT_MODEL_NEVER_PROMPT_RE,
      type: "config",
      response: "",
      responseType: "keys" as const,
      keys: ["3", "enter"],
      description:
        "Keep the current Codex model and hide future model-switch reminders",
      safe: true,
    });
    rules.push({
      pattern: CODEX_KEEP_CURRENT_MODEL_PROMPT_RE,
      type: "config",
      response: "",
      responseType: "keys" as const,
      keys: ["2", "enter"],
      description:
        "Keep the current Codex model when a routine model-switch reminder appears",
      safe: true,
    });
    rules.push({
      pattern:
        /higher.?risk.?of.?prompt.?injection|yes,?.?continue.*no,?.?quit|do.?you.?trust.?the.?contents|trust.?this.?directory|allow.?codex.?to.?work.?in.?this.?folder|without.?asking.?for.?approval/i,
      type: "permission",
      response: "",
      responseType: "keys" as const,
      keys: ["1", "enter"],
      description:
        "Retry Codex workspace trust approval with option 1 ('Yes, continue') until the prompt clears",
      safe: true,
    });
    rules.push({
      pattern: CODEX_DEFAULT_ACCOUNT_SELECTION_PROMPT_RE,
      type: "config",
      response: "",
      responseType: "keys" as const,
      keys: ["enter"],
      description:
        "Accept Codex's default organization/account selection for non-interactive subscription sessions",
      safe: true,
    });
  }

  // Aider gitignore prompt
  if (agentType === "aider") {
    rules.push({
      pattern: /\.aider\*.*\.gitignore.*\(Y\)es\/\(N\)o/i,
      type: "config",
      response: "y",
      description: "Auto-accept adding .aider* to .gitignore",
      safe: true,
    });
  }

  // Claude: API key confirmation prompt (appears when ANTHROPIC_API_KEY is set
  // alongside a subscription login, or in CLAUDE_CODE_SIMPLE mode)
  if (agentType === "claude") {
    const llmProvider =
      readConfigEnvKey("PARALLAX_LLM_PROVIDER") || "subscription";
    if (llmProvider === "api_keys" || llmProvider === "cloud") {
      rules.push({
        pattern:
          /Do you want to use this API key|(?:custom|detected).*API key.*environment/i,
        type: "config",
        response: "",
        responseType: "keys" as const,
        keys: ["up", "enter"],
        description: "Accept detected ANTHROPIC_API_KEY from environment",
        safe: true,
        once: true,
      });
    }

    // Bypass Permissions warning: fresh workdirs trigger a one-time
    // "Yes, I accept / No, exit" confirmation. pty-manager's TUI-aware
    // default for permission rules without explicit keys presses Enter,
    // which resolves to option 1 "No, exit" and kills claude with exit
    // code 1 before any work runs. Encode the response as explicit keys
    // so the worker types "2" + Enter. No `once`: TUI may redraw the
    // dialog before the selection is committed.
    //
    // Covers failure mode: seedClaudeTrustForWorkdir couldn't write
    // ~/.claude.json (file locked / read-only / concurrent write) AND the
    // session is non-coordinator (adapter auto-response still on).
    rules.push({
      pattern:
        /WARNING.{0,200}Bypass Permissions mode|Bypass Permissions mode.{0,200}accept all responsibility/is,
      type: "permission",
      response: "",
      responseType: "keys" as const,
      keys: ["2", "enter"],
      description:
        "Accept Claude Bypass Permissions dialog (option 2: 'Yes, I accept')",
      safe: true,
    });
  }

  // Gemini: auth flow (update notices are informational, don't need a response)
  if (agentType === "gemini") {
    // Auth menu detection: select API key or Google login based on available credentials
    const geminiApiKey = ctx.runtime.getSetting("GENERATIVE_AI_API_KEY") as
      | string
      | undefined;

    if (geminiApiKey) {
      // Have API key → select option 2 "Use an API key"
      rules.push({
        pattern:
          /Log in with Google|Use an API key|Use Vertex AI|gemini api key/i,
        type: "config",
        response: "2",
        description: "Select 'Use an API key' from Gemini auth menu",
        safe: true,
      });

      // Step 2: API key input prompt. Send the actual key value.
      // Tight regex: only matches the Gemini CLI's exact prompt format
      // to prevent exfiltration via crafted terminal output.
      // once: fire at most once per session to prevent repeated credential injection.
      rules.push({
        pattern:
          /^(?:\s|[>$#])*(?:Enter|Paste) (?:your )?(?:Google AI|Gemini) API key:/i,
        type: "config",
        response: geminiApiKey,
        description: "Input Gemini API key from Gemini CLI auth prompt",
        safe: true,
        once: true,
      });
    } else {
      // No API key → select option 1 "Log in with Google" (opens browser OAuth)
      rules.push({
        pattern:
          /Log in with Google|Use an API key|Use Vertex AI|gemini api key/i,
        type: "config",
        response: "1",
        description:
          "Select 'Log in with Google' from Gemini auth menu (browser OAuth)",
        safe: true,
      });
    }
  }

  if (rules.length === 0) return;

  // Push rules to the session via the runtime API
  try {
    if (ctx.usingBunWorker) {
      for (const rule of rules) {
        await (ctx.manager as BunCompatiblePTYManager).addAutoResponseRule(
          sessionId,
          rule,
        );
      }
    } else {
      const nodeManager = ctx.manager as PTYManager;
      for (const rule of rules) {
        nodeManager.addAutoResponseRule(sessionId, rule);
      }
    }
    ctx.log(
      `Pushed ${rules.length} auto-response rules to session ${sessionId}`,
    );

    // Note: No retroactive check needed here. The worker's tryAutoResponse()
    // runs on every data chunk and checks the full output buffer against all
    // active rules. Once rules are pushed, the next data chunk will trigger
    // matching. The old retroactive check caused ghost responses because it
    // bypassed the worker's TUI-aware response logic (sendKeys vs writeRaw).
  } catch (err) {
    ctx.log(`Failed to push rules to session ${sessionId}: ${err}`);
  }
}

/**
 * Handle Gemini authentication when login_required fires.
 * Sends /auth to start the auth flow; auto-response rules
 * then handle menu selection and API key input.
 */
export async function handleGeminiAuth(
  ctx: AutoResponseContext,
  sessionId: string,
  sendKeysToSession: (
    sessionId: string,
    keys: string | string[],
  ) => Promise<void>,
): Promise<void> {
  const apiKey = ctx.runtime.getSetting("GENERATIVE_AI_API_KEY") as
    | string
    | undefined;

  if (apiKey) {
    ctx.log(
      `Gemini auth: API key available, sending /auth to start API key flow`,
    );
  } else {
    ctx.log(
      `Gemini auth: no API key configured, sending /auth for Google OAuth flow`,
    );
  }

  // Send /auth via sendKeys to avoid send() which sets status to "busy".
  // We need to stay in "authenticating" so detectReady fires after auth completes.
  try {
    await sendKeysToSession(sessionId, "/auth");
    await new Promise((r) => setTimeout(r, 50));
    await sendKeysToSession(sessionId, "enter");
  } catch (err) {
    ctx.log(`Gemini auth: failed to send /auth: ${err}`);
  }
}
