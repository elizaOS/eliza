/**
 * Smoke tests for the Kubernetes manifests under
 * `cloud/infra/cloud/local/manifests/`. These get applied verbatim by
 * `local/setup.sh` to a kind cluster, so they must parse as valid
 * multi-document YAML and contain the apiVersion/kind/metadata each cluster
 * resource requires. A typo here breaks `bun run dev:cloud:local`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const MANIFESTS_DIR = join(
  import.meta.dir,
  "..",
  "cloud",
  "local",
  "manifests",
);

interface K8sDoc {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec?: Record<string, unknown>;
}

function loadAllDocs(file: string): K8sDoc[] {
  const raw = readFileSync(join(MANIFESTS_DIR, file), "utf-8");
  return parseAllDocuments(raw)
    .map((d) => d.toJSON() as K8sDoc | null)
    .filter((d): d is K8sDoc => d !== null);
}

function expectValidK8sDoc(doc: K8sDoc): void {
  expect(typeof doc.apiVersion).toBe("string");
  expect(doc.apiVersion.length).toBeGreaterThan(0);
  expect(typeof doc.kind).toBe("string");
  expect(doc.kind.length).toBeGreaterThan(0);
  expect(doc.metadata).toBeDefined();
  expect(typeof doc.metadata.name).toBe("string");
  expect(doc.metadata.name.length).toBeGreaterThan(0);
}

describe("namespaces.yaml", () => {
  const docs = loadAllDocs("namespaces.yaml");

  test("contains exactly two Namespace documents", () => {
    expect(docs.length).toBe(2);
    for (const d of docs) {
      expect(d.kind).toBe("Namespace");
    }
  });

  test("declares eliza-agents and eliza-infra namespaces", () => {
    const names = docs.map((d) => d.metadata.name).sort();
    expect(names).toEqual(["eliza-agents", "eliza-infra"]);
  });

  test("each doc has the required K8s fields", () => {
    for (const doc of docs) {
      expectValidK8sDoc(doc);
    }
  });
});

describe("external-services.yaml", () => {
  const docs = loadAllDocs("external-services.yaml");

  test("declares ExternalName services for redis + eliza-cloud", () => {
    expect(docs.length).toBe(2);
    const services = docs.map((d) => ({
      name: d.metadata.name,
      kind: d.kind,
    }));
    expect(services).toEqual(
      expect.arrayContaining([
        { name: "redis", kind: "Service" },
        { name: "eliza-cloud", kind: "Service" },
      ]),
    );
  });

  test("each service lives in the eliza-infra namespace", () => {
    for (const doc of docs) {
      expect(doc.metadata.namespace).toBe("eliza-infra");
      expectValidK8sDoc(doc);
    }
  });

  test("pins local ExternalName targets and ports", () => {
    const byName = Object.fromEntries(
      docs.map((doc) => [doc.metadata.name, doc]),
    );

    expect(byName.redis?.spec).toMatchObject({
      type: "ExternalName",
      externalName: "redis-master.eliza-infra.svc.cluster.local",
      ports: [{ port: 6379, targetPort: 6379 }],
    });
    expect(byName["eliza-cloud"]?.spec).toMatchObject({
      type: "ExternalName",
      externalName: "host.docker.internal",
      ports: [{ port: 3000, targetPort: 3000 }],
    });
  });
});

describe("redis-rest.yaml", () => {
  const docs = loadAllDocs("redis-rest.yaml");
  const deployment = docs.find((doc) => doc.kind === "Deployment") as
    | (K8sDoc & {
        spec: {
          selector: { matchLabels: Record<string, string> };
          template: {
            metadata: { labels: Record<string, string> };
            spec: {
              securityContext: Record<string, unknown>;
              containers: Array<{
                name: string;
                image: string;
                ports: Array<{ containerPort: number }>;
                env: Array<{ name: string; value: string }>;
                securityContext: Record<string, unknown>;
              }>;
            };
          };
        };
      })
    | undefined;
  const service = docs.find((doc) => doc.kind === "Service") as
    | (K8sDoc & {
        spec: {
          selector: Record<string, string>;
          ports: Array<{ port: number; targetPort: number }>;
        };
      })
    | undefined;

  test("declares a Deployment + Service pair", () => {
    expect(docs.length).toBe(2);
    const kinds = docs.map((d) => d.kind).sort();
    expect(kinds).toEqual(["Deployment", "Service"]);
  });

  test("everything is named redis-rest in eliza-infra", () => {
    for (const doc of docs) {
      expect(doc.metadata.name).toBe("redis-rest");
      expect(doc.metadata.namespace).toBe("eliza-infra");
      expectValidK8sDoc(doc);
    }
  });

  test("keeps Deployment and Service selectors/ports aligned", () => {
    expect(deployment?.spec.selector.matchLabels).toEqual({
      app: "redis-rest",
    });
    expect(deployment?.spec.template.metadata.labels).toEqual({
      app: "redis-rest",
    });
    expect(service?.spec.selector).toEqual({ app: "redis-rest" });
    expect(service?.spec.ports).toEqual([{ port: 8079, targetPort: 80 }]);
    expect(deployment?.spec.template.spec.containers[0]?.ports).toEqual([
      { containerPort: 80 },
    ]);
  });

  test("wires redis-rest token and Redis connection explicitly", () => {
    const container = deployment?.spec.template.spec.containers[0];
    expect(container?.name).toBe("redis-rest");
    expect(container?.image).toBe(
      "hiett/serverless-redis-http@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150",
    );
    expect(container?.env).toEqual(
      expect.arrayContaining([
        { name: "SRH_MODE", value: "env" },
        { name: "SRH_TOKEN", value: "local_dev_token" },
        {
          name: "SRH_CONNECTION_STRING",
          value: "redis://redis-master.eliza-infra.svc:6379",
        },
      ]),
    );
  });

  test("keeps pod and container security hardening enabled", () => {
    const podSpec = deployment?.spec.template.spec;
    const containerSecurity = podSpec?.containers[0]?.securityContext;

    expect(podSpec?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      fsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(containerSecurity).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
  });
});

describe("shared-eliza.yaml", () => {
  const docs = loadAllDocs("shared-eliza.yaml");

  test("declares a single Server CR (custom resource)", () => {
    expect(docs.length).toBe(1);
    const doc = docs[0];
    expect(doc.kind).toBe("Server");
    expect(doc.apiVersion).toBe("eliza.ai/v1alpha1");
  });

  test("Server CR points at the eliza-agents namespace and includes an agent", () => {
    const doc = docs[0] as K8sDoc & {
      spec: {
        tier: string;
        capacity: number;
        agents: Array<{ agentId: string; characterRef: string }>;
      };
    };
    expect(doc.metadata.namespace).toBe("eliza-agents");
    expect(doc.spec.tier).toBe("shared");
    expect(doc.spec.capacity).toBeGreaterThan(0);
    expect(Array.isArray(doc.spec.agents)).toBe(true);
    expect(doc.spec.agents.length).toBeGreaterThan(0);
    const first = doc.spec.agents[0];
    expect(typeof first.agentId).toBe("string");
    expect(typeof first.characterRef).toBe("string");
  });
});
