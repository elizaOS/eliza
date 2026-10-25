import http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { readCompatJsonBody } from "./compat-route-shared";

describe("compat JSON boundary", () => {
  it.each([null, [], "payload", 1, false])(
    "rejects invalid pre-parsed input %j without rereading the stream",
    async (body) => {
      const req = Object.assign(new http.IncomingMessage(new Socket()), {
        body,
      });
      const iterator = vi.spyOn(req, "iterator");
      const res = { headersSent: false, setHeader: vi.fn(), end: vi.fn() };
      expect(
        await readCompatJsonBody(req, res as unknown as http.ServerResponse),
      ).toBeNull();
      expect(res).toHaveProperty("statusCode", 400);
      expect(iterator).not.toHaveBeenCalled();
    },
  );

  it("preserves an adapter-provided object", async () => {
    const body = { preferences: { primary: "in-house" } };
    const req = Object.assign(new http.IncomingMessage(new Socket()), { body });
    expect(await readCompatJsonBody(req, {} as http.ServerResponse)).toBe(body);
  });

  it("delivers a 413 over a real socket for an oversized request", async () => {
    const server = http.createServer((req, res) => {
      void readCompatJsonBody(req, res).then((body) => {
        if (body !== null) res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server port");
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        body: JSON.stringify({ value: "x".repeat(1_048_576) }),
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "Request body too large",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
