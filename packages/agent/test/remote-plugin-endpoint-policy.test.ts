/** Real authenticated capability transport, plugin admission and SQL persistence. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonObject, RemotePluginModuleManifest } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { bootstrapRemoteCapabilityPlugins } from "../src/services/remote-plugin-adapter.ts";

it.each(["a", "__proto__"])(
  "keeps endpoint %s module and signing authority through bootstrap and reload",
  async (endpointIdA) => {
    let supplied: RemotePluginModuleManifest[] = [];
    const calls: string[] = [];
    const servers = ["a", "b"].map((id) =>
      createServer(async (request, response) => {
        if (request.headers.authorization !== `Bearer fixture-${id}`) {
          response.writeHead(401).end();
          return;
        }
        let body = "";
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body) as { method: string };
        calls.push(`${id}:${payload.method}`);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ modules: id === "a" ? supplied : [] }));
      }),
    );
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
          ),
      ),
    );
    const fixture = await createTestRuntime({
      characterName: "RemoteEndpointPolicy",
      settings: {
        ELIZA_CAPABILITY_ROUTER_ENABLED: "true",
        ELIZA_CAPABILITY_ROUTER_URLS: JSON.stringify(
          servers.map((server, index) => ({
            id: index ? "b" : endpointIdA,
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            token: `fixture-${index ? "b" : "a"}`,
          })),
        ),
        ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES: JSON.stringify({
          [endpointIdA]: ["module-a"],
          b: ["module-b"],
        }),
      },
    });
    const runtime = fixture.runtime;
    try {
      const marker = await runtime.createTask({
        name: "POLICY_DURABLE_MARKER",
        agentId: runtime.agentId,
        tags: [],
        metadata: { retained: true },
      });
      supplied = [{ id: "module-b", name: "endpoint-policy-b" }];
      await expect(
        bootstrapRemoteCapabilityPlugins(runtime),
      ).rejects.toMatchObject({
        details: {
          trustDecision: {
            endpointId: endpointIdA,
            reason: "module-not-allowed",
          },
        },
      });
      expect(
        runtime.plugins.some((plugin) => plugin.name === "endpoint-policy-b"),
      ).toBe(false);
      supplied = [{ id: "module-a", name: "endpoint-policy-a" }];
      expect(
        (await bootstrapRemoteCapabilityPlugins(runtime)).registered.map(
          (plugin) => plugin.name,
        ),
      ).toEqual(["endpoint-policy-a"]);
      supplied = [{ id: "module-b", name: "endpoint-policy-b" }];
      await expect(
        bootstrapRemoteCapabilityPlugins(runtime, { reloadExisting: true }),
      ).rejects.toMatchObject({
        details: { trustDecision: { reason: "module-not-allowed" } },
      });
      expect(
        runtime.plugins.some((plugin) => plugin.name === "endpoint-policy-a"),
      ).toBe(true);

      const keys = Object.fromEntries(
        ["a", "b"].map((id) => [id, generateKeyPairSync("ed25519")]),
      );
      const publicKeys = Object.fromEntries(
        Object.entries(keys).map(([id, pair]) => [
          `issuer-${id}`,
          pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        ]),
      );
      const signedModule = (id: "a" | "b") => {
        const module: RemotePluginModuleManifest = {
          id: "module-a",
          name: "endpoint-policy-a",
        };
        const digestSha256 = createHash("sha256")
          .update(JSON.stringify(module))
          .digest("hex");
        const issuer = `issuer-${id}`;
        module.provenance = {
          issuer,
          subject: module.id,
          digestSha256,
          signatureAlgorithm: "ed25519",
          signature: sign(
            null,
            Buffer.from(
              `issuer:${issuer}\nsubject:${module.id}\ndigestSha256:${digestSha256}`,
            ),
            keys[id].privateKey,
          ).toString("base64"),
        };
        return module;
      };
      runtime.setSetting(
        "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
        JSON.stringify({
          allowedProvenanceIssuers: ["issuer-a", "issuer-b"],
          trustedProvenancePublicKeys: publicKeys,
          requireVerifiedProvenance: true,
          requireProvenanceDigestMatch: true,
          [endpointIdA]: {
            allowedProvenanceIssuers: ["issuer-a"],
            trustedProvenancePublicKeys: { "issuer-a": publicKeys["issuer-a"] },
            requireVerifiedProvenance: true,
          },
          b: {
            allowedProvenanceIssuers: ["issuer-b"],
            trustedProvenancePublicKeys: { "issuer-b": publicKeys["issuer-b"] },
            requireVerifiedProvenance: true,
          },
        }),
      );
      supplied = [signedModule("b")];
      await expect(
        bootstrapRemoteCapabilityPlugins(runtime, { reloadExisting: true }),
      ).rejects.toMatchObject({
        details: {
          trustDecision: {
            endpointId: endpointIdA,
            reason: "provenance-issuer-not-allowed",
          },
        },
      });
      supplied = [signedModule("a")];
      expect(
        (
          await bootstrapRemoteCapabilityPlugins(runtime, {
            reloadExisting: true,
          })
        ).registered.map((plugin) => plugin.name),
      ).toEqual(["endpoint-policy-a"]);
      runtime.setSetting(
        "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
        JSON.stringify({
          allowedProvenanceIssuers: ["issuer-b"],
          [endpointIdA]: { allowedProvenanceIssuers: ["issuer-a"] },
        }),
      );
      await expect(
        bootstrapRemoteCapabilityPlugins(runtime, { reloadExisting: true }),
      ).rejects.toMatchObject({
        details: { trustDecision: { reason: "provenance-issuer-not-allowed" } },
      });
      expect((await runtime.getTask(marker))?.metadata).toMatchObject({
        retained: true,
      });
      expect(calls).toContain("a:plugin.modules.list");
      expect(calls).toContain("b:plugin.modules.list");
    } finally {
      await fixture.cleanup();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
    }
  },
  120_000,
);

it("matches provenance digests over code-unit key order up to the walk bounds", async () => {
  const signed = (
    fields: Pick<RemotePluginModuleManifest, "name" | "config" | "metadata">,
    canonical = JSON.stringify({
      id: "module-a",
      metadata: fields.metadata,
      name: fields.name,
    }),
  ): RemotePluginModuleManifest => ({
    id: "module-a",
    ...fields,
    provenance: {
      issuer: "issuer-a",
      subject: "module-a",
      digestSha256: createHash("sha256").update(canonical).digest("hex"),
      signatureAlgorithm: "ed25519",
      signature: "digest-only",
    },
  });
  // Three root keys and one metadata key leave 4092 of the 4096 node slots.
  const wide = (name: string, slots: number) =>
    signed({ name, metadata: { items: new Array<number>(slots).fill(0) } });
  // `objects` nested objects below the root, metadata included, then a leaf.
  const deep = (name: string, objects: number) => {
    let metadata: JsonObject = { a: 1 };
    for (let level = 1; level < objects; level += 1) metadata = { a: metadata };
    return signed({ name, metadata });
  };
  let supplied: RemotePluginModuleManifest[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ modules: supplied }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixture = await createTestRuntime({
    characterName: "RemoteProvenanceOrder",
    settings: {
      ELIZA_CAPABILITY_ROUTER_ENABLED: "true",
      ELIZA_CAPABILITY_ROUTER_URLS: JSON.stringify([
        {
          id: "a",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          token: "fixture-a",
        },
      ]),
      ELIZA_CAPABILITY_ROUTER_TRUST_POLICY: JSON.stringify({
        requireProvenanceDigestMatch: true,
      }),
    },
  });
  try {
    for (const module of [wide("too-wide", 4093), deep("too-deep", 33)]) {
      supplied = [module];
      await expect(
        bootstrapRemoteCapabilityPlugins(fixture.runtime),
      ).rejects.toMatchObject({
        details: { trustDecision: { reason: "provenance-walk-bound" } },
      });
    }
    for (const module of [
      // A signer outside this process hashes RFC 8785 / canonicalJsonString
      // bytes: "PORT" sorts before "host" by UTF-16 code unit, unlike ICU
      // collation.
      signed(
        {
          name: "provenance-order",
          config: { host: "127.0.0.1", PORT: "8080" },
        },
        '{"config":{"PORT":"8080","host":"127.0.0.1"},"id":"module-a","name":"provenance-order"}',
      ),
      wide("widest", 4092),
      deep("deepest", 32),
    ]) {
      supplied = [module];
      expect(
        (
          await bootstrapRemoteCapabilityPlugins(fixture.runtime)
        ).registered.map((plugin) => plugin.name),
      ).toEqual([module.name]);
    }
  } finally {
    await fixture.cleanup();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 120_000);
