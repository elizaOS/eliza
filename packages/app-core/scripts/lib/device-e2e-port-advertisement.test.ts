/**
 * Integration coverage for publishing a real kernel-assigned device-e2e port
 * through the runtime environment, CORS cache, self-report route, and file.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDevStackFromEnv } from "../../src/api/dev-stack.ts";
import {
  getCorsAllowedPorts,
  invalidateCorsAllowedPorts,
  isAllowedOrigin,
} from "../../src/api/server-cors.ts";
import { publishBoundDeviceE2ePort } from "./device-e2e-port-advertisement.ts";

const ENV_KEYS = ["ELIZA_API_PORT", "ELIZA_UI_PORT", "ELIZA_PORT"] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  invalidateCorsAllowedPorts();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("device-e2e bound-port publication", () => {
  it("rejects an invalid bound port before mutating runtime state", () => {
    process.env.ELIZA_API_PORT = "43137";
    process.env.ELIZA_UI_PORT = "43138";
    process.env.ELIZA_PORT = "43139";

    expect(() => publishBoundDeviceE2ePort(0)).toThrow(
      "Invalid bound device-e2e port: 0",
    );
    expect(process.env.ELIZA_API_PORT).toBe("43137");
    expect(process.env.ELIZA_UI_PORT).toBe("43138");
    expect(process.env.ELIZA_PORT).toBe("43139");
  });

  it("synchronizes env and cache before advertising the self-reported route", async () => {
    process.env.ELIZA_API_PORT = "43137";
    process.env.ELIZA_UI_PORT = "43138";
    process.env.ELIZA_PORT = "43139";
    expect(getCorsAllowedPorts().has("43137")).toBe(true);
    process.env.ELIZA_API_PORT = "0";
    process.env.ELIZA_UI_PORT = "0";
    process.env.ELIZA_PORT = "0";

    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          envPort: process.env.ELIZA_API_PORT,
          stack: resolveDevStackFromEnv(process.env),
          corsAllowsSelf: isAllowedOrigin(
            `http://127.0.0.1:${process.env.ELIZA_API_PORT}`,
          ),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not bind a TCP port.");
      }
      const directory = await mkdtemp(join(tmpdir(), "eliza-port-publish-"));
      temporaryDirectories.push(directory);
      const portFile = join(directory, "port");

      publishBoundDeviceE2ePort(address.port, portFile);

      expect(process.env.ELIZA_API_PORT).toBe(String(address.port));
      expect(process.env.ELIZA_UI_PORT).toBe(String(address.port));
      expect(process.env.ELIZA_PORT).toBe(String(address.port));
      expect(await readFile(portFile, "utf8")).toBe(`${address.port}\n`);

      const response = await fetch(`http://127.0.0.1:${address.port}/self`);
      expect(await response.json()).toMatchObject({
        envPort: String(address.port),
        stack: {
          api: {
            listenPort: address.port,
            baseUrl: `http://127.0.0.1:${address.port}`,
          },
        },
        corsAllowsSelf: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
