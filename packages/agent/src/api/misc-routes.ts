import crypto from "node:crypto";
import type http from "node:http";
import {
  type AgentRuntime,
  buildStoreVariantBlockedMessage,
  composePrompt,
  customActionGenerateTemplate,
  isLocalCodeExecutionAllowed,
  ModelType,
} from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import {
  PostAgentEventRequestSchema,
  PostCustomActionGenerateRequestSchema,
  PostCustomActionRequestSchema,
  PostCustomActionTestRequestSchema,
  PostEmoteRequestSchema,
  PostIngestShareRequestSchema,
  PostTerminalRunRequestSchema,
  PutCustomActionRequestSchema,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import type { CustomActionDef } from "../config/types.eliza.ts";
import {
  buildTestHandler,
  registerCustomActionLive,
} from "../runtime/custom-actions.ts";
import { runShell } from "../services/shell-execution-router.ts";
import { resolveTerminalRunLimits } from "./terminal-run-limits.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamEventEnvelope {
  type: string;
  version: number;
  eventId: string;
  ts: number;
  stream: string;
  agentId?: string;
  roomId?: string;
  payload: Record<string, unknown>;
}

type TerminalRunRequestBody = {
  command?: string;
  clientId?: unknown;
  terminalToken?: string;
};

function resolveTerminalShellCommand(): {
  command: string;
  argsFor: (command: string) => string[];
} {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      argsFor: (command) => ["/d", "/s", "/c", command],
    };
  }
  return {
    command:
      process.env.CODING_TOOLS_SHELL ||
      process.env.SHELL ||
      (process.env.ELIZA_PLATFORM === "android" ? "/system/bin/sh" : "/bin/sh"),
    argsFor: (command) => ["-c", command],
  };
}

type CompanionEmote = {
  id: string;
  path: string;
  duration?: number;
  loop?: boolean;
  [key: string]: unknown;
};

const COMPANION_EMOTES_MODULE: string = "@elizaos/app-companion";
let companionEmotesPromise: Promise<{
  catalog: CompanionEmote[];
  byId: Map<string, CompanionEmote>;
}> | null = null;

async function loadCompanionEmotes(): Promise<{
  catalog: CompanionEmote[];
  byId: Map<string, CompanionEmote>;
}> {
  companionEmotesPromise ??= import(/* @vite-ignore */ COMPANION_EMOTES_MODULE)
    .then((loaded) => {
      const catalog = Array.isArray(loaded.EMOTE_CATALOG)
        ? (loaded.EMOTE_CATALOG as CompanionEmote[])
        : [];
      const byId =
        loaded.EMOTE_BY_ID instanceof Map
          ? (loaded.EMOTE_BY_ID as Map<string, CompanionEmote>)
          : new Map(catalog.map((emote) => [emote.id, emote]));
      return { catalog, byId };
    })
    .catch(() => ({ catalog: [], byId: new Map<string, CompanionEmote>() }));
  return companionEmotesPromise;
}

function toTerminalRunRequestBody(
  body: Record<string, unknown>,
): TerminalRunRequestBody {
  return {
    command: typeof body.command === "string" ? body.command : undefined,
    clientId: body.clientId,
    terminalToken:
      typeof body.terminalToken === "string" ? body.terminalToken : undefined,
  };
}

