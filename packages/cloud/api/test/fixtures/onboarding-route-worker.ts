/**
 * Mounts the production onboarding route and coordinator in one Worker so
 * Miniflare can exercise the real public-to-Durable-Object transport path.
 */

import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import onboardingRoute from "../../eliza-app/onboarding/chat/route";
import { OnboardingSessionCoordinator as Coordinator } from "../../src/onboarding-session-coordinator";

/** Seed historical session bytes, then dispatch to the production coordinator. */
export class OnboardingSessionCoordinator extends Coordinator {
  constructor(
    private readonly fixtureState: DurableObjectState,
    env: ConstructorParameters<typeof Coordinator>[1],
  ) {
    super(fixtureState, env);
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/fixture/session") {
      return super.fetch(request);
    }
    const session = (await request.json()) as {
      id: string;
      userId?: string;
      organizationId?: string;
    };
    const storage = this.fixtureState.storage;
    const platform = `platform:${encodeURIComponent(session.id)}`;
    if (session.userId && session.organizationId) {
      const account = `account:${encodeURIComponent(session.organizationId)}:${encodeURIComponent(session.userId)}`;
      await storage.put({
        [`session:${account}`]: session,
        [`session:${platform}`]: { aliasScope: account },
      });
    } else {
      await storage.put(`session:${platform}`, session);
    }
    return Response.json({ seeded: true });
  }
}

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
