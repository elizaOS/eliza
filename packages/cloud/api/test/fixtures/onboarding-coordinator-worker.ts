/**
 * Exposes the onboarding route and coordinator through real Durable Object
 * bindings so Miniflare can exercise workerd serialization and fail-closed
 * handling of untrusted coordinator responses.
 */

import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import route from "../../eliza-app/onboarding/chat/route";
import { OnboardingSessionCoordinator } from "../../src/onboarding-session-coordinator";

export { OnboardingSessionCoordinator };

interface TestEnv {
  ONBOARDING_SESSIONS: DurableObjectNamespace;
  MALFORMED_ONBOARDING_SESSIONS: DurableObjectNamespace;
}

const malformedResponses: Record<
  string,
  { body: string; contentType?: string }
> = {
  unreadable: { body: "not-json", contentType: "text/plain" },
  null: { body: "null" },
  array: { body: "[]" },
  "missing-error": {
    body: JSON.stringify({ code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID" }),
  },
  "non-string-error": {
    body: JSON.stringify({
      error: 7,
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    }),
  },
  "non-string-code": {
    body: JSON.stringify({ error: "refused", code: 7 }),
  },
  "empty-code": { body: JSON.stringify({ error: "refused", code: "" }) },
  typed: {
    body: JSON.stringify({
      error: "refused",
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
      context: { source: "malformed-test-control" },
    }),
  },
};

export class MalformedOnboardingCoordinator {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as { sessionId?: unknown };
    const mode =
      typeof body.sessionId === "string"
        ? body.sessionId.replace(/^malformed-/, "")
        : "missing";
    const response = malformedResponses[mode] ?? { body: "null" };
    return new Response(response.body, {
      status: 500,
      headers: {
        "content-type": response.contentType ?? "application/json",
      },
    });
  }
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const mode = new URL(request.url).pathname.slice(1) || "actual";
    const malformed = mode !== "actual";
    const bindings = {
      ...env,
      INTERNAL_SECRET: "internal-secret-for-test",
      ONBOARDING_SESSIONS: malformed
        ? env.MALFORMED_ONBOARDING_SESSIONS
        : env.ONBOARDING_SESSIONS,
    };
    const sessionId = malformed ? `malformed-${mode}` : "actual-confirm";
    return await runWithCloudBindingsAsync(
      bindings,
      async () =>
        await route.request(
          "/",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              platform: "web",
              confirmPlatformLink: true,
            }),
          },
          bindings,
        ),
    );
  },
};
