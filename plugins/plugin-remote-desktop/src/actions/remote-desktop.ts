/**
 * REMOTE_DESKTOP action — stub.
 *
 * The real implementation currently lives in
 * `plugins/plugin-personal-assistant/src/actions/remote-desktop.ts` and depends on the
 * lifeops-internal helpers:
 *
 *   - `plugins/plugin-personal-assistant/src/lifeops/remote-desktop.ts`
 *       (detectRemoteDesktopBackend, endRemoteSession, getSessionStatus,
 *        RemoteDesktopSession)
 *   - `plugins/plugin-personal-assistant/src/remote/remote-session-service.ts`
 *       (getRemoteSessionService, RemoteSessionError)
 *   - `plugins/plugin-personal-assistant/src/actions/lib/resolve-action-args.ts`
 *       (resolveActionArgs, SubactionsMap)
 *
 * TODO(remote-desktop migration): in the follow-up migration pass:
 *   1. Move the lifeops helpers above into this plugin (src/lifeops/, src/remote/).
 *   2. Move the resolve-action-args helper into a shared location accessible
 *      from both plugin-lifeops and plugin-remote-desktop, or vendor a copy here.
 *   3. Port the full handler body (handleStart/handleStatus/handleEnd/handleList/
 *      handleRevoke) verbatim into this file.
 *   4. Replace this stub with the real implementation.
 *   5. Have plugin-lifeops re-export this action for backward compatibility
 *      during the deprecation window.
 *
 * For now we expose a typed Action object with the same metadata
 * (similes/description/tags/parameters/examples/roleGate) as the original so
 * the surface is wired in correctly. The handler returns a NOT_IMPLEMENTED
 * result that points the caller back to plugin-lifeops.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";

import type {
  RemoteDesktopActionParams,
  RemoteDesktopSubaction,
} from "../types.js";

const ACTION_NAME = "REMOTE_DESKTOP";

// Suppresses the planner's post-action continuation prompt. The original
// action in plugin-lifeops sets this same flag.
type RemoteDesktopAction = Action & {
  suppressPostActionContinuation?: boolean;
};

export const remoteDesktopAction: RemoteDesktopAction = {
  name: ACTION_NAME,
  similes: [
    "REMOTE_SESSION",
    "VNC_SESSION",
    "REMOTE_CONTROL",
    "PHONE_REMOTE_ACCESS",
    "CONNECT_FROM_PHONE",
  ],
  description:
    "Remote-desktop sessions; owner connects to this machine from another device. " +
    "Subactions start confirmed:true cloud pairingCode; status|end|revoke sessionId; list active.",
  descriptionCompressed:
    "REMOTE_DESKTOP start|status|end|list|revoke; start confirmed:true; cloud pairingCode",
  tags: [
    "domain:meta",
    "capability:read",
    "capability:write",
    "capability:execute",
    "capability:delete",
    "surface:device",
    "surface:internal",
    "risk:irreversible",
  ],
  contexts: ["browser", "automation", "settings", "admin", "terminal"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async () => true,

  parameters: [
    {
      name: "action",
      description: "start | status | end | list | revoke.",
      descriptionCompressed:
        "remote-desktop action: start|status|end|list|revoke",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["start", "status", "end", "list", "revoke"],
      },
      examples: ["start", "list", "revoke"],
    },
    {
      name: "sessionId",
      description: "Session id. Required status|end|revoke.",
      descriptionCompressed: "session id (status|end|revoke)",
      required: false,
      schema: { type: "string" as const },
      examples: ["rs_abc123"],
    },
    {
      name: "confirmed",
      description: "true required for start; security gate.",
      descriptionCompressed: "true required for start (security)",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "pairingCode",
      description:
        "6-digit pairingCode for start. Required unless ELIZA_REMOTE_LOCAL_MODE=1.",
      descriptionCompressed:
        "6-digit pairing code (start; skipped in local mode)",
      required: false,
      schema: { type: "string" as const, pattern: "^[0-9]{6}$" },
      examples: ["482193"],
    },
    {
      name: "requesterIdentity",
      description: "Requester id/name/device. Audit start.",
      descriptionCompressed: "audit: requester id (start)",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description: "Owner intent/reason. Audit.",
      descriptionCompressed: "audit: owner reason",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Start a remote session with pairing code 482193, confirmed.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Remote session active. Connect via vnc://host:5900.",
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Are any remote sessions open right now?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "No active remote sessions.",
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "End the remote session rs_abc123." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Remote session rs_abc123 revoked.",
          action: ACTION_NAME,
        },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state,
    _options,
  ): Promise<ActionResult> => {
    // TODO(remote-desktop migration): replace this stub with the full handler
    // from `plugins/plugin-personal-assistant/src/actions/remote-desktop.ts`.
    //
    // The real handler dispatches on the resolved subaction:
    //
    //   const resolved = await resolveActionArgs<RemoteDesktopSubaction, RemoteDesktopActionParams>({
    //     runtime: _runtime,
    //     message: _message,
    //     state: _state,
    //     options: _options,
    //     actionName: ACTION_NAME,
    //     subactions: SUBACTIONS,
    //   });
    //   if (!resolved.ok) return { success: false, ... };
    //   switch (resolved.subaction) {
    //     case "start":  return handleStart(_runtime, _message, resolved.params);
    //     case "status": return handleStatus(resolved.params);
    //     case "end":    return handleEnd(resolved.params);
    //     case "list":   return handleList();
    //     case "revoke": return handleRevoke(resolved.params);
    //   }
    //
    // Until the migration lands, this stub returns a structured
    // not-implemented result so callers see a clear signal.
    return {
      text: "REMOTE_DESKTOP is being migrated from @elizaos/plugin-personal-assistant to @elizaos/plugin-remote-desktop. The handler is not yet wired up in this plugin.",
      success: false,
      values: {
        success: false,
        error: "NOT_IMPLEMENTED_MIGRATION_PENDING",
      },
      data: {
        actionName: ACTION_NAME,
        reason: "migration_in_progress",
        canonicalLocation: "plugins/plugin-personal-assistant/src/actions/remote-desktop.ts",
      },
    };
  },
};

// Re-exported for callers that want to reach for the action name as a const.
export const REMOTE_DESKTOP_ACTION_NAME = ACTION_NAME;

// Re-export the action's parameter types so plugin consumers can type-check
// the params they pass when invoking the action programmatically.
export type { RemoteDesktopActionParams, RemoteDesktopSubaction };
