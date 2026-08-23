/**
 * Coverage for cloudflare-api.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock("./owned-bounded-fetch", () => ({
  ownedBoundedFetch: vi.fn(),
}));

import { CLOUDFLARE_REQUEST_TIMEOUT_MS, cloudflareFetch } from "./cloudflare-api.js";
import { ownedBoundedFetch } from "./owned-bounded-fetch.js";

describe("cloudflare-api", () => {
  it("exposes timeout", () => {
    expect(CLOUDFLARE_REQUEST_TIMEOUT_MS).toBe(30000);
  });
  it("delegates to ownedBoundedFetch", async () => {
    const mock = vi.mocked(ownedBoundedFetch);
    mock.mockResolvedValue(new Response("ok"));
    const res = await cloudflareFetch("https://api.cloudflare.com/client/v4/zones");
    expect(mock).toHaveBeenCalled();
    expect(res).toBeDefined();
  });
});
