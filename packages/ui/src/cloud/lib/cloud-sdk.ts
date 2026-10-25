/** Adapts the Cloud SDK to the canonical browser/native session transport without another token owner. */
import { ElizaCloudClient } from "@elizaos/cloud-sdk";
import { apiFetch } from "./api-client";

const sdkFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== "https://cloud-sdk.invalid" ||
      !url.pathname.startsWith("/api/")
    ) {
      throw new Error("The Cloud SDK requested an unsupported API destination");
    }
    return apiFetch(`${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.text(),
    });
  },
  fetch,
);

export const sessionCloudSdk = new ElizaCloudClient({
  apiBaseUrl: "https://cloud-sdk.invalid/api/v1",
  fetchImpl: sdkFetch,
});
