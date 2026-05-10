/**
 * Skill callback bridge — child→parent USE_SKILL routing.
 *
 * Spawned task agents (Claude Code, Codex, Gemini CLI, etc.) cannot directly
 * invoke parent skills. The bridge listens to PTY session output and, when
 * the child emits a directive of the form
 *
 *   USE_SKILL <slug> <json_args>
 *
 * dispatches to the parent's USE_SKILL action and pipes the result back into
 * the same session via `ptyService.sendToSession`.
 *
 * Default-on per the Hermes-style project direction. Disable by setting
 * `ELIZA_ENABLE_CHILD_SKILL_CALLBACK=0`.
 *
 * @module services/skill-callback-bridge
 */

import type { Action, IAgentRuntime, Logger } from "@elizaos/core";
import type { PTYService } from "./pty-service.js";
import {
  LIFEOPS_CONTEXT_BROKER_SLUG,
  runLifeOpsContextBroker,
} from "./skill-lifeops-context-broker.js";
import {
  PARENT_AGENT_BROKER_SLUG,
  runParentAgentBroker,
} from "./parent-agent-broker.js";

const LOG_PREFIX = "[SkillCallback]";
/**
 * Match `USE_SKILL <slug>` followed by an optional JSON args blob. The slug
 * shape mirrors `SKILL_NAME_PATTERN` in @elizaos/plugin-agent-skills, which
 * is strict lowercase-with-hyphens. We do NOT use the `i` flag so that
 * `USE_SKILL UPPER` is rejected (uppercase slugs are invalid).
 */
const USE_SKILL_DIRECTIVE_RE =
  /^[\t ]*USE_SKILL[\t ]+([a-z0-9]+(?:-[a-z0-9]+)*)[\t ]*(\{[\s\S]*?\}|\[[\s\S]*?\])?[\t ]*$/m;
const RESULT_PREVIEW_MAX = 1500;

interface SkillUseAction extends Action {
  name: string;
}

interface SkillCallbackInvocation {
  slug: string;
  args: unknown;
}

interface SkillCallbackResult {
  success: boolean;
  text: string;
}

function getLogger(runtime: IAgentRuntime): Logger | Console {
  const candidate = (runtime as { logger?: Logger }).logger;
  return candidate ?? console;
}

