import { createServer } from "node:http";
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
  it.each([
    ["OPENAI_BASE_URL", "http://127.0.0.1:41001/v1/"],
    ["ANTHROPIC_BASE_URL", "http://127.0.0.1:41002/v1"],
  ])(
    "refuses a selected live provider whose %s still names its mock",
    (key, base) => {
      const env = { [key]: "https://gateway.example/v1" };
      expect(() =>
        restoreLlmBaseUrlsForLiveProvider(
          { name: "openai", env: { [key]: base } },
          {},
          [world.settings],
          env,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "SCENARIO_LIVE_MOCK_ENDPOINT" }),
      );
      expect(env[key]).toBe("https://gateway.example/v1");
    },
  );
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

  it("redirects a Twilio Request over real loopback HTTP and restores ownership", async () => {
    const requests: Array<{
      path: string;
      body: string;
      authorization: string | undefined;
    }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests.push({
          path: request.url ?? "",
          body,
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"sid":"fixture-message"}');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Expected TCP listener");
    const base = `http://127.0.0.1:${address.port}`;
    // A broken redirect must fail locally rather than contact Twilio.
    const guardedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).origin !== base)
        throw Error("Unexpected external request");
      return realFetch(input, init);
    }) as typeof fetch;
    globalThis.fetch = guardedFetch;
    const restore = redirectTwilioFetch(base);
    try {
      const response = await fetch(
        new Request(
          "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json",
          {
            method: "POST",
            headers: {
              authorization: "Basic fixture",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: "To=%2B15555550100&Body=fixture",
          },
        ),
      );
      expect(await response.json()).toEqual({ sid: "fixture-message" });
      expect(requests).toEqual([
        {
          path: "/2010-04-01/Accounts/AC1/Messages.json",
          body: "To=%2B15555550100&Body=fixture",
          authorization: "Basic fixture",
        },
      ]);
      restore();
      expect(globalThis.fetch).toBe(guardedFetch);
    } finally {
      restore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
