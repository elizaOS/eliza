/** Real authenticated capability transport, plugin admission and SQL persistence. */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RemotePluginModuleManifest } from "@elizaos/core";
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

it("matches provenance digests over code-unit key order on every host locale", async () => {
  // A signer outside this process hashes RFC 8785 / canonicalJsonString bytes:
  // "PORT" sorts before "host" by UTF-16 code unit, unlike ICU collation.
  const canonical =
    '{"config":{"PORT":"8080","host":"127.0.0.1"},"id":"module-a","name":"provenance-order"}';
  const module: RemotePluginModuleManifest = {
    id: "module-a",
    name: "provenance-order",
    config: { host: "127.0.0.1", PORT: "8080" },
    provenance: {
      issuer: "issuer-a",
      subject: "module-a",
      digestSha256: createHash("sha256").update(canonical).digest("hex"),
      signatureAlgorithm: "ed25519",
      signature: "digest-only",
    },
  };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ modules: [module] }));
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
    expect(
      (await bootstrapRemoteCapabilityPlugins(fixture.runtime)).registered.map(
        (plugin) => plugin.name,
      ),
    ).toEqual(["provenance-order"]);
  } finally {
    await fixture.cleanup();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 120_000);

it("keeps the provenance walk bounds at 4096 slots and 32 nested containers", async () => {
  type Body = Omit<RemotePluginModuleManifest, "id" | "name" | "provenance">;
  type Metadata = NonNullable<RemotePluginModuleManifest["metadata"]>;
  // Four root keys plus a 4092-slot container fill the 4096-slot budget, and
  // a leaf under 32 nested objects is the deepest data the walk accepts.
  const slots = (count: number) =>
    Array.from({ length: count }, (_, index) => `c${index}`);
  const keyed = (count: number): Metadata =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `k${String(index).padStart(4, "0")}`,
        index,
      ]),
    );
  const nested = (count: number): Metadata => {
    let value: Metadata = { n: "leaf" };
    for (let level = 1; level < count; level += 1) value = { n: value };
    return value;
  };
  const cases: Array<[string, Body]> = [
    ["array-4092", { contexts: slots(4092), version: "1" }],
    ["array-4093", { contexts: slots(4093), version: "1" }],
    ["object-4092", { metadata: keyed(4092), version: "1" }],
    ["object-4093", { metadata: keyed(4093), version: "1" }],
    ["leaf-under-32", { metadata: nested(32) }],
    ["leaf-under-33", { metadata: nested(33) }],
  ];
  let supplied: RemotePluginModuleManifest[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ modules: supplied }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixture = await createTestRuntime({
    characterName: "RemoteProvenanceBounds",
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
    const reasons: Record<string, string | undefined> = {};
    for (const [label, body] of cases) {
      const id = `bound-${label}`;
      // Root keys are inserted in code-unit order, so JSON.stringify is the
      // canonical text a signer would hash.
      const { contexts, metadata, version } = body;
      const unsigned = { contexts, id, metadata, name: id, version };
      supplied = [
        {
          ...unsigned,
          provenance: {
            issuer: "issuer-a",
            subject: id,
            digestSha256: createHash("sha256")
              .update(JSON.stringify(unsigned))
              .digest("hex"),
            signatureAlgorithm: "ed25519",
            signature: "digest-only",
          },
        },
      ];
      reasons[label] = await bootstrapRemoteCapabilityPlugins(
        fixture.runtime,
      ).then(
        (result) =>
          result.trustDecisions.find((decision) => decision.moduleId === id)
            ?.reason,
        (error: { details?: { trustDecision?: { reason?: string } } }) =>
          error.details?.trustDecision?.reason,
      );
    }
    expect(reasons).toEqual({
      "array-4092": "allowed",
      "array-4093": "provenance-walk-bound",
      "object-4092": "allowed",
      "object-4093": "provenance-walk-bound",
      "leaf-under-32": "allowed",
      "leaf-under-33": "provenance-walk-bound",
    });
  } finally {
    await fixture.cleanup();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 120_000);
