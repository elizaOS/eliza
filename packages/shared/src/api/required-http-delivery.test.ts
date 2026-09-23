/**
 * Exercises protected frame ordering, complete payloads, and fail-closed budget
 * handling over real Node HTTP sockets with a deterministic admission barrier.
 * Persistent-session authorization is covered by the app host's SQLite suite.
 */
import { createServer, get, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import {
  bindRequiredHttpDelivery,
  endRequiredHttpDelivery,
  type HttpDeliveryOutcome,
  queueRequiredHttpFrame,
} from "./required-http-delivery";

async function capture(
  handle: (response: ServerResponse) => Promise<HttpDeliveryOutcome>,
): Promise<{
  text: string;
  interrupted: boolean;
  outcome: HttpDeliveryOutcome;
}> {
  const completed = Promise.withResolvers<HttpDeliveryOutcome>();
  const server = createServer((_req, response) => {
    void handle(response).then(completed.resolve, completed.reject);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Listener unavailable");
    const received = await new Promise<{ text: string; interrupted: boolean }>(
      (resolve, reject) => {
        const chunks: Buffer[] = [];
        const request = get(`http://127.0.0.1:${address.port}/`, (response) => {
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () =>
            resolve({
              text: Buffer.concat(chunks).toString(),
              interrupted: false,
            }),
          );
          response.once("error", (error: NodeJS.ErrnoException) => {
            // error-policy:J1 Connection reset is an explicit interrupted response.
            if (error.code !== "ECONNRESET") {
              reject(error);
              return;
            }
            resolve({
              text: Buffer.concat(chunks).toString(),
              interrupted: true,
            });
          });
        });
        request.once("error", (error: NodeJS.ErrnoException) => {
          // error-policy:J1 Admission may abort before any response header is sent.
          if (error.code !== "ECONNRESET") {
            reject(error);
            return;
          }
          resolve({
            text: Buffer.concat(chunks).toString(),
            interrupted: true,
          });
        });
      },
    );
    return { ...received, outcome: await completed.promise };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("preserves complete large frames and finalization across asynchronous admission", async () => {
  const frame = `data: ${"private 😀 context ".repeat(12_000)}\n\n`;
  let observedBackpressure = false;
  const captured = await capture(async (response) => {
    const delivery = bindRequiredHttpDelivery(response, {
      maxPendingBytes: Buffer.byteLength(frame) * 2,
      deliver: async (dispatch) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        dispatch();
        observedBackpressure ||= response.writableNeedDrain;
        return true;
      },
    });
    queueRequiredHttpFrame(response, frame);
    queueRequiredHttpFrame(response, "data: final\n\n");
    endRequiredHttpDelivery(response);
    endRequiredHttpDelivery(response);
    return delivery.completed;
  });
  expect(captured).toEqual({
    text: `${frame}data: final\n\n`,
    interrupted: false,
    outcome: { kind: "complete" },
  });
  expect(observedBackpressure).toBe(true);
});

it("rejects an oversized whole frame without emitting its prefix", async () => {
  const captured = await capture(async (response) => {
    const delivery = bindRequiredHttpDelivery(response, {
      maxPendingBytes: 32,
      deliver: async (dispatch) => {
        dispatch();
        return true;
      },
    });
    queueRequiredHttpFrame(response, "private oversized frame ".repeat(100));
    endRequiredHttpDelivery(response);
    return delivery.completed;
  });
  expect(captured.text).toBe("");
  expect(captured.interrupted).toBe(true);
  expect(captured.outcome).toMatchObject({
    kind: "failed",
    error: { code: "HTTP_DELIVERY_BACKPRESSURE_EXCEEDED" },
  });
});

it("withholds queued output when delivery authority denies it", async () => {
  const captured = await capture(async (response) => {
    const delivery = bindRequiredHttpDelivery(response, {
      maxPendingBytes: 1024,
      deliver: async () => false,
    });
    queueRequiredHttpFrame(response, "private queued frame");
    endRequiredHttpDelivery(response);
    return delivery.completed;
  });
  expect(captured).toEqual({
    text: "",
    interrupted: true,
    outcome: { kind: "denied" },
  });
});

it("rejects a growing backlog before pending private frames reach the socket", async () => {
  const captured = await capture(async (response) => {
    const release = Promise.withResolvers<void>();
    const delivery = bindRequiredHttpDelivery(response, {
      maxPendingBytes: 64,
      deliver: async (dispatch) => {
        await release.promise;
        dispatch();
        return true;
      },
    });
    queueRequiredHttpFrame(response, "a".repeat(32));
    queueRequiredHttpFrame(response, "b".repeat(32));
    queueRequiredHttpFrame(response, "c");
    release.resolve();
    return delivery.completed;
  });
  expect(captured.text).toBe("");
  expect(captured.interrupted).toBe(true);
  expect(captured.outcome).toMatchObject({
    kind: "failed",
    error: { code: "HTTP_DELIVERY_BACKPRESSURE_EXCEEDED" },
  });
});

it("does not report success when authority fails after handing final bytes to the socket", async () => {
  const captured = await capture(async (response) => {
    const delivery = bindRequiredHttpDelivery(response, {
      maxPendingBytes: 1024,
      deliver: async (dispatch) => {
        dispatch();
        await new Promise<void>((resolve) => setImmediate(resolve));
        throw new Error("Authority transaction failed");
      },
    });
    endRequiredHttpDelivery(response);
    return delivery.completed;
  });
  expect(captured.outcome).toMatchObject({
    kind: "failed",
    error: { code: "HTTP_DELIVERY_FAILED" },
  });
});
