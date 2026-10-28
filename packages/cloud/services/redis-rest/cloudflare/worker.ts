import { Container, getContainer } from "@cloudflare/containers";
import {
  type BridgeSettings,
  containerSettings,
  forwardBridgeRequest,
} from "./bridge";

interface Env extends BridgeSettings {
  BRIDGE: DurableObjectNamespace<RedisHttpBridge>;
}

/** Stateless transport; authoritative data remains in the configured Redis. */
export class RedisHttpBridge extends Container<Env> {
  defaultPort = 80;
  sleepAfter = "10m";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = containerSettings(env);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return forwardBridgeRequest(request, env.SRH_TOKEN, (authenticated) =>
      getContainer(env.BRIDGE, "redis-http").fetch(authenticated),
    );
  },
};
