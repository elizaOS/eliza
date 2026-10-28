import {
  DISCORD_LEASE_DELETE,
  DISCORD_LEASE_EXPIRE,
} from "@elizaos/cloud-services-common/discord-coordination";
import { discordCoordinationStore } from "../../gateway-discord/src/cloudflare-coordination-store";
import { handleDiscordCoordination } from "./discord-coordination-state";

export { DiscordCoordinationState } from "./discord-coordination-state";

const config = {
  CLOUD_DISCORD_COORDINATION_BACKEND: "cloudflare",
  CLOUD_DISCORD_WELCOME_BACKEND: "cloudflare",
  CLOUD_GATEWAY_RECEIPTS_BACKEND: "cloudflare",
  DISCORD_COORDINATION_URL: "https://coord.test/internal/discord-coordination",
  DISCORD_COORDINATION_TOKEN: "test-only",
};
export default {
  async fetch(
    request: Request,
    env: { DISCORD_COORDINATION_STATE: DurableObjectNamespace },
  ) {
    const path = new URL(request.url).pathname;
    if (path === "/private")
      return env.DISCORD_COORDINATION_STATE.getByName(
        "discord-coordination-v1",
      ).fetch(request);
    const settings = {
      ...env,
      GATEWAY_KIND: path === "/wrong-kind" ? "webhook" : "discord",
      GATEWAY_RUNTIME_CONFIG: JSON.stringify(config),
    };
    if (path !== "/exercise")
      return handleDiscordCoordination(request, settings);
    const store = discordCoordinationStore(config, (url, init) =>
      handleDiscordCoordination(new Request(url, init), settings),
    );
    if (!store) throw new Error("Native coordinator not selected");
    const input = (await request.json()) as {
      action: string;
      key: string;
      value: string;
      members: string[];
      keys: string[];
      seconds: number;
      ex?: number;
      px?: number;
      nx?: boolean;
    };
    let result: unknown;
    switch (input.action) {
      case "get":
        result = await store.get(input.key);
        break;
      case "set":
        result = await store.set(input.key, input.value, {
          ex: input.ex,
          px: input.px,
          nx: input.nx,
        });
        break;
      case "setex":
        result = await store.setex(input.key, input.seconds, input.value);
        break;
      case "delete":
        result = await store.del(...input.keys);
        break;
      case "members":
        result = await store.smembers(input.key);
        break;
      case "addMembers":
        result = await store.sadd(input.key, ...input.members);
        break;
      case "removeMembers":
        result = await store.srem(input.key, ...input.members);
        break;
      case "expire":
        result = await store.expire(input.key, input.seconds);
        break;
      case "compareDelete":
        result = await store.eval(
          DISCORD_LEASE_DELETE,
          [input.key],
          [input.value],
        );
        break;
      case "compareExpire":
        result = await store.eval(
          DISCORD_LEASE_EXPIRE,
          [input.key],
          [input.value, input.seconds],
        );
        break;
      default:
        throw new Error("Unknown fixture operation");
    }
    return Response.json(result);
  },
};
