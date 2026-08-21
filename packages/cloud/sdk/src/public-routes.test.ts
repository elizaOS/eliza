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
    this.requests.push({ method, path, options });
    return new Response(JSON.stringify({ method, path, options }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

describe("ElizaCloudPublicRoutesClient path building", () => {
  it("keeps storage object identifiers in typed headers", async () => {
    const transport = new TestTransport();
    const client = new ElizaCloudPublicRoutesClient(transport);

    await client.getApiV1ApisStorageObjects({
      headers: {
        "X-Storage-Object-Key": "folder/file name.txt",
        "Idempotency-Key": "get-1",
      },
    });

    expect(transport.requests).toEqual([
      {
        method: "GET",
        path: "/api/v1/apis/storage/objects/_",
        options: {
          headers: {
            "X-Storage-Object-Key": "folder/file name.txt",
            "Idempotency-Key": "get-1",
          },
        },
      },
    ]);
  });

  it("exposes explicit raw HEAD on the fixed storage endpoint", async () => {
    const transport = new TestTransport();
    const client = new ElizaCloudPublicRoutesClient(transport);

    const response = await client.headApiV1ApisStorageObjects({
      headers: {
        "X-Storage-Object-Key": "folder/file.txt",
        "Idempotency-Key": "head-1",
      },
    });
    expect(response).toBeInstanceOf(Response);
  });

  it("requires upload integrity metadata on the typed PUT surface", async () => {
    const transport = new TestTransport();
    const client = new ElizaCloudPublicRoutesClient(transport);
    await client.putApiV1ApisStorageObjects({
      headers: {
        "X-Storage-Object-Key": "folder/file.txt",
        "Idempotency-Key": "put-1",
        "X-Content-SHA256": "a".repeat(64),
      },
      body: "payload",
    });
    expect(transport.requests[0]?.options?.headers).toMatchObject({
      "X-Content-SHA256": "a".repeat(64),
    });
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
});
