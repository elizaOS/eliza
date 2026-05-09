import crypto from "node:crypto";
import type http from "node:http";
import {
  type AgentRuntime,
  composePrompt,
  customActionGenerateTemplate,
  ModelType,
} from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import { asRecord } from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.js";
import { loadElizaConfig, saveElizaConfig } from "../config/config.js";
import type {
  CustomActionDef,
  CustomActionHandler,
} from "../config/types.eliza.js";
import {
  buildTestHandler,
  registerCustomActionLive,
} from "../runtime/custom-actions.js";
import { resolveTerminalRunLimits } from "./terminal-run-limits.js";

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

function isCustomActionHandler(value: unknown): value is CustomActionHandler {
  const handler = asRecord(value);
  if (!handler || typeof handler.type !== "string") {
    return false;
  }

  if (handler.type === "http") {
    return (
      typeof handler.method === "string" &&
      typeof handler.url === "string" &&
      (handler.headers === undefined || asRecord(handler.headers) !== null) &&
      (handler.bodyTemplate === undefined ||
        typeof handler.bodyTemplate === "string")
    );
  }

  if (handler.type === "shell") {
    return typeof handler.command === "string";
  }

  if (handler.type === "code") {
    return typeof handler.code === "string";
  }

  return false;
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
    const body = await readJsonBody<{
      source?: string;
      title?: string;
      url?: string;
      text?: string;
    }>(req, res);
    if (!body) return true;

    const item = {
      id: crypto.randomUUID(),
      source: (body.source as string) ?? "unknown",
      title: body.title as string | undefined,
      url: body.url as string | undefined,
      text: body.text as string | undefined,
      suggestedPrompt: body.title
        ? `What do you think about "${body.title}"?`
        : body.url
          ? `Can you analyze this: ${body.url}`
          : body.text
            ? `What are your thoughts on: ${(body.text as string).slice(0, 100)}`
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
    const body = await readJsonBody<{ emoteId?: string }>(req, res);
    if (!body) return true;
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
    const body = await readJsonBody<{
      stream?: string;
      data?: Record<string, unknown>;
      roomId?: string;
    }>(req, res);
    if (!body?.stream) {
      error(res, "Missing 'stream' field");
      return true;
    }
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
    if (state.shellEnabled === false) {
      error(res, "Shell access is disabled", 403);
      return true;
    }

    const body = await readJsonBody<{
      command?: string;
      clientId?: unknown;
      terminalToken?: string;
      captureOutput?: boolean;
    }>(req, res);
    if (!body) return true;

    const terminalRejection = ctx.resolveTerminalRunRejection(req, body);
    if (terminalRejection) {
      error(res, terminalRejection.reason, terminalRejection.status);
      return true;
    }

    const command = typeof body.command === "string" ? body.command.trim() : "";
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

    const { spawn } = await import("node:child_process");
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    emitTerminalEvent({
      type: "terminal-output",
      runId,
      event: "start",
      command,
      maxDurationMs,
    });

    const proc = spawn(command, {
      shell: true,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
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
      if (proc.killed) return;
      timedOut = true;
      proc.kill("SIGTERM");
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "timeout",
        maxDurationMs,
      });

      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 3000);
    }, maxDurationMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stdout = appendOutput(stdout, text);
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "stdout",
        data: text,
      });
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderr = appendOutput(stderr, text);
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "stderr",
        data: text,
      });
    });

    proc.on("close", (code: number | null) => {
      finalize();
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "exit",
        code: code ?? 1,
      });
      if (captureOutput) {
        json(res, {
          ok: true,
          runId,
          command,
          exitCode: code ?? 1,
          stdout,
          stderr,
          timedOut,
          truncated,
          maxDurationMs,
        });
      }
    });

    proc.on("error", (err: Error) => {
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
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description =
      typeof body.description === "string" ? body.description.trim() : "";

    if (!name || !description) {
      error(res, "name and description are required", 400);
      return true;
    }

    const handler = body.handler as CustomActionDef["handler"] | undefined;
    const validHandlerTypes = new Set(["http", "shell", "code"]);
    if (!handler?.type || !validHandlerTypes.has(handler.type)) {
      error(
        res,
        "handler with valid type (http, shell, code) is required",
        400,
      );
      return true;
    }

    if (handler.type === "shell" || handler.type === "code") {
      const terminalRejection = ctx.resolveTerminalRunRejection(
        req,
        toTerminalRunRequestBody(body),
      );
      if (terminalRejection) {
        error(
          res,
          `Creating ${handler.type} actions requires terminal authorization. ${terminalRejection.reason}`,
          terminalRejection.status,
        );
        return true;
      }
    }

    if (
      handler.type === "http" &&
      (typeof handler.url !== "string" || !handler.url.trim())
    ) {
      error(res, "HTTP handler requires a url", 400);
      return true;
    }
    if (
      handler.type === "shell" &&
      (typeof handler.command !== "string" || !handler.command.trim())
    ) {
      error(res, "Shell handler requires a command", 400);
      return true;
    }
    if (
      handler.type === "code" &&
      (typeof handler.code !== "string" || !handler.code.trim())
    ) {
      error(res, "Code handler requires code", 400);
      return true;
    }

    const now = new Date().toISOString();
    const actionDef: CustomActionDef = {
      id: crypto.randomUUID(),
      name: name.toUpperCase().replace(/\s+/g, "_"),
      description,
      similes: Array.isArray(body.similes)
        ? body.similes.filter((s): s is string => typeof s === "string")
        : [],
      parameters: Array.isArray(body.parameters)
        ? (body.parameters as Array<{
            name: string;
            description: string;
            required: boolean;
          }>)
        : [],
      handler,
      enabled: body.enabled !== false,
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
    const body = await readJsonBody<{ prompt?: string }>(req, res);
    if (!body) return true;

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      error(res, "prompt is required", 400);
      return true;
    }

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
    const body = await readJsonBody<{ params?: Record<string, string> }>(
      req,
      res,
    );
    if (!body) return true;

    const config = loadElizaConfig();
    const def = (config.customActions ?? []).find((a) => a.id === actionId);
    if (!def) {
      error(res, "Action not found", 404);
      return true;
    }

    if (def.handler.type === "shell" || def.handler.type === "code") {
      const terminalRejection = ctx.resolveTerminalRunRejection(
        req,
        toTerminalRunRequestBody(body),
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
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const config = loadElizaConfig();
    const actions = config.customActions ?? [];
    const idx = actions.findIndex((a) => a.id === actionId);
    if (idx === -1) {
      error(res, "Action not found", 404);
      return true;
    }

    const existing = actions[idx];

    let newHandler = existing.handler;
    if (body.handler != null) {
      const h = asRecord(body.handler);
      const hValidTypes = new Set(["http", "shell", "code"]);
      if (!h?.type || !hValidTypes.has(String(h.type))) {
        error(res, "handler.type must be http, shell, or code", 400);
        return true;
      }
      if (!isCustomActionHandler(h)) {
        error(res, "handler payload is invalid", 400);
        return true;
      }
      newHandler = h;
    }

    if (newHandler.type === "shell" || newHandler.type === "code") {
      const terminalRejection = ctx.resolveTerminalRunRejection(
        req,
        toTerminalRunRequestBody(body),
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
      name:
        typeof body.name === "string"
          ? body.name.trim().toUpperCase().replace(/\s+/g, "_")
          : existing.name,
      description:
        typeof body.description === "string"
          ? body.description.trim()
          : existing.description,
      similes: Array.isArray(body.similes)
        ? body.similes.filter((s): s is string => typeof s === "string")
        : existing.similes,
      parameters: Array.isArray(body.parameters)
        ? (body.parameters as CustomActionDef["parameters"])
        : existing.parameters,
      handler: newHandler,
      enabled:
        typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
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
