/** Exercises shared gateway forwarding against real loopback HTTP servers, including fallback and non-replay timeouts. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  executeGatewayForwardAttempts,
  postGatewayTarget,
} from "../src/gateway-forward";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

function listen(
  handler: (request: Request) => Response | Promise<Response>,
): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server.url.origin;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("gateway forwarding", () => {
  test("reaches the fallback over HTTP with the same authenticated complete payload", async () => {
    const received: Array<{
      body: string;
      token: string | null;
      host: string | null;
    }> = [];
    const handler = (status: number) => async (request: Request) => {
      received.push({
        body: await request.text(),
        token: request.headers.get("x-server-token"),
        host: request.headers.get("x-forwarded-host"),
      });
      return new Response(
        status === 200 ? "complete upstream result" : "primary unavailable",
        { status },
      );
    };
    const targets = [listen(handler(503)), listen(handler(200))];
    let refreshes = 0;
    let wakes = 0;
    const body = JSON.stringify({
      text: "preserve complete message",
      platformRecordId: "record-1",
    });
    const result = await executeGatewayForwardAttempts({
      attempts: 2,
      baseDelayMs: 0,
      incrementMs: 0,
      getTargets: async () => targets,
      refreshTargets: async () => {
        refreshes += 1;
      },
      wake: () => {
        wakes += 1;
      },
      tryTarget: (target) =>
        postGatewayTarget({
          target,
          endpointPath: "/agents/agent-1/message",
          body,
          timeoutMs: 1_000,
          sharedSecret: "loopback-token",
          forwardedHost: "agent.example",
          timeoutIsConnectionError: false,
          readResponse: (response) => response.text(),
        }),
      retryOnTimeout: false,
      exhaustedError: new Error("No gateway response"),
    });
    expect(result).toBe("complete upstream result");
    expect(received).toEqual([
      { body, token: "loopback-token", host: "agent.example" },
      { body, token: "loopback-token", host: "agent.example" },
    ]);
    expect(refreshes).toBe(1);
    expect(wakes).toBe(0);
  });

  test("wakes only once while discovery is empty and forwards when the pod appears", async () => {
    let requests = 0;
    const target = listen(() => {
      requests += 1;
      return new Response("ready");
    });
    let discoveries = 0;
    let wakes = 0;
    const delays: number[] = [];
    const result = await executeGatewayForwardAttempts({
      attempts: 3,
      baseDelayMs: 2,
      incrementMs: 1,
      getTargets: async () => (++discoveries < 3 ? [] : [target]),
      refreshTargets: async () => undefined,
      wake: () => {
        wakes += 1;
      },
      tryTarget: (nextTarget) =>
        postGatewayTarget({
          target: nextTarget,
          endpointPath: "/agents/agent-1/message",
          body: "{}",
          timeoutMs: 1_000,
          timeoutIsConnectionError: false,
          readResponse: (response) => response.text(),
        }),
      retryOnTimeout: false,
      sleep: async (delay) => {
        delays.push(delay);
      },
      exhaustedError: new Error("No gateway response"),
    });
    expect(result).toBe("ready");
    expect(requests).toBe(1);
    expect(wakes).toBe(1);
    expect(delays).toEqual([3, 4]);
  });

  test("does not send another message after an ambiguous response timeout", async () => {
    let requests = 0;
    const target = listen(async () => {
      requests += 1;
      await Bun.sleep(50);
      return new Response("too late");
    });
    const timeoutError = new Error("Message response deadline expired");
    let alternateCalls = 0;
    let wakes = 0;
    await expect(
      executeGatewayForwardAttempts({
        attempts: 3,
        baseDelayMs: 0,
        incrementMs: 0,
        getTargets: async () => [target, target],
        refreshTargets: async () => undefined,
        wake: () => {
          wakes += 1;
        },
        tryTarget: (nextTarget) =>
          postGatewayTarget({
            target: nextTarget,
            endpointPath: "/agents/agent-1/message",
            body: "{}",
            timeoutMs: 10,
            timeoutError,
            timeoutIsConnectionError: false,
            readResponse: (response) => response.text(),
          }),
        afterPrimaryFailure: async () => {
          alternateCalls += 1;
          return null;
        },
        retryOnTimeout: false,
        exhaustedError: new Error("No gateway response"),
      }),
    ).rejects.toBe(timeoutError);
    expect(requests).toBe(1);
    expect(alternateCalls).toBe(0);
    expect(wakes).toBe(0);
  });
});
