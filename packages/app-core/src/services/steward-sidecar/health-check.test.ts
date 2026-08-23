/**
 * Exercises Steward sidecar `waitForHealthy` against a real loopback `/health`
 * server. Interval sleep is stubbed so retries stay in-process; fetch, JSON
 * parse, abort, and timeout branches run the production poller.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForHealthy } from "./health-check";
import { HEALTH_CHECK_INTERVAL_MS, HEALTH_CHECK_TIMEOUT_MS } from "./types";

const sleepMock = vi.hoisted(() => vi.fn(async (_ms: number) => undefined));

vi.mock("./helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers")>();
  return { ...actual, sleep: sleepMock };
});

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; apiBase: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("expected a TCP listen address");
  }
  return { server, apiBase: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

describe("waitForHealthy", () => {
  let server: Server | undefined;

  beforeEach(() => {
    sleepMock.mockReset();
    sleepMock.mockImplementation(async () => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServer(server);
    server = undefined;
  });

  it("resolves on the first 200 body with status ok and never sleeps", async () => {
    const paths: string[] = [];
    const started = await listen((req, res) => {
      paths.push(req.url ?? "");
      sendJson(res, 200, { status: "ok" });
    });
    server = started.server;

    await expect(
      waitForHealthy(started.apiBase, new AbortController()),
    ).resolves.toBeUndefined();

    expect(paths).toEqual(["/health"]);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("ignores extra JSON fields when status is ok", async () => {
    const started = await listen((_req, res) => {
      sendJson(res, 200, { status: "ok", pid: 12, extra: "ignored" });
    });
    server = started.server;

    await expect(
      waitForHealthy(started.apiBase, new AbortController()),
    ).resolves.toBeUndefined();
  });

  it("does not treat HTTP 503 as healthy even when the body says status ok", async () => {
    let polls = 0;
    const started = await listen((_req, res) => {
      polls += 1;
      if (polls === 1) {
        sendJson(res, 503, { status: "ok" });
        return;
      }
      sendJson(res, 200, { status: "ok" });
    });
    server = started.server;

    await waitForHealthy(started.apiBase, new AbortController());

    expect(polls).toBe(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(HEALTH_CHECK_INTERVAL_MS);
  });

  it("retries a 200 body whose status is not the exact string ok", async () => {
    let polls = 0;
    const started = await listen((_req, res) => {
      polls += 1;
      if (polls === 1) {
        sendJson(res, 200, { status: "OK" });
        return;
      }
      if (polls === 2) {
        sendJson(res, 200, { status: "starting" });
        return;
      }
      sendJson(res, 200, { status: "ok" });
    });
    server = started.server;

    await waitForHealthy(started.apiBase, new AbortController());

    expect(polls).toBe(3);
    expect(sleepMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 200 body with a missing status field", async () => {
    let polls = 0;
    const started = await listen((_req, res) => {
      polls += 1;
      if (polls === 1) {
        sendJson(res, 200, {});
        return;
      }
      sendJson(res, 200, { status: "ok" });
    });
    server = started.server;

    await waitForHealthy(started.apiBase, new AbortController());
    expect(polls).toBe(2);
  });

  it("retries when the 200 body is not JSON", async () => {
    let polls = 0;
    const started = await listen((_req, res) => {
      polls += 1;
      if (polls === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not-json");
        return;
      }
      sendJson(res, 200, { status: "ok" });
    });
    server = started.server;

    await waitForHealthy(started.apiBase, new AbortController());
    expect(polls).toBe(2);
  });

  it("retries a connection failure then succeeds once the port accepts", async () => {
    const placeholder = await listen((_req, res) => {
      sendJson(res, 200, { status: "ok" });
    });
    const addr = placeholder.server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("expected a TCP listen address");
    }
    const port = addr.port;
    await closeServer(placeholder.server);

    sleepMock.mockImplementation(async () => {
      if (server) {
        return;
      }
      const live = createServer((_req, res) => {
        sendJson(res, 200, { status: "ok" });
      });
      await new Promise<void>((resolve, reject) => {
        live.once("error", reject);
        live.listen(port, "127.0.0.1", () => resolve());
      });
      server = live;
    });

    await expect(
      waitForHealthy(`http://127.0.0.1:${port}`, new AbortController()),
    ).resolves.toBeUndefined();
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it("throws Health check aborted when the controller is already aborted", async () => {
    const started = await listen((_req, res) => {
      sendJson(res, 200, { status: "ok" });
    });
    server = started.server;
    const abort = new AbortController();
    abort.abort();

    await expect(waitForHealthy(started.apiBase, abort)).rejects.toThrow(
      "Health check aborted",
    );
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("throws Health check aborted on the next loop after a failed poll", async () => {
    const abort = new AbortController();
    const started = await listen((_req, res) => {
      sendJson(res, 503, { error: "not ready" });
    });
    server = started.server;

    sleepMock.mockImplementation(async () => {
      abort.abort();
    });

    await expect(waitForHealthy(started.apiBase, abort)).rejects.toThrow(
      "Health check aborted",
    );
    expect(sleepMock).toHaveBeenCalledWith(HEALTH_CHECK_INTERVAL_MS);
  });

  it("throws after HEALTH_CHECK_TIMEOUT_MS of unsuccessful polls", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    sleepMock.mockImplementation(async (ms: number) => {
      now += ms;
    });

    const started = await listen((_req, res) => {
      sendJson(res, 503, { status: "starting" });
    });
    server = started.server;

    await expect(
      waitForHealthy(started.apiBase, new AbortController()),
    ).rejects.toThrow(
      `Steward failed to become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms`,
    );

    expect(now).toBeGreaterThanOrEqual(HEALTH_CHECK_TIMEOUT_MS);
    expect(sleepMock).toHaveBeenCalled();
    expect(
      sleepMock.mock.calls.every(
        (call) => call[0] === HEALTH_CHECK_INTERVAL_MS,
      ),
    ).toBe(true);
  });
});