export interface MiscRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: {
    config: ElizaConfig;
    runtime: AgentRuntime | null;
    agentState: string;
    agentName: string;
    shellEnabled: boolean | undefined;
    broadcastWs?: ((data: object) => void) | null;
    broadcastWsToClientId?: (clientId: string, data: object) => void;
    nextEventId: number;
    eventBuffer: StreamEventEnvelope[];
    shareIngestQueue: Array<{
      id: string;
      source: string;
      title?: string;
      url?: string;
      text?: string;
      suggestedPrompt: string;
      receivedAt: number;
    }>;
    startup: Record<string, unknown>;
    broadcastStatus?: () => void;
    pendingRestartReasons: string[];
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  AGENT_EVENT_ALLOWED_STREAMS: Set<string>;
  resolveTerminalRunRejection: (
    req: http.IncomingMessage,
    body: TerminalRunRequestBody,
  ) => { reason: string; status: number } | null;
  resolveTerminalRunClientId: (
    req: http.IncomingMessage,
    body: TerminalRunRequestBody,
  ) => string | null;
  isSharedTerminalClientId: (clientId: string) => boolean;
  activeTerminalRunCount: number;
  setActiveTerminalRunCount: (delta: number) => void;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleMiscRoutes(
  ctx: MiscRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, url, state, json, error, readJsonBody } =
    ctx;

