/**
 * Dependency-bounded Hono shell for gateway authentication and managed
 * Discord turns.
 *
 * The Railway gateway already owns provider ingress and retries. This shell
 * preserves the Cloud request context, security headers, and internal JWT
 * boundary without evaluating the generated application router before every
 * ordinary channel message.
 */

import gatewayToken from "../internal/auth/token/route";
import managedDiscordMessages from "../internal/discord/eliza-app/messages/route";
import pendingDiscordGreetings from "../internal/discord/eliza-app/pending-greetings/route";
import { createInternalGatewayApp } from "./internal-gateway-app";

export function createDiscordGatewayApp() {
  const app = createInternalGatewayApp({
    name: "DiscordGatewayApp",
    idempotencyKey: (headers) =>
      headers.get("idempotency-key") ??
      headers.get("x-request-id") ??
      crypto.randomUUID(),
  });

  app.route("/api/internal/auth/token", gatewayToken);
  app.route("/api/internal/discord/eliza-app/messages", managedDiscordMessages);
  app.route(
    "/api/internal/discord/eliza-app/pending-greetings",
    pendingDiscordGreetings,
  );
  return app;
}
