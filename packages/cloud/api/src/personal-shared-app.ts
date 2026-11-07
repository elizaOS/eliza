/**
 * Dependency-bounded Hono shell for authenticated personal Shared turns.
 *
 * The Railway gateway already owns provider ingress and retries. This shell
 * preserves the Cloud request context, security headers, and internal JWT
 * boundary without evaluating the generated application router before every
 * ordinary channel message.
 */

import personalSharedMessages from "../internal/eliza-app/personal-shared/messages/route";
import { createInternalGatewayApp } from "./internal-gateway-app";

export function createPersonalSharedApp() {
  const app = createInternalGatewayApp({
    name: "PersonalSharedApp",
    idempotencyKey: (headers) =>
      headers.get("idempotency-key") ||
      headers.get("x-request-id") ||
      crypto.randomUUID(),
  });

  app.route(
    "/api/internal/eliza-app/personal-shared/messages",
    personalSharedMessages,
  );
  return app;
}
