/** Unit tests for `ElizaCloudPublicRoutesClient` (the generated route wrappers) against a stub transport, checking method/path dispatch and the `Raw` variants. */

import { describe, expect, it } from "vitest";
import { ElizaCloudPublicRoutesClient } from "./public-routes.js";
import type { CloudRequestOptions, HttpMethod } from "./types.js";

class TestTransport {
  readonly requests: {
    method: HttpMethod;
    path: string;
    options?: CloudRequestOptions;
  }[] = [];

  async request<TResponse>(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<TResponse> {
    this.requests.push({ method, path, options });
    return { method, path, options } as TResponse;
  }

  async requestRaw(
    method: HttpMethod,
    path: string,
    options?: CloudRequestOptions,
  ): Promise<Response> {
    return new Response(JSON.stringify({ method, path, options }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

describe("ElizaCloudPublicRoutesClient path building", () => {
  it("preserves meaningful empty middle segments for catch-all string params", async () => {
    const transport = new TestTransport();
    const client = new ElizaCloudPublicRoutesClient(transport);

    await client.getApiV1ApisStorageObjectsByKey({
      pathParams: { key: "folder//file name.txt" },
    });

    expect(transport.requests).toEqual([
      {
        method: "GET",
        path: "/api/v1/apis/storage/objects/folder//file%20name.txt",
        options: {},
      },
    ]);
  });

  it("encodes catch-all array params one segment at a time", async () => {
    const transport = new TestTransport();
    const client = new ElizaCloudPublicRoutesClient(transport);

    await client.deleteApiV1ApisStorageObjectsByKey({
      pathParams: { key: ["folder/slash", "file name.txt"] },
      query: { hard: true },
    });

    expect(transport.requests).toEqual([
      {
        method: "DELETE",
        path: "/api/v1/apis/storage/objects/folder%2Fslash/file%20name.txt",
        options: { query: { hard: true } },
      },
    ]);
  });

  it("rejects unexpected params and arrays for non-catch-all params", async () => {
    const client = new ElizaCloudPublicRoutesClient(new TestTransport());

    await expect(() =>
      client.getApiV1AppsById({
        pathParams: { id: "app_1", extra: "nope" } as never,
      }),
    ).toThrow(/Unexpected path parameter "extra"/);

    await expect(() =>
      client.getApiV1AppsById({
        pathParams: { id: ["app", "1"] } as never,
      }),
    ).toThrow(/does not accept multiple segments/);
  });

  it("rejects catch-all values with empty leading or trailing segments", async () => {
    const client = new ElizaCloudPublicRoutesClient(new TestTransport());

    await expect(() =>
      client.getApiV1ApisStorageObjectsByKey({
        pathParams: { key: "/folder/file" },
      }),
    ).toThrow(/cannot start or end with an empty segment/);
    await expect(() =>
      client.getApiV1ApisStorageObjectsByKey({
        pathParams: { key: ["folder", ""] },
      }),
    ).toThrow(/cannot start or end with an empty segment/);
  });
});
