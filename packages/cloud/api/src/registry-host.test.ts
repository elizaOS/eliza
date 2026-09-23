/**
 * Exercises retired registry host routing with real Request/Response objects.
 * A fetch spy rejects any attempt to keep serving community artifacts.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { serveRegistryHostRequest } from "./registry-host";

const fetchSpy = spyOn(globalThis, "fetch");
afterEach(() => fetchSpy.mockClear());
afterAll(() => fetchSpy.mockRestore());

describe("retired community registry", () => {
  test.each(["GET", "HEAD", "POST"])(
    "returns retirement for %s without upstream access",
    async (method) => {
      const url = new URL("https://plugins.eliza.app/generated-registry.json");
      const response = await serveRegistryHostRequest(
        new Request(url, { method }),
        url,
        {},
      );
      expect(response?.status).toBe(410);
      if (method === "HEAD") expect(await response?.text()).toBe("");
      else
        expect(await response?.json()).toMatchObject({
          success: false,
          code: "registry_retired",
        });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  test("retires staging only in the matching deployment", async () => {
    const url = new URL("https://plugins-staging.eliza.app/index.json");
    expect(
      await serveRegistryHostRequest(new Request(url), url, {}),
    ).toBeNull();
    expect(
      (
        await serveRegistryHostRequest(new Request(url), url, {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud-staging.eliza.app",
        })
      )?.status,
    ).toBe(410);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("other hosts retain normal routing", async () => {
    const url = new URL("https://api.eliza.app/generated-registry.json");
    expect(
      await serveRegistryHostRequest(new Request(url), url, {}),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
