/** Resolves free user sessions or app-scoped delegated actors without performing paid-entitlement admission. */
import type { AppDelegationScope } from "@elizaos/cloud-sdk/app-delegation";
import type { AppContext } from "../../types/cloud-worker-env";
import { AppDelegationError } from "../services/app-delegation";
import { appDelegationService } from "../services/app-delegation-adapter";
import { requireUser } from "./workers-hono-auth";

export function readAppClientBasicAuthorization(header: string | undefined): {
  clientId: string;
  secret: string;
} {
  if (!header?.startsWith("Basic "))
    throw new AppDelegationError(
      401,
      "APP_CLIENT_REQUIRED",
      "Use HTTP Basic authentication with the registered application client",
    );
  const encoded = header.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new AppDelegationError(
      401,
      "APP_CLIENT_INVALID",
      "Invalid application client authentication",
    );
  const text = Buffer.from(encoded, "base64").toString("utf8");
  const separator = text.indexOf(":");
  const clientId = text.slice(0, separator);
  if (
    separator < 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)
  )
    throw new AppDelegationError(
      401,
      "APP_CLIENT_INVALID",
      "Invalid application client authentication",
    );
  return { clientId, secret: text.slice(separator + 1) };
}

export interface AppActor {
  billingEnvironment: "test" | "live" | null;
  appId: string;
  userId: string;
  organizationId: string | null;
  clientId: string | null;
}

/** App identity only; the caller must authorize account membership and execution funding separately. */
export async function requireAppActor(
  c: AppContext,
  appId: string,
  scope: Extract<AppDelegationScope, "billing:read" | "billing:write" | "inference">,
): Promise<AppActor> {
  const authorization = c.req.header("Authorization");
  if (authorization?.startsWith("Basic ")) {
    const client = readAppClientBasicAuthorization(authorization);
    const actor = await appDelegationService.authorize(
      client.clientId,
      client.secret,
      c.req.header("X-App-Delegation") ?? "",
      scope,
    );
    if (actor.registration.appId !== appId)
      throw new AppDelegationError(
        403,
        "APP_SCOPE_DENIED",
        "The client is registered to another application",
      );
    return {
      appId,
      billingEnvironment: actor.registration.billingEnvironment,
      userId: actor.user.id,
      organizationId: actor.user.organizationId,
      clientId: client.clientId,
    };
  }
  const user = await requireUser(c);
  if (c.get("authMethod") !== "session" || user.is_anonymous)
    throw new AppDelegationError(401, "APP_SESSION_REQUIRED", "Sign in to use this application");
  return {
    billingEnvironment: null,
    appId,
    userId: user.id,
    organizationId: user.organization_id ?? null,
    clientId: null,
  };
}

/** Billing account membership remains owned by the billing use-case. */
export type AppBillingActor = AppActor;
export function requireAppBillingActor(
  c: AppContext,
  appId: string,
  scope: Extract<AppDelegationScope, "billing:read" | "billing:write">,
): Promise<AppBillingActor> {
  return requireAppActor(c, appId, scope);
}
