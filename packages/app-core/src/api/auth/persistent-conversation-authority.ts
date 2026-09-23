/**
 * Composes persistent session authentication with live conversation membership
 * and carries the same verified actor into the agent host bridge. The embedding
 * host still owns method admission, streaming delivery and transport lifecycle.
 */
import type { IncomingMessage } from "node:http";
import {
  bindRequiredHttpAccessContext,
  revokeRequiredHttpAccessContext,
} from "@elizaos/agent/api/http-access-context";
import type {
  AgentHttpRequestAuthorization,
  AgentHttpRequestAuthorizationOptions,
} from "@elizaos/agent/runtime/host-bridge";
import { type AgentRuntime, ElizaError } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/shared";
import { authStoreForRuntime } from "../../services/auth-store";
import { createConversationSessionScope } from "./conversation-session-scope";
import {
  createPersistentSessionAdmission,
  type PersistentSessionActor,
} from "./persistent-session-admission";

export function createPersistentConversationAuthority(input: {
  runtime: AgentRuntime;
  config: ElizaConfig;
  allowedOrigins: readonly string[];
}) {
  const runtime = input.runtime;
  const store = authStoreForRuntime(runtime);
  if (!store) {
    throw new ElizaError(
      "Conversation authority requires agent-owned authentication storage",
      {
        code: "CONVERSATION_AUTH_STORE_REQUIRED",
      },
    );
  }
  const sessions = createPersistentSessionAdmission({
    store,
    allowedOrigins: input.allowedOrigins,
  });
  const scopeFor = createConversationSessionScope(input);
  const admitted = new WeakMap<
    IncomingMessage,
    Readonly<PersistentSessionActor>
  >();
  let active = true;

  function deny(request: IncomingMessage): false {
    admitted.delete(request);
    revokeRequiredHttpAccessContext(request);
    return false;
  }

  async function admit(request: IncomingMessage): Promise<boolean> {
    admitted.delete(request);
    if (!active) return deny(request);
    try {
      const actor = await sessions.capture(request);
      if (!actor) return deny(request);
      const scope = await scopeFor(actor);
      // Scope lookup can yield to another transaction. Do not publish an actor
      // whose session was revoked while its memberships were being read.
      if (!active || (await sessions.revalidate(request)) !== actor)
        return deny(request);
      bindRequiredHttpAccessContext(request, scope);
      admitted.set(request, actor);
      return true;
    } catch (cause) {
      // error-policy:J2 Remove all fallback authority before propagating a lookup failure.
      deny(request);
      throw new ElizaError("Persistent conversation authority unavailable", {
        code: "CONVERSATION_AUTHORITY_UNAVAILABLE",
        cause,
      });
    }
  }

  function resolveHttpRequestAuthorization(
    request: IncomingMessage,
    requestRuntime: AgentRuntime | null,
    options: AgentHttpRequestAuthorizationOptions,
  ): AgentHttpRequestAuthorization {
    const actor = admitted.get(request);
    if (
      !active ||
      requestRuntime !== runtime ||
      !actor ||
      (actor.source === "cookie" && !options.allowCookieAuth) ||
      (actor.source === "bearer-session" && options.allowBearerAuth === false)
    )
      return { ok: false, role: "NONE" };
    return {
      ok: true,
      identityId: actor.identityId,
      role: actor.identityKind === "owner" ? "OWNER" : "USER",
    };
  }

  return Object.freeze({
    admit,
    resolveHttpRequestAuthorization,
    revoke: () => {
      active = false;
    },
  });
}
