/**
 * Coding Agent HTTP Hooks — Webhook Endpoint
 *
 * Receives structured hook events from coding agent CLI hooks systems.
 * Claude Code sends native HTTP hooks; Gemini CLI bridges via curl commands.
 * Replaces fragile PTY output scraping for state detection with deterministic
 * event-driven signals.
 *
 * @module api/hook-routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./route-utils.js";
import { parseBody, sendError, sendJson } from "./route-utils.js";

/**
 * Hook event payload (subset of fields we use).
 * Supports both Claude Code (native HTTP) and Gemini CLI (curl bridge).
 *
 * Claude docs: https://docs.anthropic.com/en/docs/claude-code/hooks
 * Gemini docs: https://geminicli.com/docs/hooks/reference
 */
interface HookEventPayload {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  // Claude uses snake_case, Gemini uses camelCase
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  notification_type?: string;
  notificationType?: string;
  message?: string;
}

function asHookEventPayload(
  body: Record<string, unknown>,
): HookEventPayload | null {
  if (typeof body.hook_event_name !== "string" || !body.hook_event_name) {
    return null;
  }
  return {
    hook_event_name: body.hook_event_name,
    session_id:
      typeof body.session_id === "string" ? body.session_id : undefined,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    tool_name: typeof body.tool_name === "string" ? body.tool_name : undefined,
    toolName: typeof body.toolName === "string" ? body.toolName : undefined,
    tool_input:
      body.tool_input &&
      typeof body.tool_input === "object" &&
      !Array.isArray(body.tool_input)
        ? { ...body.tool_input }
        : undefined,
    notification_type:
      typeof body.notification_type === "string"
        ? body.notification_type
        : undefined,
    notificationType:
      typeof body.notificationType === "string"
        ? body.notificationType
        : undefined,
    message: typeof body.message === "string" ? body.message : undefined,
  };
}

/**
 * Handle Claude Code HTTP hook routes.
 * Returns true if the route was handled, false otherwise.
 */
export async function handleHookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  if (pathname !== "/api/coding-agents/hooks") return false;

  const method = req.method?.toUpperCase();
  if (method !== "POST") {
    sendError(res, "Method not allowed", 405);
    return true;
  }

  if (!ctx.ptyService) {
    sendError(res, "PTY Service not available", 503);
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch (err) {
    sendError(
      res,
      err instanceof Error ? err.message : "Failed to parse request body",
      400,
    );
    return true;
  }

  const payload = asHookEventPayload(body);
  if (!payload) {
    sendError(res, "Missing hook_event_name", 400);
    return true;
  }
  const eventName = payload.hook_event_name;

  // Normalize field names: Gemini uses camelCase, Claude uses snake_case
  const toolName = payload.tool_name ?? payload.toolName;
  const notificationType =
    payload.notification_type ?? payload.notificationType;

  // Look up PTY session: prefer explicit header, fall back to cwd-based lookup
  const headerSessionId = req.headers["x-parallax-session-id"] as
    | string
    | undefined;
  const sessionId = headerSessionId
    ? headerSessionId
    : payload.cwd
      ? ctx.ptyService.findSessionIdByCwd(payload.cwd)
      : undefined;

  if (!sessionId) {
    // Not fatal — the hook may fire before we've tracked the session.
    // Return success so the CLI doesn't retry.
    sendJson(res, { status: "ignored", reason: "session_not_found" });
    return true;
  }

  // Dispatch by event type
  switch (eventName) {
    // ── Claude Code events ──────────────────────────────────────────

    case "PermissionRequest": {
      // Auto-approve all tool permissions natively — no PTY keystroke needed.
      sendJson(res, {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      });
      ctx.ptyService.handleHookEvent(sessionId, "permission_approved", {
        tool: toolName,
      });
      return true;
    }

    case "PreToolUse": {
      // Track which tool is running — suppress stall detection.
      ctx.ptyService.handleHookEvent(sessionId, "tool_running", {
        toolName,
        source: "hook",
      });
      // Return allow decision so the tool proceeds without permission prompt.
      sendJson(res, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      });
      return true;
    }

    case "Stop": {
      // Agent finished responding — mark task complete.
      ctx.ptyService.handleHookEvent(sessionId, "task_complete", {
        source: "hook",
      });
      sendJson(res, {});
      return true;
    }

    case "TaskCompleted": {
      ctx.ptyService.handleHookEvent(sessionId, "task_complete", {
        source: "hook_task_completed",
      });
      sendJson(res, {});
      return true;
    }

    // ── Gemini CLI events ───────────────────────────────────────────

    case "BeforeTool": {
      // Track which tool is running — suppress stall detection.
      ctx.ptyService.handleHookEvent(sessionId, "tool_running", {
        toolName,
        source: "gemini_hook",
      });
      // Return allow + continue so Gemini proceeds without permission prompt.
      sendJson(res, { decision: "allow", continue: true });
      return true;
    }

    case "AfterTool": {
      // Tool finished — update activity (back to "active" state).
      ctx.ptyService.handleHookEvent(sessionId, "notification", {
        type: "tool_complete",
        message: `Tool ${toolName ?? "unknown"} finished`,
      });
      sendJson(res, { continue: true });
      return true;
    }

    case "AfterAgent": {
      // Agent loop ended — mark task complete.
      ctx.ptyService.handleHookEvent(sessionId, "task_complete", {
        source: "gemini_hook",
      });
      sendJson(res, { continue: true });
      return true;
    }

    case "SessionEnd": {
      // Session ending — mark exit.
      ctx.ptyService.handleHookEvent(sessionId, "session_end", {
        source: "hook",
      });
      sendJson(res, { continue: true });
      return true;
    }

    // ── Shared events ───────────────────────────────────────────────

    case "Notification": {
      // State change notifications (idle, permission, auth).
      // Gemini ToolPermission notifications get auto-approved.
      if (notificationType === "ToolPermission") {
        ctx.ptyService.handleHookEvent(sessionId, "permission_approved", {
          tool: toolName,
        });
        sendJson(res, { decision: "allow", continue: true });
        return true;
      }
      ctx.ptyService.handleHookEvent(sessionId, "notification", {
        type: notificationType,
        message: payload.message,
      });
      sendJson(res, { continue: true });
      return true;
    }

    default: {
      // Unknown event — acknowledge without action.
      sendJson(res, { status: "ignored", reason: "unknown_event" });
      return true;
    }
  }
}