  // ── POST /api/restart ───────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/restart") {
    state.agentState = "restarting";
    state.startup = {
      ...state.startup,
      phase: "restarting",
    };
    state.broadcastStatus?.();
    json(res, { ok: true, message: "Restarting...", restarting: true });
    setTimeout(() => process.exit(0), 1000);
    return true;
  }

  // ── POST /api/ingest/share ───────────────────────────────────────────
  if (method === "POST" && pathname === "/api/ingest/share") {
    const rawShare = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawShare === null) return true;
    const parsedShare = PostIngestShareRequestSchema.safeParse(rawShare);
    if (!parsedShare.success) {
      error(
        res,
        parsedShare.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedShare.data;

    const item = {
      id: crypto.randomUUID(),
      source: body.source ?? "unknown",
      title: body.title,
      url: body.url,
      text: body.text,
      suggestedPrompt: body.title
        ? `What do you think about "${body.title}"?`
        : body.url
          ? `Can you analyze this: ${body.url}`
          : body.text
            ? `What are your thoughts on: ${body.text.slice(0, 100)}`
            : "What do you think about this shared content?",
      receivedAt: Date.now(),
    };
    state.shareIngestQueue.push(item);
    json(res, { ok: true, item });
    return true;
  }

  // ── GET /api/ingest/share ────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/ingest/share") {
    const consume = url.searchParams.get("consume") === "1";
    if (consume) {
      const items = [...state.shareIngestQueue];
      state.shareIngestQueue.length = 0;
      json(res, { items });
    } else {
      json(res, { items: state.shareIngestQueue });
    }
    return true;
  }

  // ── GET /api/emotes ──────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/emotes") {
    const emotes = await loadCompanionEmotes();
    json(res, { emotes: emotes.catalog });
    return true;
  }

  // ── POST /api/emote ─────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/emote") {
    const rawEmote = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawEmote === null) return true;
    const parsedEmote = PostEmoteRequestSchema.safeParse(rawEmote);
    if (!parsedEmote.success) {
      error(
        res,
        parsedEmote.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedEmote.data;
    const emotes = await loadCompanionEmotes();
    const emote = body.emoteId ? emotes.byId.get(body.emoteId) : undefined;
    if (!emote) {
      error(res, `Unknown emote: ${body.emoteId ?? "(none)"}`);
      return true;
    }
    state.broadcastWs?.({
      type: "emote",
      emoteId: emote.id,
      path: emote.path,
      duration: emote.duration,
      loop: false,
    });
    json(res, { ok: true });
    return true;
  }

  // ── POST /api/agent/event ──────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/agent/event") {
    const rawEvent = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawEvent === null) return true;
    const parsedEvent = PostAgentEventRequestSchema.safeParse(rawEvent);
    if (!parsedEvent.success) {
      error(
        res,
        parsedEvent.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedEvent.data;
    if (!ctx.AGENT_EVENT_ALLOWED_STREAMS.has(body.stream)) {
      error(
        res,
        `Invalid stream: ${body.stream}. Allowed: ${[...ctx.AGENT_EVENT_ALLOWED_STREAMS].join(", ")}`,
        400,
      );
      return true;
    }
    const envelope: StreamEventEnvelope = {
      type: "agent_event",
      version: 1,
      eventId: `evt-${state.nextEventId}`,
      ts: Date.now(),
      stream: body.stream,
      agentId: state.runtime?.agentId
        ? String(state.runtime.agentId)
        : undefined,
      roomId: body.roomId,
      payload: body.data ?? {},
    };
    state.nextEventId += 1;
    state.eventBuffer.push(envelope);
    if (state.eventBuffer.length > 1500) {
      state.eventBuffer.splice(0, state.eventBuffer.length - 1500);
    }
    state.broadcastWs?.({ ...envelope });
    json(res, { ok: true });
    return true;
  }

  // ── POST /api/terminal/run ──────────────────────────────────────────
  if (method === "POST" && pathname === "/api/terminal/run") {
    if (!isLocalCodeExecutionAllowed()) {
      error(res, buildStoreVariantBlockedMessage("Terminal commands"), 403);
      return true;
    }

    if (state.shellEnabled === false) {
      error(res, "Shell access is disabled", 403);
      return true;
    }

    const rawTerm = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawTerm === null) return true;
    const parsedTerm = PostTerminalRunRequestSchema.safeParse(rawTerm);
    if (!parsedTerm.success) {
      error(
        res,
        parsedTerm.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedTerm.data;

    const terminalRejection = ctx.resolveTerminalRunRejection(req, body);
    if (terminalRejection) {
      error(res, terminalRejection.reason, terminalRejection.status);
      return true;
    }

    const command = body.command.trim();
    if (!command) {
      error(res, "Missing or empty command");
      return true;
    }

    if (command.length > 4096) {
      error(res, "Command exceeds maximum length (4096 chars)", 400);
      return true;
    }

    if (
      command.includes("\n") ||
      command.includes("\r") ||
      command.includes("\0")
    ) {
      error(
        res,
        "Command must be a single line without control characters",
        400,
      );
      return true;
    }

    const targetClientId = ctx.resolveTerminalRunClientId(req, body);
    if (!targetClientId) {
      error(
        res,
        "Missing client id. Provide X-Eliza-Client-Id header or clientId in the request body.",
        400,
      );
      return true;
    }

    const emitTerminalEvent = (payload: object) => {
      if (ctx.isSharedTerminalClientId(targetClientId)) {
        state.broadcastWs?.(payload);
        return;
      }
      if (typeof state.broadcastWsToClientId !== "function") return;
      state.broadcastWsToClientId(targetClientId, payload);
    };

    const { maxConcurrent, maxDurationMs } = resolveTerminalRunLimits();
    if (ctx.activeTerminalRunCount >= maxConcurrent) {
      error(
        res,
        `Too many active terminal runs (${maxConcurrent}). Wait for a command to finish.`,
        429,
      );
      return true;
    }

    const captureOutput = body.captureOutput === true;
    const MAX_CAPTURE_BYTES = 128 * 1024;

    if (!captureOutput) {
      json(res, { ok: true });
    }

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    emitTerminalEvent({
      type: "terminal-output",
      runId,
      event: "start",
      command,
      maxDurationMs,
    });

    ctx.setActiveTerminalRunCount(1);
    let finalized = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let truncated = false;

    const appendOutput = (current: string, chunkText: string): string => {
      if (!captureOutput || truncated || !chunkText) {
        return current;
      }
      const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current, "utf8");
      if (remaining <= 0) {
        truncated = true;
        return current;
      }
      const chunkBytes = Buffer.byteLength(chunkText, "utf8");
      if (chunkBytes <= remaining) {
        return current + chunkText;
      }
      truncated = true;
      return (
        current +
        Buffer.from(chunkText, "utf8").subarray(0, remaining).toString("utf8")
      );
    };

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      ctx.setActiveTerminalRunCount(-1);
      clearTimeout(timeoutHandle);
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "timeout",
        maxDurationMs,
      });
    }, maxDurationMs);

    const appendAndEmit = (stream: "stdout" | "stderr", text: string) => {
      if (stream === "stdout") stdout = appendOutput(stdout, text);
      else stderr = appendOutput(stderr, text);
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: stream,
        data: text,
      });
    };

    const shell = resolveTerminalShellCommand();
    runShell(
      {
        command: shell.command,
        args: shell.argsFor(command),
        cwd: process.env.SHELL_ALLOWED_DIRECTORY || process.cwd(),
        env: { FORCE_COLOR: "0" },
        timeoutMs: maxDurationMs,
        onStdout: (text) => appendAndEmit("stdout", text),
        onStderr: (text) => appendAndEmit("stderr", text),
        toolName: "terminal.run",
      },
      null,
    )
      .then((result) => {
        finalize();
        emitTerminalEvent({
          type: "terminal-output",
          runId,
          event: "exit",
          code: result.exitCode,
        });
        if (captureOutput) {
          json(res, {
            ok: true,
            runId,
            command,
            exitCode: result.exitCode,
            stdout,
            stderr,
            timedOut: timedOut || result.exitCode === 124,
            truncated,
            maxDurationMs,
            sandbox: result.sandbox,
            durationMs: result.durationMs,
          });
        }
      })
      .catch((err: Error) => {
        finalize();
        emitTerminalEvent({
          type: "terminal-output",
          runId,
          event: "error",
          data: err.message,
        });
        if (captureOutput) {
          error(res, err.message, 500);
        }
      });

    return true;
  }

  // ── Custom Actions CRUD ──────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/custom-actions") {
    const config = loadElizaConfig();
    json(res, { actions: config.customActions ?? [] });
    return true;
  }

  if (method === "POST" && pathname === "/api/custom-actions") {
    const rawAction = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawAction === null) return true;
    const parsedAction = PostCustomActionRequestSchema.safeParse(rawAction);
    if (!parsedAction.success) {
      error(
        res,
        parsedAction.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedAction.data;

    if (body.handler.type === "shell" || body.handler.type === "code") {
      const terminalRejection = ctx.resolveTerminalRunRejection(
        req,
        toTerminalRunRequestBody(rawAction),
      );
      if (terminalRejection) {
        error(
          res,
          `Creating ${body.handler.type} actions requires terminal authorization. ${terminalRejection.reason}`,
          terminalRejection.status,
        );
        return true;
      }
    }

    const now = new Date().toISOString();
    const actionDef: CustomActionDef = {
      id: crypto.randomUUID(),
      name: body.name.toUpperCase().replace(/\s+/g, "_"),
      description: body.description,
      similes: body.similes,
      parameters: body.parameters,
      handler: body.handler,
      enabled: body.enabled,
      createdAt: now,
      updatedAt: now,
    };

    const config = loadElizaConfig();
    if (!config.customActions) config.customActions = [];
    config.customActions.push(actionDef);
    saveElizaConfig(config);

    if (actionDef.enabled) {
      registerCustomActionLive(actionDef);
    }

    json(res, { ok: true, action: actionDef });
    return true;
  }

  // Generate a custom action definition from a natural language prompt
  if (method === "POST" && pathname === "/api/custom-actions/generate") {
    const rawGen = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawGen === null) return true;
    const parsedGen = PostCustomActionGenerateRequestSchema.safeParse(rawGen);
    if (!parsedGen.success) {
      error(
        res,
        parsedGen.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const prompt = parsedGen.data.prompt;

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent runtime not available", 503);
      return true;
    }

    try {
      const composedPrompt = composePrompt({
        state: { request: prompt },
        template: customActionGenerateTemplate,
      });

      const llmResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: composedPrompt,
      });

      const text =
        typeof llmResponse === "string" ? llmResponse : String(llmResponse);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        error(res, "Failed to generate action definition", 500);
        return true;
      }

      const generated = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      json(res, { ok: true, generated });
    } catch (err) {
      error(
        res,
        `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  const customActionMatch = pathname.match(/^\/api\/custom-actions\/([^/]+)$/);
  const customActionTestMatch = pathname.match(
    /^\/api\/custom-actions\/([^/]+)\/test$/,
  );

  if (method === "POST" && customActionTestMatch) {
    const actionId = decodeURIComponent(customActionTestMatch[1]);
    const rawTest = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawTest === null) return true;
    const parsedTest = PostCustomActionTestRequestSchema.safeParse(rawTest);
    if (!parsedTest.success) {
      error(
        res,
        parsedTest.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedTest.data;

    const config = loadElizaConfig();
    const def = (config.customActions ?? []).find((a) => a.id === actionId);
    if (!def) {
      error(res, "Action not found", 404);
      return true;
    }

    if (def.handler.type === "shell" || def.handler.type === "code") {
      const terminalRejection = ctx.resolveTerminalRunRejection(
        req,
        toTerminalRunRequestBody(rawTest),
      );
      if (terminalRejection) {
        error(
          res,
          `Testing ${def.handler.type} actions requires terminal authorization. ${terminalRejection.reason}`,
          terminalRejection.status,
        );
        return true;
      }
    }

    const testParams = body.params ?? {};
    const start = Date.now();
    try {
      const handler = buildTestHandler(def);
      const result = await handler(testParams);
      json(res, {
        ok: result.ok,
        output: result.output,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      json(res, {
        ok: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
    return true;
  }

  if (method === "PUT" && customActionMatch) {
    const actionId = decodeURIComponent(customActionMatch[1]);
    const rawUpdate = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawUpdate === null) return true;
    const parsedUpdate = PutCustomActionRequestSchema.safeParse(rawUpdate);
    if (!parsedUpdate.success) {
      error(
        res,
        parsedUpdate.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedUpdate.data;

    const config = loadElizaConfig();
    const actions = config.customActions ?? [];
    const idx = actions.findIndex((a) => a.id === actionId);
    if (idx === -1) {
      error(res, "Action not found", 404);
      return true;
    }

    const existing = actions[idx];
    const newHandler = body.handler ?? existing.handler;

    if (newHandler.type === "shell" || newHandler.type === "code") {
      const terminalRejection = ctx.resolveTerminalRunRejection(
        req,
        toTerminalRunRequestBody(rawUpdate),
      );
      if (terminalRejection) {
        error(
          res,
          `Updating to ${newHandler.type} handler requires terminal authorization. ${terminalRejection.reason}`,
          terminalRejection.status,
        );
        return true;
      }
    }

    const updated: CustomActionDef = {
      ...existing,
      name: body.name
        ? body.name.trim().toUpperCase().replace(/\s+/g, "_")
        : existing.name,
      description: body.description?.trim()
        ? body.description.trim()
        : existing.description,
      similes: body.similes ?? existing.similes,
      parameters: body.parameters ?? existing.parameters,
      handler: newHandler,
      enabled: body.enabled ?? existing.enabled,
      updatedAt: new Date().toISOString(),
    };

    actions[idx] = updated;
    config.customActions = actions;
    saveElizaConfig(config);

    json(res, { ok: true, action: updated });
    return true;
  }

  if (method === "DELETE" && customActionMatch) {
    const actionId = decodeURIComponent(customActionMatch[1]);

    const config = loadElizaConfig();
    const actions = config.customActions ?? [];
    const idx = actions.findIndex((a) => a.id === actionId);
    if (idx === -1) {
      error(res, "Action not found", 404);
      return true;
    }

    actions.splice(idx, 1);
    config.customActions = actions;
    saveElizaConfig(config);

    json(res, { ok: true });
    return true;
  }

  // Privy wallet routes (/api/privy/*) are now provided by the
  // @elizaos/app-steward plugin via the runtime route registry.

  return false;
}
