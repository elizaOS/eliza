/**
 * Exercise GEPA evidence capture through a real loopback HTTP server. Full
 * Unicode/binary bodies, delayed SSE, retry responses and disconnects cross
 * the actual fetch boundary without replacing the recorder or transport.
 */

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { GepaWireRecorder } from "./gepa-wire-recorder.ts";

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }),
  );
});

describe("GEPA wire recording", () => {
  it("preserves large complete Unicode requests and binary responses without recording auth", async () => {
    const input = JSON.stringify({
      messages: [{ content: `${"α🪐\u0000".repeat(80_000)}END` }],
    });
    const bytes = Buffer.from([0, 255, 128, 10, 65]);
    let received = Buffer.alloc(0);
    let authorized = false;
    const url = await listen(
      createServer(async (request, response) => {
        authorized =
          request.headers.authorization === "Bearer private-test-value";
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        received = Buffer.concat(chunks);
        response.end(bytes);
      }),
    );
    const recorder = new GepaWireRecorder(fetch);
    const response = await recorder.fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer private-test-value" },
      body: input,
    });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    const rows = await recorder.close();
    expect(received.toString()).toBe(input);
    expect(authorized).toBe(true);
    expect(Buffer.from(rows[0].requestBase64, "base64")).toEqual(received);
    expect(Buffer.from(rows[0].response?.bodyBase64 ?? "", "base64")).toEqual(
      bytes,
    );
    expect(JSON.stringify(rows)).not.toContain("private-test-value");
    await expect(recorder.fetch(url)).rejects.toMatchObject({
      code: "GEPA_WIRE_RECORDER_CLOSED",
    });
  });

  it("delivers streaming headers before EOF and waits for the complete SSE body", async () => {
    let release: () => void = () => {
      throw new Error("Stream not started");
    };
    const first = 'data: {"model":"served-model","delta":"🌌"}\n\n';
    const last = 'data: {"usage":{"total_tokens":321}}\n\ndata: [DONE]\n\n';
    const url = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(first);
        release = () => response.end(last);
      }),
    );
    const recorder = new GepaWireRecorder(fetch);
    const response = await recorder.fetch(url);
    let closed = false;
    const complete = recorder.close().then((rows) => {
      closed = true;
      return rows;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    expect(await response.text()).toBe(first + last);
    const rows = await complete;
    expect(
      Buffer.from(rows[0].response?.bodyBase64 ?? "", "base64").toString(),
    ).toBe(first + last);
  });

  it("retains each HTTP retry attempt with its actual error and success body", async () => {
    let calls = 0;
    const url = await listen(
      createServer((_request, response) => {
        calls += 1;
        response.statusCode = calls === 1 ? 429 : 200;
        response.end(
          calls === 1 ? '{"error":"retry"}' : '{"model":"actual-model"}',
        );
      }),
    );
    const recorder = new GepaWireRecorder(fetch);
    expect((await recorder.fetch(url)).status).toBe(429);
    expect((await recorder.fetch(url)).status).toBe(200);
    const rows = await recorder.close();
    expect(rows.map((row) => row.response?.status)).toEqual([429, 200]);
    expect(
      rows.map((row) =>
        Buffer.from(row.response?.bodyBase64 ?? "", "base64").toString(),
      ),
    ).toEqual(['{"error":"retry"}', '{"model":"actual-model"}']);
  });

  it("rejects incomplete evidence after a real mid-body disconnect", async () => {
    const url = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { "content-length": "10000" });
        response.write("partial");
        setImmediate(() => response.destroy());
      }),
    );
    const recorder = new GepaWireRecorder(fetch);
    const response = await recorder.fetch(url);
    await expect(response.text()).rejects.toThrow();
    await expect(recorder.close()).rejects.toMatchObject({
      code: "GEPA_WIRE_CAPTURE_FAILED",
    });
    expect(recorder.snapshot()).toHaveLength(1);
    expect(recorder.snapshot()[0].response).toBeNull();
  });

  it("rejects credential-bearing query URLs before dispatch", async () => {
    let calls = 0;
    const url = await listen(
      createServer((_request, response) => {
        calls += 1;
        response.end();
      }),
    );
    const recorder = new GepaWireRecorder(fetch);
    await expect(
      recorder.fetch(`${url}/?api_key=private-test-value`),
    ).rejects.toMatchObject({ code: "GEPA_WIRE_ENDPOINT_INVALID" });
    expect(calls).toBe(0);
  });

  it("does not follow an unrecorded redirect and preserves its failed attempt", async () => {
    let destinationCalls = 0;
    const destination = await listen(
      createServer((_request, response) => {
        destinationCalls += 1;
        response.end("unobserved");
      }),
    );
    const origin = await listen(
      createServer((_request, response) => {
        response.writeHead(307, { location: destination });
        response.end();
      }),
    );
    const recorder = new GepaWireRecorder(fetch);
    await expect(recorder.fetch(origin)).rejects.toMatchObject({
      code: "GEPA_WIRE_TRANSPORT_FAILED",
    });
    await expect(recorder.close()).rejects.toMatchObject({
      code: "GEPA_WIRE_CAPTURE_FAILED",
    });
    expect(destinationCalls).toBe(0);
    expect(recorder.snapshot()[0].transportFailed).toBe(true);
  });
});