function isCallbackEnabled(runtime: IAgentRuntime): boolean {
  const raw =
    (runtime.getSetting("ELIZA_ENABLE_CHILD_SKILL_CALLBACK") as
      | string
      | undefined) ?? process.env.ELIZA_ENABLE_CHILD_SKILL_CALLBACK;
  if (raw === undefined || raw === null || raw === "") return true;
  const normalized = String(raw).trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Parse the first USE_SKILL directive in a chunk of agent output, if any.
 * The directive must be on its own line (after optional whitespace).
 */
export function parseUseSkillDirective(
  text: string,
): SkillCallbackInvocation | null {
  if (!text) return null;
  const match = USE_SKILL_DIRECTIVE_RE.exec(text);
  if (!match) return null;
  const slug = match[1];
  const argsRaw = match[2];
  if (!slug) return null;

  let args: unknown;
  if (argsRaw?.trim()) {
    try {
      args = JSON.parse(argsRaw);
    } catch {
      // Treat unparseable args as a string literal — user intent is clear,
      // and the USE_SKILL handler can decide how to coerce it.
      args = argsRaw.trim();
    }
  }
  return { slug, args };
}

function formatResultForChild(
  slug: string,
  result: SkillCallbackResult,
): string {
  const trimmed =
    result.text.length > RESULT_PREVIEW_MAX
      ? `${result.text.slice(0, RESULT_PREVIEW_MAX)}\n…[truncated]`
      : result.text;
  const status = result.success ? "ok" : "error";
  return [
    `--- USE_SKILL response (${slug}, ${status}) ---`,
    trimmed,
    `--- End USE_SKILL response ---`,
  ].join("\n");
}

/**
 * Locate the USE_SKILL action on the runtime. Returns null when the agent
 * skills plugin is not loaded; virtual brokers still route without it.
 */
function resolveUseSkillAction(runtime: IAgentRuntime): SkillUseAction | null {
  const actions = (runtime as { actions?: Action[] }).actions;
  if (!Array.isArray(actions)) return null;
  for (const action of actions) {
    if (!action || typeof action.name !== "string") continue;
    if (action.name === "USE_SKILL" || action.similes?.includes("USE_SKILL")) {
      return action as SkillUseAction;
    }
  }
  return null;
}

interface BridgeDeps {
  runtime: IAgentRuntime;
  ptyService: PTYService;
  /**
   * Optional: per-session allow-list of skill slugs. The bridge consults the
   * registry below when dispatching a child USE_SKILL directive. A directive
   * whose slug is not on the session's allow-list is rejected back into the
   * child with an error message listing the slugs that were rendered into that
   * session's SKILLS.md.
   *
   * If omitted (or no entry is registered for the session), the bridge falls
   * back to permissive behavior — any enabled skill may be invoked. This
   * preserves backwards-compatible behavior for callers that do not yet wire
   * per-spawn manifests.
   */
  sessionAllowList?: SkillSessionAllowList;
}

/**
 * Session-scoped allow-list registry. Callers register a session's allow-list
 * at spawn time from the generated SKILLS.md manifest. The bridge reads the
 * entry when a USE_SKILL directive arrives.
 *
 * Using a plain Map instead of a WeakMap — the key is the PTY sessionId
 * string assigned at spawn time, which we must explicitly clear on session
 * teardown to avoid leaks.
 */
export interface SkillSessionAllowList {
  register: (sessionId: string, slugs: readonly string[]) => void;
  clear: (sessionId: string) => void;
  get: (sessionId: string) => readonly string[] | undefined;
}

export function createSkillSessionAllowList(): SkillSessionAllowList {
  const entries = new Map<string, readonly string[]>();
  return {
    register: (sessionId, slugs) => {
      entries.set(sessionId, [...slugs]);
    },
    clear: (sessionId) => {
      entries.delete(sessionId);
    },
    get: (sessionId) => entries.get(sessionId),
  };
}

/**
 * Per-runtime install guard — prevents stacking duplicate listeners when
 * many spawn calls fire concurrently. Keyed by the WeakRef to the runtime
 * so the entry naturally drops when the runtime is GC'd.
 */
const installedRuntimes = new WeakSet<object>();

/**
 * Ensure the bridge is installed exactly once for this runtime+PTY pair.
 * Safe to call from every task spawn — subsequent calls are no-ops. The
 * session allow-list registry, when supplied, is attached on the first
 * install and reused thereafter; callers can look up the registry they
 * passed in to register per-session slugs.
 */
export function ensureSkillCallbackBridge(deps: BridgeDeps): void {
  const runtimeKey = deps.runtime as object;
  if (installedRuntimes.has(runtimeKey)) return;
  installedRuntimes.add(runtimeKey);
  installSkillCallbackBridge(deps);
}

/**
 * Install the child→parent USE_SKILL bridge for the given PTY service. Safe
 * to call multiple times — duplicate listeners are idempotent because the
 * unsubscribe handle is returned to the caller.
 *
 * Returns a teardown function. Call it on shutdown to remove the listener.
 */
export function installSkillCallbackBridge(deps: BridgeDeps): () => void {
  const { runtime, ptyService, sessionAllowList } = deps;
  const log = getLogger(runtime);

  if (!isCallbackEnabled(runtime)) {
    log.debug?.(
      `${LOG_PREFIX} disabled via ELIZA_ENABLE_CHILD_SKILL_CALLBACK=0`,
    );
    return () => undefined;
  }

  const useSkillAction = resolveUseSkillAction(runtime);

  const dispatchToParent = async (
    sessionId: string,
    invocation: SkillCallbackInvocation,
  ): Promise<void> => {
    // Enforce the per-session recommended-skills allow-list when one is
    // registered. Without an entry we preserve permissive behavior.
    const allowedSlugs = sessionAllowList?.get(sessionId);
    if (allowedSlugs && !allowedSlugs.includes(invocation.slug)) {
      const recommended =
        allowedSlugs.length > 0
          ? allowedSlugs.map((slug) => `\`${slug}\``).join(", ")
          : "(none)";
      const text = `Skill \`${invocation.slug}\` is not on this task's allow-list. Recommended: ${recommended}.`;
      log.warn?.(
        `${LOG_PREFIX} session ${sessionId} requested non-recommended skill ${invocation.slug}; allow-list=[${allowedSlugs.join(",")}]`,
      );
      const reply = formatResultForChild(invocation.slug, {
        success: false,
        text,
      });
      await ptyService.sendToSession(sessionId, reply);
      return;
    }
    if (
      invocation.slug === LIFEOPS_CONTEXT_BROKER_SLUG &&
      !allowedSlugs?.includes(LIFEOPS_CONTEXT_BROKER_SLUG)
    ) {
      const text =
        "Skill `lifeops-context` is sensitive and is only available when the parent explicitly recommends it for this spawned task.";
      log.warn?.(
        {
          src: LOG_PREFIX,
          event: "lifeops_context_denied",
          sessionId,
        },
        `${LOG_PREFIX} session ${sessionId} requested lifeops-context without an allow-list grant`,
      );
      const reply = formatResultForChild(invocation.slug, {
        success: false,
        text,
      });
      await ptyService.sendToSession(sessionId, reply);
      return;
    }
    log.info?.(
      `${LOG_PREFIX} child session ${sessionId} requested skill ${invocation.slug}`,
    );

    if (invocation.slug === LIFEOPS_CONTEXT_BROKER_SLUG) {
      const result = await runLifeOpsContextBroker({
        runtime,
        sessionId,
        session: ptyService.getSession(sessionId),
        args: invocation.args,
      });
      const reply = formatResultForChild(invocation.slug, {
        success: result.success !== false,
        text:
          typeof result.text === "string" && result.text.trim()
            ? result.text
            : "(no output)",
      });
      await ptyService.sendToSession(sessionId, reply);
      return;
    }

    if (invocation.slug === PARENT_AGENT_BROKER_SLUG) {
      const result = await runParentAgentBroker({
        runtime,
        sessionId,
        session: ptyService.getSession(sessionId),
        args: invocation.args,
      });
      const reply = formatResultForChild(invocation.slug, {
        success: result.success !== false,
        text:
          typeof result.text === "string" && result.text.trim()
            ? result.text
            : "(no output)",
      });
      await ptyService.sendToSession(sessionId, reply);
      return;
    }

    if (!useSkillAction || typeof useSkillAction.handler !== "function") {
      const reply = formatResultForChild(invocation.slug, {
        success: false,
        text: "The parent does not have the disk USE_SKILL action loaded for this skill. The virtual parent-agent and lifeops-context brokers can still be used when allowed for the task.",
      });
      await ptyService.sendToSession(sessionId, reply);
      return;
    }

    const captured: string[] = [];
    const captureCallback = async (response: {
      text?: string;
    }): Promise<unknown[]> => {
      if (typeof response?.text === "string") {
        captured.push(response.text);
      }
      return [];
    };

    const handlerResult = await useSkillAction.handler(
      runtime,
      // The action does not consume the message in our path — pass a minimal
      // stub that satisfies the Memory shape.
      {
        content: { text: `USE_SKILL ${invocation.slug}` },
        entityId: `child-session:${sessionId}`,
        roomId: `child-session:${sessionId}`,
      } as never,
      undefined,
      { slug: invocation.slug, args: invocation.args } as never,
      captureCallback as never,
    );

    const success =
      handlerResult && typeof handlerResult === "object"
        ? Boolean((handlerResult as { success?: unknown }).success)
        : false;
    const handlerText =
      handlerResult && typeof handlerResult === "object"
        ? typeof (handlerResult as { text?: unknown }).text === "string"
          ? (handlerResult as { text: string }).text
          : ""
        : "";
    const text = handlerText || captured.join("\n").trim() || "(no output)";

    const reply = formatResultForChild(invocation.slug, { success, text });
    await ptyService.sendToSession(sessionId, reply);
  };

  const unsubscribe = ptyService.onSessionEvent((sessionId, event, data) => {
    if (event !== "task_complete" && event !== "message") return;
    const responseText =
      typeof (data as { response?: unknown })?.response === "string"
        ? (data as { response: string }).response
        : typeof (data as { text?: unknown })?.text === "string"
          ? (data as { text: string }).text
          : "";
    const invocation = parseUseSkillDirective(responseText);
    if (!invocation) return;

    // Fire-and-forget: skill dispatch must not block the PTY event loop. We
    // surface failures via logger.error rather than swallowing them silently.
    void dispatchToParent(sessionId, invocation).catch((err) => {
      log.error?.(
        `${LOG_PREFIX} dispatch failed for session ${sessionId} skill ${invocation.slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  log.info?.(`${LOG_PREFIX} child→parent USE_SKILL bridge installed`);

  return () => {
    if (typeof unsubscribe === "function") {
      unsubscribe();
    }
  };
}
