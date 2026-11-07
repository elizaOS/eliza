import {
  DISCORD_WELCOME_PENDING,
  DISCORD_WELCOME_PROCESSING,
} from "@elizaos/cloud-services-common/discord-welcome-state";
import { discordWelcomeStore } from "../../gateway-discord/src/cloudflare-welcome-store";
import {
  type DiscordInstallWelcomeJob,
  DiscordInstallWelcomeQueue,
  type DiscordInstallWelcomeRedis,
} from "../../gateway-discord/src/discord-install-welcome-queue";
import { handleDiscordWelcome } from "./discord-welcome-state";

export { DiscordWelcomeState } from "./discord-welcome-state";

const messages: Array<Record<string, unknown>> = [];
export default {
  async fetch(
    request: Request,
    env: { DISCORD_WELCOME_STATE: DurableObjectNamespace },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/private")
      return env.DISCORD_WELCOME_STATE.getByName("discord-welcome-v1").fetch(
        request,
      );
    const settings = {
      ...env,
      GATEWAY_KIND: "discord",
      GATEWAY_RUNTIME_CONFIG: JSON.stringify({
        CLOUD_DISCORD_WELCOME_BACKEND: "cloudflare",
        DISCORD_WELCOME_TOKEN: "test-only",
      }),
    };
    if (url.pathname === "/internal/discord-welcome")
      return handleDiscordWelcome(request, settings);
    const input = (await request.json()) as {
      action: string;
      job: DiscordInstallWelcomeJob;
      key: string;
    };
    const redis = new Proxy({} as DiscordInstallWelcomeRedis, {
      get: () => () => {
        throw new Error("Unexpected Redis fallback");
      },
    });
    const store = discordWelcomeStore(
      redis,
      {
        CLOUD_DISCORD_WELCOME_BACKEND: "cloudflare",
        DISCORD_WELCOME_URL: "https://welcome.test/internal/discord-welcome",
        DISCORD_WELCOME_TOKEN: "test-only",
      },
      (address, init) =>
        handleDiscordWelcome(new Request(address, init), settings),
    );
    const fakeProvider = Object.assign(
      async (
        address: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        if (typeof init?.body !== "string")
          throw new Error("Expected provider JSON");
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (String(address).endsWith("/users/@me/channels"))
          return Response.json({ id: `fixture-${body.recipient_id}` });
        if (!String(address).includes("/channels/fixture-"))
          throw new Error("Unexpected provider route");
        messages.push(body);
        return Response.json({ id: `fixture-message-${messages.length}` });
      },
      { preconnect: () => {} },
    );
    const queue = new DiscordInstallWelcomeQueue(
      store,
      "fixture-token",
      fakeProvider,
    );
    let result: unknown;
    if (input.action === "enqueue") {
      await queue.enqueue(input.job);
      result = true;
    } else if (input.action === "drain") result = await queue.drainOnce();
    else if (input.action === "claim")
      result = await store.lmove(
        DISCORD_WELCOME_PENDING,
        DISCORD_WELCOME_PROCESSING,
        "right",
        "left",
      );
    else if (input.action === "marker") result = await store.get(input.key);
    else return new Response("Invalid fixture action", { status: 400 });
    return Response.json({ result, messages });
  },
};
