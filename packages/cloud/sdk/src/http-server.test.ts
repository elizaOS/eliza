/**
 * Exercises parsed SDK response contracts over real localhost HTTP, including
 * public account access and raw/bodyless protocol behavior without fetch mocks.
 */
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ElizaCloudClient } from "./client.js";
import { CloudApiClient, ElizaCloudHttpClient } from "./http.js";

let baseUrl: string;
const server = createServer((req, res) => {
  const path = req.url ?? "/";
  const send = (body: string, contentType?: string): void => {
    if (contentType) res.setHeader("content-type", contentType);
    res.end(body);
  };
  if (path === "/api/v1/user") return send("<h1>Maintenance</h1>", "text/html");
  if (path === "/missing-type") return send('{"id":"real"}');
  if (path === "/wrong-type") return send('{"id":"real"}', "text/plain");
  if (path === "/empty") return send("", "application/json");
  if (path === "/malformed") return send("{broken", "application/json");
  if (path === "/raw") return send("complete server text", "text/plain");
  if (path === "/bodyless/204" || path === "/bodyless/205") {
    res.statusCode = Number(path.split("/")[2]);
    return res.end();
  }
  if (req.method === "HEAD") return res.end();
  const value = new URL(path, "http://localhost").searchParams.get("value");
  send(value ?? '{"id":"real"}', "Application/Problem+JSON; charset=utf-8");
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing HTTP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});

describe("real HTTP parsed response contracts", () => {
  it("fails the public account request on an HTML maintenance page", async () => {
    await expect(
      new ElizaCloudClient({ baseUrl }).getUser(),
    ).rejects.toMatchObject({
      name: "CloudApiError",
      statusCode: 200,
      errorBody: { code: "unexpected_response_content_type" },
    });
  });
  it.each(["/missing-type", "/wrong-type"])(
    "rejects mislabeled data at %s",
    async (path) => {
      await expect(
        new ElizaCloudHttpClient({ baseUrl }).get(path),
      ).rejects.toMatchObject({
        errorBody: { code: "unexpected_response_content_type" },
      });
    },
  );
  it.each([
    ["/empty", "empty_response_body"],
    ["/malformed", "malformed_json_response"],
  ])("rejects unusable JSON at %s", async (path, code) => {
    await expect(
      new ElizaCloudHttpClient({ baseUrl }).get(path),
    ).rejects.toMatchObject({ errorBody: { code } });
  });
  it.each(
    ["hello", "", null, false, 0, [1, "two"], { id: "real" }].map((value) => [
      value,
    ]),
  )("preserves JSON value %# with a structured media type", async (value) => {
    const path = `/json?value=${encodeURIComponent(JSON.stringify(value))}`;
    await expect(
      new ElizaCloudHttpClient({ baseUrl }).get(path),
    ).resolves.toEqual(value);
  });
  it.each([204, 205])("returns absence for HTTP %s", async (status) => {
    await expect(
      new ElizaCloudHttpClient({ baseUrl }).get(`/bodyless/${status}`),
    ).resolves.toBeUndefined();
  });
  it.each([204, 205])(
    "preserves successful bodyless mutations with HTTP %s",
    async (status) => {
      const client = new CloudApiClient(baseUrl);
      const path = `/bodyless/${status}`;
      await expect(
        client.post(path, { value: "updated" }),
      ).resolves.toBeUndefined();
      await expect(
        client.put(path, { value: "updated" }),
      ).resolves.toBeUndefined();
      await expect(
        client.patch(path, { value: "updated" }),
      ).resolves.toBeUndefined();
      await expect(client.delete(path)).resolves.toBeUndefined();
      await expect(
        client.postUnauthenticated(path, { value: "updated" }),
      ).resolves.toBeUndefined();
      await expect(client.requestData("DELETE", path)).rejects.toMatchObject({
        statusCode: status,
        errorBody: { code: "empty_response_body" },
      });
    },
  );
  it("returns absence for HEAD and preserves text through raw access", async () => {
    const client = new ElizaCloudHttpClient({ baseUrl });
    await expect(client.request("HEAD", "/head")).resolves.toBeUndefined();
    const response = await client.requestRaw("GET", "/raw");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("complete server text");
  });
});
