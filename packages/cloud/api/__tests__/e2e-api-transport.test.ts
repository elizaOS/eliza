import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { api } from "../test/e2e/_helpers/api";

test("local mutations use fresh connections without replaying server failures", async () => {
  const previousBaseUrl = process.env.TEST_API_BASE_URL;
  const requests: {
    port: number | undefined;
    body: string;
    contentType: string | undefined;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      port: request.socket.remotePort,
      body: Buffer.concat(chunks).toString(),
      contentType: request.headers["content-type"],
    });
    response.writeHead(request.url === "/fail" ? 500 : 200, {
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ received: requests.length }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    process.env.TEST_API_BASE_URL = `http://127.0.0.1:${address.port}`;

    expect(await (await api.post("/first", { value: 1 })).text()).toBe(
      '{"received":1}',
    );
    expect(
      await (
        await api.post("/second", "raw", {
          headers: { "content-type": "text/plain" },
        })
      ).text(),
    ).toBe('{"received":2}');
    const failed = await api.post("/fail", { value: 3 });
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe('{"received":3}');
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map(({ port }) => port)).size).toBe(3);
    expect(
      requests.map(({ body, contentType }) => ({ body, contentType })),
    ).toEqual([
      { body: '{"value":1}', contentType: "application/json" },
      { body: "raw", contentType: "text/plain" },
      { body: '{"value":3}', contentType: "application/json" },
    ]);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.TEST_API_BASE_URL;
    else process.env.TEST_API_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
