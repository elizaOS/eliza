/**
 * Behavioral coverage for the shared HTTP helper surface re-exported from
 * `src/api/http-helpers.ts`. Every case drives the real exported helpers
 * against a live `node:http` exchange on the loopback interface: bounded body
 * reads, size guards, cross-call body memoization, JSON-object enforcement,
 * error-status translation, and the safe JSON responders. Assertions cover
 * what an HTTP caller observes plus values captured inside the handler, never
 * the internal wiring behind the re-export.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BODY_BYTES,
  readJsonBody,
  readRequestBody,
  readRequestBodyBuffer,
  sendJson,
  sendJsonError,
} from "./http-helpers.js";

interface ExchangeResult {
  status: number;
  contentType: string | null;
  text: string;
}

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

async function exchange(
  handler: Handler,
  init?: { body?: Uint8Array<ArrayBuffer> | string },
): Promise<ExchangeResult> {
  return new Promise<ExchangeResult>((resolveExchange) => {
    const server = http.createServer((req, res) => {
      handler(req, res).catch(() => {
        // Handler-owned outcomes are captured by the individual test;
        // an escaped rejection here only means the response never fired.
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/`;
      void (async () => {
        try {
          const response = await fetch(url, {
            method: "POST",
            body: init?.body ?? "",
          });
          const text = await response.text();
          resolveExchange({
            status: response.status,
            contentType: response.headers.get("content-type"),
            text,
          });
        } catch (error) {
          resolveExchange({
            status: 0,
            contentType: null,
            text: error instanceof Error ? error.message : String(error),
          });
        } finally {
          server.close();
        }
      })();
    });
  });
}

describe("shared http helpers: bounded body reads", () => {
  it("concatenates streamed chunks into one buffer and hands the SAME buffer to repeat readers", async () => {
    const payload = Buffer.from("hello streamed world");
    let firstLength = -1;
    let sameReference = false;
    await exchange(
      async (req, res) => {
        const first = await readRequestBodyBuffer(req);
        const second = await readRequestBodyBuffer(req);
        firstLength = first?.length ?? -1;
        sameReference = second === first;
        res.end("ok");
      },
      { body: payload },
    );

    expect(firstLength).toBe(payload.length);
    expect(sameReference).toBe(true);
  });

  it("returns an empty buffer for an empty body", async () => {
    let length = -1;
    let text: string | null = null;
    await exchange(async (req, res) => {
      const body = await readRequestBodyBuffer(req);
      length = body?.length ?? -1;
      text = await readRequestBody(req);
      res.end("ok");
    });

    expect(length).toBe(0);
    expect(text).toBe("");
  });

  it("decodes the body with the requested encoding", async () => {
    const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    let encoded: string | null = null;
    let plain: string | null = null;
    await exchange(
      async (req, res) => {
        plain = await readRequestBody(req);
        encoded = await readRequestBody(req, { encoding: "base64" });
        res.end("ok");
      },
      { body: payload },
    );

    expect(plain).toBe(payload.toString("utf-8"));
    expect(encoded).toBe(payload.toString("base64"));
  });
});

describe("shared http helpers: size guards", () => {
  it("rejects bodies over the default cap with a typed too-large error carrying context", async () => {
    const oversized = Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1, 0x61);
    let code: string | null = null;
    let message: string | null = null;
    let context: unknown = null;
    let isError = false;
    await exchange(
      async (req, res) => {
        try {
          await readRequestBodyBuffer(req);
        } catch (error) {
          isError = error instanceof ElizaError;
          if (error instanceof ElizaError) {
            code = error.code;
            message = error.message;
            context = error.context;
          }
        }
        res.end("ok");
      },
      { body: oversized },
    );

    expect(isError).toBe(true);
    expect(code).toBe("HTTP_REQUEST_BODY_TOO_LARGE");
    expect(message).toBe(
      `Request body exceeds maximum size (${DEFAULT_MAX_BODY_BYTES} bytes)`,
    );
    expect(context).toMatchObject({
      maxBytes: DEFAULT_MAX_BODY_BYTES,
      observedBytes: oversized.length,
    });
  });

  it("honors a custom too-large message", async () => {
    let message: string | null = null;
    await exchange(
      async (req, res) => {
        try {
          await readRequestBodyBuffer(req, {
            maxBytes: 4,
            tooLargeMessage: "way too big for this lane",
          });
        } catch (error) {
          if (error instanceof ElizaError) {
            message = error.message;
          }
        }
        res.end("ok");
      },
      { body: "abcdefgh" },
    );

    expect(message).toBe("way too big for this lane");
  });

  it("resolves null instead of rejecting when returnNullOnTooLarge is set, destroying the stream on request", async () => {
    let resolvedNull = false;
    let destroyed = false;
    await exchange(
      async (req, _res) => {
        const body = await readRequestBodyBuffer(req, {
          maxBytes: 4,
          returnNullOnTooLarge: true,
          destroyOnTooLarge: true,
        });
        resolvedNull = body === null;
        destroyed = req.destroyed;
      },
      { body: "abcdefgh" },
    );

    expect(resolvedNull).toBe(true);
    expect(destroyed).toBe(true);
  });

  it("rejects AND destroys the stream when destroyOnTooLarge is set alone", async () => {
    let sawError = false;
    let destroyed = false;
    await exchange(
      async (req) => {
        try {
          await readRequestBodyBuffer(req, {
            maxBytes: 4,
            destroyOnTooLarge: true,
          });
        } catch (error) {
          sawError = error instanceof ElizaError;
          destroyed = req.destroyed;
        }
      },
      { body: "abcdefgh" },
    );

    expect(sawError).toBe(true);
    expect(destroyed).toBe(true);
  });

  it("applies the size guard to an already-memoized buffer on repeat reads", async () => {
    let cachedLength = -1;
    let repeatCode: string | null = null;
    let repeatContext: unknown = null;
    await exchange(
      async (req, res) => {
        const first = await readRequestBodyBuffer(req);
        cachedLength = first?.length ?? -1;
        try {
          await readRequestBodyBuffer(req, { maxBytes: 4 });
        } catch (error) {
          if (error instanceof ElizaError) {
            repeatCode = error.code;
            repeatContext = error.context;
          }
        }
        res.end("ok");
      },
      { body: "0123456789" },
    );

    expect(cachedLength).toBe(10);
    expect(repeatCode).toBe("HTTP_REQUEST_BODY_TOO_LARGE");
    expect(repeatContext).toMatchObject({ maxBytes: 4, observedBytes: 10 });
  });

  it("resolves null on a repeat read of a cached buffer that now exceeds a smaller cap", async () => {
    let repeatIsNull = false;
    await exchange(
      async (req, res) => {
        await readRequestBodyBuffer(req);
        const repeat = await readRequestBodyBuffer(req, {
          maxBytes: 4,
          returnNullOnTooLarge: true,
        });
        repeatIsNull = repeat === null;
        res.end("ok");
      },
      { body: "0123456789" },
    );

    expect(repeatIsNull).toBe(true);
  });
});

describe("shared http helpers: readJsonBody", () => {
  it("parses a JSON object, memoizes it on the request, and serves repeat callers from the cache", async () => {
    let firstParsed: unknown = null;
    let secondSameReference = false;
    let exposedOnRequest: unknown = "unset";
    await exchange(
      async (req, res) => {
        firstParsed = await readJsonBody(req, res);
        const second = await readJsonBody(req, res);
        secondSameReference = second === firstParsed;
        exposedOnRequest = (req as unknown as { body?: unknown }).body;
        res.end("ok");
      },
      { body: '{"a":1,"nested":{"b":[2,3]}}' },
    );

    expect(firstParsed).toEqual({ a: 1, nested: { b: [2, 3] } });
    expect(secondSameReference).toBe(true);
    expect(exposedOnRequest).toEqual(firstParsed);
  });

  it("rejects non-object bodies by default with a 400 JSON error", async () => {
    for (const body of ["[1,2,3]", '"just a string"', "5", "null"]) {
      const result = await exchange(
        async (req, res) => {
          const parsed = await readJsonBody(req, res);
          if (parsed === null) return;
          res.end("unexpected");
        },
        { body },
      );

      expect(result.status).toBe(400);
      expect(result.contentType).toBe("application/json");
      expect(JSON.parse(result.text)).toEqual({
        error: "Request body must be a JSON object",
      });
    }
  });

  it("accepts arrays and scalars when requireObject is false", async () => {
    const seen: unknown[] = [];
    await exchange(
      async (req, res) => {
        const parsed = await readJsonBody<unknown>(req, res, {
          requireObject: false,
        });
        seen.push(parsed);
        res.end("ok");
      },
      { body: "[1,2,3]" },
    );
    await exchange(
      async (req, res) => {
        const parsed = await readJsonBody<unknown>(req, res, {
          requireObject: false,
        });
        seen.push(parsed);
        res.end("ok");
      },
      { body: "7" },
    );

    expect(seen[0]).toEqual([1, 2, 3]);
    expect(seen[1]).toBe(7);
  });

  it("reports malformed JSON syntax with the dedicated message and status", async () => {
    const result = await exchange(
      async (req, res) => {
        await readJsonBody(req, res);
      },
      { body: '{"a": oops}' },
    );

    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toEqual({
      error: "Invalid JSON in request body",
    });
  });

  it("honors custom statuses and messages for non-object and parse failures", async () => {
    const nonObject = await exchange(
      async (req, res) => {
        await readJsonBody(req, res, {
          nonObjectStatus: 422,
          nonObjectMessage: "objects only please",
        });
      },
      { body: "[1]" },
    );

    const parseError = await exchange(
      async (req, res) => {
        await readJsonBody(req, res, {
          parseErrorStatus: 418,
          parseErrorMessage: "that is not JSON",
        });
      },
      { body: "{nope" },
    );

    expect(nonObject.status).toBe(422);
    expect(JSON.parse(nonObject.text)).toEqual({
      error: "objects only please",
    });
    expect(parseError.status).toBe(418);
    expect(JSON.parse(parseError.text)).toEqual({
      error: "that is not JSON",
    });
  });

  it("translates body-read failures (including size overflow) into the configured read-error response", async () => {
    const thrown = await exchange(
      async (req, res) => {
        await readJsonBody(req, res, { maxBytes: 4 });
      },
      { body: "abcdefgh" },
    );

    const nulled = await exchange(
      async (req, res) => {
        await readJsonBody(req, res, { maxBytes: 4, returnNullOnError: true });
      },
      { body: "abcdefgh" },
    );

    expect(thrown.status).toBe(413);
    expect(JSON.parse(thrown.text)).toEqual({
      error: "Failed to read request body",
    });
    expect(nulled.status).toBe(413);
    expect(JSON.parse(nulled.text)).toEqual({
      error: "Failed to read request body",
    });
  });

  it("honors custom read-error status and message", async () => {
    const result = await exchange(
      async (req, res) => {
        await readJsonBody(req, res, {
          maxBytes: 2,
          readErrorStatus: 422,
          readErrorMessage: "body refused",
        });
      },
      { body: "abcdef" },
    );

    expect(result.status).toBe(422);
    expect(JSON.parse(result.text)).toEqual({ error: "body refused" });
  });
});

describe("shared http helpers: safe JSON responders", () => {
  it("sendJson writes the payload with the given status and JSON content type", async () => {
    const created = await exchange(
      async (_req, res) => {
        sendJson(res, { ok: true, items: [1, 2] }, 201);
        return;
      },
      { body: "" },
    );

    const defaulted = await exchange(
      async (_req, res) => {
        sendJson(res, { hello: "world" });
        return;
      },
      { body: "" },
    );

    expect(created.status).toBe(201);
    expect(created.contentType).toBe("application/json");
    expect(JSON.parse(created.text)).toEqual({ ok: true, items: [1, 2] });
    expect(defaulted.status).toBe(200);
    expect(JSON.parse(defaulted.text)).toEqual({ hello: "world" });
  });

  it("sendJsonError writes an error envelope with 400 default or an explicit status", async () => {
    const defaulted = await exchange(
      async (_req, res) => {
        sendJsonError(res, "nothing to see here");
        return;
      },
      { body: "" },
    );

    const custom = await exchange(
      async (_req, res) => {
        sendJsonError(res, "denied", 403);
        return;
      },
      { body: "" },
    );

    expect(defaulted.status).toBe(400);
    expect(defaulted.contentType).toBe("application/json");
    expect(JSON.parse(defaulted.text)).toEqual({
      error: "nothing to see here",
    });
    expect(custom.status).toBe(403);
    expect(JSON.parse(custom.text)).toEqual({ error: "denied" });
  });

  it("responders do not throw synchronously when the client vanished before the write", async () => {
    let threw = false;
    await exchange(
      async (req, res) => {
        req.destroy();
        try {
          sendJson(res, { late: true });
          sendJsonError(res, "also late");
        } catch {
          threw = true;
        }
      },
      { body: "" },
    );

    expect(threw).toBe(false);
  });
});
