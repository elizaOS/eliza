import { afterEach, describe, expect, it } from "vitest";
import { redirectTwilioFetch } from "../../scripts/mocks/start-mocks.ts";
import { restoreLlmBaseUrlsForLiveProvider } from "./runtime-factory.ts";
import {
  parseSyntheticWorldConfiguration,
  withoutLlmMockBaseUrls,
} from "./synthetic-world-settings.ts";

const world = parseSyntheticWorldConfiguration(
  JSON.stringify({
    openai: "http://127.0.0.1:41001/",
    anthropic: "http://127.0.0.1:41002/",
    twilio: "http://127.0.0.1:41003/",
  }),
);
const live = { name: "anthropic", env: { ANTHROPIC_API_KEY: "k" } } as const;

describe("live provider isolation from LLM mocks", () => {
  it("keeps the world's mock LLM base URLs out of a live runtime's settings", () => {
    expect(world.settings.OPENAI_BASE_URL).toContain("127.0.0.1:41001");
    const settings = withoutLlmMockBaseUrls(world.settings);
    expect(settings.OPENAI_BASE_URL).toBeUndefined();
    expect(settings.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(settings.ELIZA_SYNTHETIC_WORLD_LEASED).toBe("1");
  });

  it("restores the process's own base URL, drops a mock one, and lets the provider win", () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_BASE_URL: world.settings.OPENAI_BASE_URL,
      ANTHROPIC_BASE_URL: world.settings.ANTHROPIC_BASE_URL,
    };
    restoreLlmBaseUrlsForLiveProvider(
      live,
      {
        OPENAI_BASE_URL: "https://gateway.example/v1",
        ANTHROPIC_BASE_URL: world.settings.ANTHROPIC_BASE_URL,
      },
      [world.settings],
      env,
    );
    expect(env.OPENAI_BASE_URL).toBe("https://gateway.example/v1");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();

    restoreLlmBaseUrlsForLiveProvider(
      {
        name: "openai",
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      },
      {},
      [world.settings],
      env,
    );
    expect(env.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });

  it("leaves the deterministic lane on the mocks", () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_BASE_URL: world.settings.OPENAI_BASE_URL,
    };
    restoreLlmBaseUrlsForLiveProvider(
      { name: "deterministic-model-provider", env: {} },
      {},
      [world.settings],
      env,
    );
    expect(env.OPENAI_BASE_URL).toBe(world.settings.OPENAI_BASE_URL);
  });
});

describe("redirectTwilioFetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("never lets a Twilio call reach api.twilio.com and restores fetch", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return new Response("{}");
    }) as typeof fetch;
    const stub = globalThis.fetch;
    const restore = redirectTwilioFetch(world.endpoints.twilio);
    await fetch(
      "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json",
      { method: "POST" },
    );
    await fetch(
      new Request("https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json"),
    );
    await fetch("https://example.com/other");
    restore();
    expect(globalThis.fetch).toBe(stub);
    expect(seen).toEqual([
      "http://127.0.0.1:41003/2010-04-01/Accounts/AC1/Messages.json",
      "http://127.0.0.1:41003/2010-04-01/Accounts/AC1/Calls.json",
      "https://example.com/other",
    ]);
  });
});
