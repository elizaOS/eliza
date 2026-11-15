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
    const path = new URL(request.url).pathname;
    if (path === "/fixture/replay-cursor") {
      await this.fixtureState.storage.put("replay-cleanup-state", {
        startAfter: "replay:zzzz",
      });
      await this.fixtureState.storage.setAlarm(Date.now() + 60_000);
      return Response.json({ seeded: true });
    }
    if (path === "/fixture/alarm") {
      await super.alarm();
      const replays = await this.fixtureState.storage.list<{
        expiresAt: number;
      }>({
        prefix: "replay:",
      });
      return Response.json({
        count: replays.size,
        expiry: [...replays.values()][0]?.expiresAt,
        alarm: await this.fixtureState.storage.getAlarm(),
      });
    }
    if (path !== "/fixture/session") return super.fetch(request);
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
    if (url.pathname === "/fixture/coordinator") {
      const { owner, path, body } = (await request.json()) as {
        owner: string;
        path: string;
        body: unknown;
      };
      const namespace = env.ONBOARDING_SESSIONS as DurableObjectNamespace;
      return namespace
        .getByName(owner)
        .fetch(`https://onboarding.internal/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
    }
    if (url.pathname === "/fixture/replay-case") {
      const namespace = env.ONBOARDING_SESSIONS as DurableObjectNamespace;
      const sessionId = "replay-fixture-browser";
      const stub = namespace.getByName(sessionId);
      const send = (path: string, body: unknown) =>
        stub.fetch(`https://onboarding.internal/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const seeded = await send("fixture/replay-cursor", {});
      if (!seeded.ok) return seeded;
      const turn = await send("turn", {
        sessionId,
        input: { idempotencyKey: "fresh" },
      });
      if (!turn.ok) return turn;
      return send("fixture/alarm", {});
    }
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
