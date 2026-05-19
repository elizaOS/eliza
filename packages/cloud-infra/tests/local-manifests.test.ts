/**
 * Smoke tests for the Kubernetes manifests under
 * `cloud-infra/cloud/local/manifests/`. These get applied verbatim by
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
});

describe("redis-rest.yaml", () => {
  const docs = loadAllDocs("redis-rest.yaml");

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
