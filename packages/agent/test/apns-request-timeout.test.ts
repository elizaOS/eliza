/** A real local HTTP/2 server answers, stalls, and fails APNs-shaped requests. */
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type Http2Server,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  ApnsProvider,
  DEFAULT_APNS_REQUEST_TIMEOUT_MS,
} from "../src/services/push/apns-provider.ts";

/** The transport entry point under test, including its optional deadline. */
type PostHttp2 = (
  host: string,
  token: string,
  jwt: string,
  body: string,
  timeoutMs?: number,
) => Promise<{ status: number; reason?: string }>;

function configuredProvider(): ApnsProvider {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return new ApnsProvider({
    ELIZA_APNS_KEY: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    ELIZA_APNS_KEY_ID: "TESTKEYID",
    ELIZA_APNS_TEAM_ID: "TESTTEAMID",
    ELIZA_APNS_TOPIC: "com.eliza.test",
  });
}

function postHttp2(provider: ApnsProvider): PostHttp2 {
  // Reach the real transport method. Adding a production seam that only a test
  // would use costs more than one cast here.
  return (
    provider as unknown as { postHttp2: PostHttp2 }
  ).postHttp2.bind(provider);
}

interface LocalServer {
  host: string;
  /** Resolves when the client tears its session down. */
  sessionClosed: () => Promise<void>;
  /** Number of server-side sessions the client has torn down. */
  sessionsClosed: () => number;
  close: () => Promise<void>;
}

async function startServer(
  onStream: (stream: ServerHttp2Stream) => void,
): Promise<LocalServer> {
  const server: Http2Server = createServer();
  const sessions: ServerHttp2Session[] = [];
  let closed = 0;
  let notifyClose: (() => void) | undefined;
  const closedOnce = new Promise<void>((resolve) => {
    notifyClose = resolve;
  });
  server.on("session", (session) => {
    sessions.push(session);
    session.on("close", () => {
      closed += 1;
      notifyClose?.();
    });
  });
  server.on("stream", onStream);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return {
    host: `http://127.0.0.1:${address.port}`,
    sessionClosed: () => closedOnce,
    sessionsClosed: () => closed,
    close: async () => {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it("resolves the APNs status when the request ends normally", async () => {
  const server = await startServer((stream) => {
    stream.respond({ ":status": 200 });
    stream.end();
  });
  try {
    const result = await postHttp2(configuredProvider())(
      server.host,
      "device-token",
      "jwt",
      "{}",
    );
    expect(result).toEqual({ status: 200, reason: undefined });
  } finally {
    await server.close();
  }
});

it("rejects and tears the session down when the request never ends", async () => {
  const server = await startServer(() => {
    // APNs can hold a stream open with no response and no error.
  });
  try {
    const pending = postHttp2(configuredProvider())(
      server.host,
      "device-token",
      "jwt",
      "{}",
      60,
    );
    await expect(pending).rejects.toThrow(/timed out after 60 ms/);
    await server.sessionClosed();
    expect(server.sessionsClosed()).toBe(1);
  } finally {
    await server.close();
  }
});

it("keeps the timeout result when the stalled stream flushes after the deadline", async () => {
  let release: (() => void) | undefined;
  const server = await startServer((stream) => {
    release = () => {
      if (stream.destroyed) return;
      stream.respond({ ":status": 200 });
      stream.end();
    };
  });
  try {
    const pending = postHttp2(configuredProvider())(
      server.host,
      "device-token",
      "jwt",
      "{}",
      60,
    );
    await expect(pending).rejects.toThrow(/timed out after 60 ms/);
    // The late answer must not replace the timeout result.
    release?.();
    await delay(150);
    await expect(pending).rejects.toThrow(/timed out after 60 ms/);
  } finally {
    await server.close();
  }
});

it("drops the deadline when the request ends", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let server: LocalServer | undefined;
  try {
    server = await startServer((stream) => {
      stream.respond({ ":status": 200 });
      stream.end();
    });
    const before = vi.getTimerCount();
    const result = await postHttp2(configuredProvider())(
      server.host,
      "device-token",
      "jwt",
      "{}",
      DEFAULT_APNS_REQUEST_TIMEOUT_MS,
    );
    expect(result.status).toBe(200);
    expect(vi.getTimerCount()).toBe(before);
  } finally {
    vi.useRealTimers();
    await server?.close();
  }
});

it("drops the deadline when the request fails", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let server: LocalServer | undefined;
  try {
    server = await startServer((stream) => {
      // The reset lands as an `error` on the server stream too; swallow it so it
      // does not surface as an unhandled event.
      stream.on("error", () => {});
      stream.destroy(new Error("apns-reset"));
    });
    const before = vi.getTimerCount();
    const pending = postHttp2(configuredProvider())(
      server.host,
      "device-token",
      "jwt",
      "{}",
      DEFAULT_APNS_REQUEST_TIMEOUT_MS,
    );
    const error = await pending.then(
      () => null,
      (cause: unknown) => cause as Error,
    );
    // The stream failure settles the promise, not the deadline.
    expect(error?.message).not.toMatch(/timed out/);
    expect(vi.getTimerCount()).toBe(before);
  } finally {
    vi.useRealTimers();
    await server?.close();
  }
});
