// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createUsbInstallerHandler } from "../../server";

describe("USB installer request origins", () => {
  it.each(["null", "", "https://example.invalid"])(
    "rejects origin %j before invoking the backend",
    async (origin) => {
      const listRemovableDrives = vi.fn(async () => []);
      const createWritePlan = vi.fn(async () => {
        throw new Error("Unexpected planning call");
      });
      const handler = createUsbInstallerHandler({
        listRemovableDrives,
        listImages: async () => [],
        createWritePlan,
      });
      for (const [method, route] of [
        ["GET", "/drives"],
        ["POST", "/plan"],
        ["OPTIONS", "/execute"],
      ] as const) {
        const response = await handler(
          new Request(`http://127.0.0.1:3742${route}`, {
            method,
            headers: { Origin: origin },
          }),
        );
        expect(response.status).toBe(403);
      }
      expect(listRemovableDrives).not.toHaveBeenCalled();
      expect(createWritePlan).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "http://127.0.0.1:3742"])(
    "retains native and trusted-loopback clients with origin %j",
    async (origin) => {
      const listRemovableDrives = vi.fn(async () => []);
      const handler = createUsbInstallerHandler({
        listRemovableDrives,
        listImages: async () => [],
        createWritePlan: async () => {
          throw new Error("Unexpected planning call");
        },
      });
      const response = await handler(
        new Request("http://127.0.0.1:3742/drives", {
          headers: origin === undefined ? {} : { Origin: origin },
        }),
      );
      expect(response.status).toBe(200);
      expect(listRemovableDrives).toHaveBeenCalledOnce();
    },
  );
});
