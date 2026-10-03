/** Serves registration-bound app identity and Google delegation through the canonical user consent owner. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { appsRepository } from "@/db/repositories/apps";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { readAppClientBasicAuthorization } from "@/lib/auth/app-delegation-auth";
import { checkCookieMutationGuard } from "@/lib/auth/cookie-mutation-guard";
import { requireUser } from "@/lib/auth/workers-hono-auth";
import {
  initiateManagedGoogleConnection,
  listManagedGoogleConnectorAccounts,
} from "@/lib/services/agent-google-connector";
import {
  AgentGoogleConnectorError,
  googleFetch,
} from "@/lib/services/agent-google-connector/shared";
import {
  AppDelegationError,
  type AppDelegationService,
  appDelegationBindingSchema,
} from "@/lib/services/app-delegation";
import { appDelegationService } from "@/lib/services/app-delegation-adapter";
import {
  type AppGoogleCapability,
  validateAppGoogleRequest,
} from "@/lib/services/app-delegation-google";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const googleCapabilities = z.enum([
  "google.basic_identity",
  "google.gmail.triage",
  "google.gmail.send",
  "google.calendar.read",
  "google.calendar.write",
]);
const googleInput = z
  .object({
    connectionId: z.string().uuid(),
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
    url: z.string().max(8192),
    body: z.string().max(1_500_000).optional(),
  })
  .strict();
const connectInput = z
  .object({
    redirectUri: z.string().url(),
    capabilities: z
      .array(googleCapabilities)
      .min(1)
      .refine(
        (caps) =>
          caps.includes("google.basic_identity") &&
          new Set(caps).size === caps.length,
      ),
  })
  .strict();
const tokenInput = z
  .object({
    code: z.string().startsWith("eac_").max(256),
    redirectUri: z.string().url(),
  })
  .strict();

export function appDelegationErrorResponse(error: Error, c: AppContext) {
  // error-policy:J1 translate typed domain and input failures at the HTTP boundary.
  if (error instanceof AppDelegationError)
    return c.json(
      { success: false, error: error.message, code: error.code },
      error.status,
    );
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json({ success: false, error: "Request validation failed" }, 400);
  if (error instanceof AgentGoogleConnectorError)
    return c.json(
      { success: false, error: error.message },
      error.status === 401
        ? 401
        : error.status === 403
          ? 403
          : error.status === 404
            ? 404
            : 502,
    );
  return failureResponse(c, error);
}

const googleProvider = {
  list: listManagedGoogleConnectorAccounts,
  connect: initiateManagedGoogleConnection,
  fetch: googleFetch,
};

/** Outbound Google is the only injectable provider in the app consent handler owner. */
export function createAppDelegationHandlers(
  service: AppDelegationService,
  google = googleProvider,
) {
  const actor = async (
    c: AppContext,
    scope: Parameters<AppDelegationService["authorize"]>[3],
  ) => {
    const client = readAppClientBasicAuthorization(
      c.req.header("Authorization"),
    );
    return service.authorize(
      client.clientId,
      client.secret,
      c.req.header("X-App-Delegation") ?? "",
      scope,
    );
  };
  const googleActor = async (c: AppContext, scope: AppGoogleCapability) => {
    const result = await actor(c, scope);
    if (!result.user.organizationId)
      throw new AppDelegationError(
        403,
        "APP_GOOGLE_ACCOUNT_REQUIRED",
        "Finish free account setup before connecting Google",
      );
    return { ...result, organizationId: result.user.organizationId };
  };

  return {
    consent: async (c: AppContext) => {
      const guard = checkCookieMutationGuard(
        c.req,
        c.env.ENVIRONMENT,
        c.env.NODE_ENV === "production",
      );
      if (!guard.ok)
        return c.json(
          { success: false, error: "Forbidden", code: guard.code },
          403,
        );
      const user = await requireUser(c);
      if (
        c.get("authMethod") !== "session" ||
        user.is_anonymous ||
        c.req.header("X-API-Key")
      )
        throw new AppDelegationError(
          401,
          "APP_SESSION_REQUIRED",
          "Sign in to revoke application consent",
        );
      await appsRepository.disconnectUser(
        z.string().uuid().parse(c.req.query("appId")),
        user.id,
      );
      return c.json({ success: true });
    },
    registration: async (c: AppContext) => {
      const appId = z.string().uuid().parse(c.req.query("appId"));
      const binding = appDelegationBindingSchema.parse({
        clientId: c.req.query("clientId"),
        redirectUri: c.req.query("redirectUri"),
        scopes: c.req.query("scopes")?.split(" "),
      });
      const registration = await service.validateConsent(appId, binding);
      return c.json({
        success: true,
        app: { id: registration.appId, name: registration.appName },
        billingEnvironment: registration.billingEnvironment,
        scopes: binding.scopes,
      });
    },
    token: async (c: AppContext) => {
      const client = readAppClientBasicAuthorization(
        c.req.header("Authorization"),
      );
      const input = tokenInput.parse(await c.req.json());
      return c.json({
        success: true,
        data: await service.exchange(
          client.clientId,
          client.secret,
          input.code,
          input.redirectUri,
        ),
      });
    },
    identity: async (c: AppContext) =>
      c.json({ success: true, data: (await actor(c, "identity")).user }),
    revoke: async (c: AppContext) => {
      const client = readAppClientBasicAuthorization(
        c.req.header("Authorization"),
      );
      await service.revoke(
        client.clientId,
        client.secret,
        c.req.header("X-App-Delegation") ?? "",
      );
      return c.json({ success: true });
    },
    googleConnections: async (c: AppContext) => {
      const current = await googleActor(c, "google.basic_identity");
      const connections = await google.list({
        organizationId: current.organizationId,
        userId: current.user.id,
        side: "owner",
      });
      return c.json({
        success: true,
        data: connections.map((connection) => ({
          connectionId: connection.connectionId,
          connected: connection.connected,
          identity: connection.identity,
          reason: connection.reason,
          grantedCapabilities: connection.grantedCapabilities.filter(
            (capability) =>
              current.scopes.some((scope) => scope === capability),
          ),
        })),
      });
    },
    googleConnect: async (c: AppContext) => {
      const input = connectInput.parse(await c.req.json());
      const current = await googleActor(c, "google.basic_identity");
      await service.validateConsent(current.registration.appId, {
        clientId: current.registration.id,
        redirectUri: input.redirectUri,
        scopes: ["identity", ...input.capabilities],
      });
      if (
        input.capabilities.some(
          (capability) => !current.scopes.includes(capability),
        )
      )
        throw new AppDelegationError(
          403,
          "APP_SCOPE_DENIED",
          "Authorize the requested Google capabilities before connecting",
        );
      return c.json({
        success: true,
        data: await google.connect({
          organizationId: current.organizationId,
          userId: current.user.id,
          side: "owner",
          redirectUrl: input.redirectUri,
          capabilities: input.capabilities,
        }),
      });
    },
    googleRequest: async (c: AppContext) => {
      const input = googleInput.parse(await c.req.json());
      const operation = validateAppGoogleRequest(input);
      const current = await googleActor(c, operation.capability);
      const connections = await google.list({
        organizationId: current.organizationId,
        userId: current.user.id,
        side: "owner",
      });
      const connection = connections.find(
        (candidate) =>
          candidate.connectionId === input.connectionId && candidate.connected,
      );
      if (!connection?.grantedCapabilities.includes(operation.capability))
        throw new AppDelegationError(
          403,
          "APP_GOOGLE_CONNECTION_DENIED",
          "Connect the selected Google account with the required capability",
        );
      const response = await google.fetch({
        organizationId: current.organizationId,
        userId: current.user.id,
        side: "owner",
        grantId: input.connectionId,
        url: operation.url,
        options: {
          method: operation.method,
          headers: { "Content-Type": "application/json" },
          ...(operation.body !== undefined ? { body: operation.body } : {}),
        },
      });
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    },
  };
}

export function appDelegationBoundary(app: Hono<AppEnv>) {
  app.use("*", bodyLimit({ maxSize: 1_600_000 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });
  app.onError(appDelegationErrorResponse);
}

export const appDelegationHandlers =
  createAppDelegationHandlers(appDelegationService);

/** Integration harness mounts the same handlers and boundary as the canonical route files. */
export function createAppDelegationRoutes(
  service: AppDelegationService,
  google = googleProvider,
) {
  const app = new Hono<AppEnv>();
  appDelegationBoundary(app);
  const handlers = createAppDelegationHandlers(service, google);
  app.delete("/consent", handlers.consent);
  app.get("/registration", handlers.registration);
  app.post("/token", handlers.token);
  app.get("/identity", handlers.identity);
  app.post("/revoke", handlers.revoke);
  app.get("/google/connections", handlers.googleConnections);
  app.post("/google/connect", handlers.googleConnect);
  app.post("/google/request", handlers.googleRequest);
  return app;
}
