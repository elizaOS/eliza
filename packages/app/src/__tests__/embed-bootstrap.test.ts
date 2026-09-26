import { expect, it, vi } from "vitest";
import { runEmbedHandshake } from "../embed-bootstrap";

it.each([null, [], {}, { token: "fixture" }])(
  "rejects malformed successful payload %j without installing credentials",
  async (body) => {
    const client = {
      getBaseUrl: () => "https://agent.example.test",
      setToken: vi.fn(),
    };
    const outcome = await runEmbedHandshake({
      win: {
        location: {
          pathname: "/embed",
          search: "?platform=discord&code=fixture&state=fixture",
        },
      } as Window,
      client,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify(body)),
      ) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("failed");
    expect(client.setToken).not.toHaveBeenCalled();
  },
);
