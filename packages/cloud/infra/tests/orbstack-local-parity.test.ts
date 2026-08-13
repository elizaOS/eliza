/**
 * Statically validates the OrbStack profile contract and rendered Kubernetes resources.
 * No test touches the developer's Docker daemon or Kubernetes cluster.
 */

import { describe, expect, test } from "bun:test";
import { parseAllDocuments } from "yaml";
import {
  profiles,
  renderDependencies,
  validateOrbStackContexts,
} from "../cloud/orbstack/local-parity.mjs";

describe("OrbStack local parity profiles", () => {
  test("uses isolated namespaces and non-overlapping host ports", () => {
    expect(profiles.staging.namespace).not.toBe(profiles.production.namespace);
    const stagingPorts = new Set(
      Object.entries(profiles.staging)
        .filter(([key]) => key.endsWith("Port"))
        .map(([, value]) => value),
    );
    const productionPorts = new Set(
      Object.entries(profiles.production)
        .filter(([key]) => key.endsWith("Port"))
        .map(([, value]) => value),
    );
    expect([...stagingPorts].some((port) => productionPorts.has(port))).toBe(
      false,
    );
  });

  test("renders the same dependency kinds into profile-specific namespaces", () => {
    const rendered = (["staging", "production"] as const).map((profile) =>
      parseAllDocuments(renderDependencies(profile)).map(
        (document) =>
          document.toJSON() as {
            kind: string;
            metadata: { name: string; namespace?: string };
          },
      ),
    );
    expect(rendered[0].map((document) => document.kind)).toEqual(
      rendered[1].map((document) => document.kind),
    );
    for (const [index, profile] of (
      ["staging", "production"] as const
    ).entries()) {
      expect(rendered[index]).toHaveLength(6);
      for (const document of rendered[index]) {
        if (document.kind === "Namespace")
          expect(document.metadata.name).toBe(profiles[profile].namespace);
        else
          expect(document.metadata.namespace).toBe(profiles[profile].namespace);
      }
    }
  });

  test("refuses every Docker or Kubernetes context mismatch", () => {
    expect(() =>
      validateOrbStackContexts("orbstack", "orbstack"),
    ).not.toThrow();
    expect(() => validateOrbStackContexts("desktop-linux", "orbstack")).toThrow(
      "Refusing to mutate non-OrbStack targets",
    );
    expect(() =>
      validateOrbStackContexts("orbstack", "production-cluster"),
    ).toThrow("Refusing to mutate non-OrbStack targets");
  });
});
