/** Host one agent-server identity; the process retains its authorization boundary. */
import { Container, getContainer } from "@cloudflare/containers";
import { runtimeSettings } from "./configuration";

interface Env {
  SERVER: DurableObjectNamespace<AgentServerContainer>;
  DEPLOYMENT_ENV: string;
  AGENT_SERVER_ENABLED: string;
  AGENT_SERVER_RUNTIME_CONFIG?: string;
}

export class AgentServerContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "30m";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = runtimeSettings(
      env.AGENT_SERVER_RUNTIME_CONFIG,
      env.DEPLOYMENT_ENV,
    );
  }
}

async function stopInactiveServer(env: Env): Promise<void> {
  if (env.AGENT_SERVER_RUNTIME_CONFIG) {
    await getContainer(env.SERVER, "server").stop();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.AGENT_SERVER_ENABLED !== "true") {
      await stopInactiveServer(env);
      return new Response("Agent-server deployment inactive", { status: 503 });
    }
    // Preserve cancellation, streaming bodies, and the server's trusted headers.
    return getContainer(env.SERVER, "server").fetch(request);
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.AGENT_SERVER_ENABLED !== "true") {
      await stopInactiveServer(env);
      return;
    }
    const response = await getContainer(env.SERVER, "server").fetch(
      "http://agent-server/health",
    );
    if (!response.ok) {
      throw new Error(`Agent-server health check failed (${response.status})`);
    }
    await response.body?.cancel();
  },
};
