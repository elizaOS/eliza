/**
 * Exercises the registry boundary over real HTTP responses so only 404 maps to
 * absence while authentication, throttling, server, transport, malformed JSON,
 * malformed metadata, and integrity conflicts remain distinguishable failures.
 */

import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import {
  classifyRegistryVersion,
  inspectRegistryVersion,
  RegistryInspectionError,
} from "../lib/release-registry.mjs";

const servers: http.Server[] = [];
const packageRecord = {
  name: "@release-fixture/a",
  version: "1.2.3",
  tarball: { integrity: "sha512-planned" },
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function registry(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP test server has no address");
  return `http://127.0.0.1:${address.port}/`;
}

describe("registry inspection", () => {
  test("only 404 is a missing version", async () => {
    const registryUrl = await registry((_request, response) => {
      response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    });
    await expect(
      inspectRegistryVersion({ registryUrl, packageRecord }),
    ).resolves.toEqual({
      state: "missing",
    });
  });

  for (const [status, kind] of [
    [401, "authentication"],
    [403, "authentication"],
    [429, "throttling"],
    [503, "server"],
  ] as const) {
    test(`HTTP ${status} fails as ${kind}, never missing`, async () => {
      const registryUrl = await registry((_request, response) => {
        response.writeHead(status).end("failure");
      });
      try {
        await inspectRegistryVersion({ registryUrl, packageRecord });
        throw new Error("inspection unexpectedly passed");
      } catch (error) {
        expect(error).toBeInstanceOf(RegistryInspectionError);
        expect((error as RegistryInspectionError).kind).toBe(kind);
        expect((error as RegistryInspectionError).status).toBe(status);
      }
    });
  }

  test("malformed successful JSON and malformed metadata fail", async () => {
    const malformedJson = await registry((_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end("{broken");
    });
    await expect(
      inspectRegistryVersion({ registryUrl: malformedJson, packageRecord }),
    ).rejects.toMatchObject({
      kind: "malformed-response",
    });
    expect(() =>
      classifyRegistryVersion(packageRecord, { name: packageRecord.name }),
    ).toThrow("does not match");
  });

  test("transport failure remains a transport error", async () => {
    try {
      await inspectRegistryVersion({
        registryUrl: "http://127.0.0.1:1/",
        packageRecord,
      });
      throw new Error("inspection unexpectedly passed");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryInspectionError);
      expect((error as RegistryInspectionError).kind).toBe("transport");
    }
  });

  test("matching integrity resumes and conflicting integrity is explicit", () => {
    const base = { name: packageRecord.name, version: packageRecord.version };
    expect(
      classifyRegistryVersion(packageRecord, {
        ...base,
        dist: { integrity: packageRecord.tarball.integrity },
      }),
    ).toEqual({ state: "matched", integrity: packageRecord.tarball.integrity });
    expect(
      classifyRegistryVersion(packageRecord, {
        ...base,
        dist: { integrity: "sha512-other" },
      }),
    ).toEqual({
      state: "conflict",
      expectedIntegrity: packageRecord.tarball.integrity,
      actualIntegrity: "sha512-other",
    });
  });
});
