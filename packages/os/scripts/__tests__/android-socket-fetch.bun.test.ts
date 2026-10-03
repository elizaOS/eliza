import { expect, test } from "bun:test";
import net from "node:net";
import { androidSocketFetch } from "../aosp/lib/android-socket-fetch.ts";

async function withBridge(
  reply: (socket: net.Socket, frame: any) => void,
  run: (url: string) => Promise<void>,
) {
  const server = net.createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) reply(socket, JSON.parse(input.split("\n")[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(
      `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api/probe?q=1`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("Android socket transport preserves request and split binary response frames", async () => {
  await withBridge(
    (socket, frame) => {
      expect(frame.method).toBe("http_request");
      expect(frame.payload).toEqual({
        path: "/api/probe?q=1",
        method: "POST",
        headers: { authorization: "Bearer fixture" },
        body: "payload",
      });
      const result =
        JSON.stringify({
          id: frame.id,
          ok: true,
          result: {
            status: 201,
            headers: { "content-type": "application/octet-stream" },
            bodyEncoding: "base64",
            bodyBase64: "AP+A",
          },
        }) + "\n";
      socket.write(result.slice(0, 15));
      setTimeout(() => socket.end(result.slice(15)), 5);
    },
    async (url) => {
      const response = await androidSocketFetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer fixture" },
        body: "payload",
        signal: AbortSignal.timeout(1000),
      });
      expect(response.status).toBe(201);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array([0, 255, 128]),
      );
    },
  );
});

test("Android socket transport rejects truncated and mismatched responses", async () => {
  await withBridge(
    (socket) => socket.end('{"id":'),
    async (url) => {
      await expect(
        androidSocketFetch(url, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow("complete response");
    },
  );
  await withBridge(
    (socket) =>
      socket.end(
        JSON.stringify({
          id: "wrong",
          ok: true,
          result: { status: 200, body: "no" },
        }) + "\n",
      ),
    async (url) => {
      await expect(
        androidSocketFetch(url, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow("Invalid Android bridge response");
    },
  );
});
