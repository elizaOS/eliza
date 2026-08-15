/**
 * Mounts the production onboarding route and coordinator in one Worker so
 * Miniflare can exercise the real public-to-Durable-Object transport path.
 */

import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import onboardingRoute from "../../eliza-app/onboarding/chat/route";
import { OnboardingSessionCoordinator } from "../../src/onboarding-session-coordinator";

export { OnboardingSessionCoordinator };

export default {
  async fetch(
    request: Request,
    env: Record<string, unknown>,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/eliza-app/onboarding/chat") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const routeRequest = new Request("https://onboarding.test/", request);
    return runWithCloudBindingsAsync(
      env,
      async () => await onboardingRoute.fetch(routeRequest, env as never),
    );
  },
};
