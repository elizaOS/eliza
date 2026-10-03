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

function embedWin(search = "?platform=discord&code=fixture&state=fixture") {
  return { location: { pathname: "/embed", search } } as Window;
}

it("logs a structured error when embed auth is rejected", async () => {
  const log = { error: vi.fn() };
  const outcome = await runEmbedHandshake({
    win: embedWin(),
    client: {
      getBaseUrl: () => "https://agent.example.test",
      setToken: vi.fn(),
    },
    fetchImpl: vi.fn(
      async () => new Response("expired", { status: 401 }),
    ) as unknown as typeof fetch,
    log,
  });
  expect(outcome).toEqual({ status: "failed", reason: "http_401" });
  expect(log.error).toHaveBeenCalledTimes(1);
  expect(log.error).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "http_401" }),
    expect.stringContaining("http_401"),
  );
});

it("keeps the underlying cause of a network failure in the logged outcome", async () => {
  const log = { error: vi.fn() };
  const outcome = await runEmbedHandshake({
    win: embedWin(),
    client: {
      getBaseUrl: () => "https://agent.example.test",
      setToken: vi.fn(),
    },
    fetchImpl: vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch,
    log,
  });
  expect(outcome).toEqual({
    status: "failed",
    reason: "network_error",
    detail: "Failed to fetch",
  });
  expect(log.error).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "network_error",
      detail: "Failed to fetch",
    }),
    expect.any(String),
  );
});

it("does not log off the embed route or after a successful handshake", async () => {
  const log = { error: vi.fn() };
  const client = {
    getBaseUrl: () => "https://agent.example.test",
    setToken: vi.fn(),
  };
  await runEmbedHandshake({
    win: { location: { pathname: "/", search: "" } } as Window,
    client,
    log,
  });
  const outcome = await runEmbedHandshake({
    win: embedWin(),
    client,
    fetchImpl: vi.fn(
      async () =>
        new Response(
          JSON.stringify({ token: "scoped", role: "OWNER", adminMode: false }),
        ),
    ) as unknown as typeof fetch,
    log,
  });
  expect(outcome.status).toBe("authenticated");
  expect(client.setToken).toHaveBeenCalledWith("scoped");
  expect(log.error).not.toHaveBeenCalled();
});
