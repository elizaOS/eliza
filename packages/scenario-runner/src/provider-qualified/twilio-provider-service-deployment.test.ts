/**
 * Exercises Twilio provider-service role assembly with deterministic structural
 * collaborators. The harness proves isolation and fail-closed wiring without
 * loading credentials, contacting Twilio, or claiming provider evidence.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ProviderServiceDeploymentFactoryInput,
  ProviderServiceDeploymentRole,
} from "./provider-service-entrypoint.ts";
import type { ProviderServiceEd25519Signer } from "./provider-service-host.ts";
import {
  createTwilioProviderCanaryServiceDeploymentFactory,
  type TwilioProviderServiceDeploymentLoaders,
} from "./twilio-provider-service-deployment.ts";

const signer: ProviderServiceEd25519Signer = {
  keyId: "a".repeat(64),
  publicKeyPem: "public",
  async sign() {
    return "signature";
  },
};

function factoryInput(
  role: ProviderServiceDeploymentRole,
): ProviderServiceDeploymentFactoryInput {
  const roleConfig: ProviderServiceDeploymentFactoryInput["roleConfig"] =
    role === "controller"
      ? { role, controllerFamilies: ["twilio"] }
      : role === "observer" || role === "semantic-judge"
        ? {
            role,
            endpoint: `https://${role}.example/provider-canary/v1/service`,
            evidenceIdentity: {
              organizationId: `${role}.example`,
              administrativeDomain: `${role}.example`,
              publicKeyPem: "public",
              keyId: "a".repeat(64),
            },
          }
        : { role };
  return {
    role,
    roleConfig,
    responseIdentity: {
      organizationId: `${role}.example`,
      administrativeDomain: `${role}.example`,
      publicKeyPem: "public",
      keyId: "a".repeat(64),
    },
    servicePath: "/provider-canary/v1/service",
    secretPath: "/provider-canary/v1/secrets",
  };
}

function collaborators(
  events: string[],
): TwilioProviderServiceDeploymentLoaders {
  const mark =
    <T>(role: string, value: T) =>
    async () => {
      events.push(role);
      return value;
    };
  return {
    base: mark("base", {
      tls: { key: "key", cert: "cert" },
      responseSigner: signer,
      audit: vi.fn(),
    }),
    controller: mark("controller", {
      materials: { resolve: vi.fn() },
      credential: { resolve: vi.fn() },
      sendTwilioSms: vi.fn(),
      sendTwilioVoiceCall: vi.fn(),
      deployed: {
        acceptAuthenticatedIngress: vi.fn(),
        completeProviderEffect: vi.fn(),
        retrieveTrajectoryMaterial: vi.fn(),
        replayAuthenticatedIngress: vi.fn(),
        executeFailureProbe: vi.fn(),
        cleanupOrReconcile: vi.fn(),
      },
      cleanupRegistry: {
        prepare: vi.fn(),
        recordDispatched: vi.fn(),
        recordObserved: vi.fn(),
        recordReconciliationRequired: vi.fn(),
        resolve: vi.fn(),
      },
    }),
    observer: mark("observer", {
      materials: { resolve: vi.fn() },
      credential: { resolve: vi.fn() },
      boundary: {
        begin: vi.fn(),
        complete: vi.fn(),
        validateEvidence: vi.fn(),
        validateCleanup: vi.fn(),
      },
      evidenceSigner: signer,
    }),
    semanticJudge: mark("semantic-judge", {
      adapter: {
        evaluate: vi.fn(),
        validateEvidenceForSigning: vi.fn(),
      },
      evidenceSigner: signer,
    }),
    cleanup: mark("cleanup", {
      registry: {
        prepare: vi.fn(),
        recordDispatched: vi.fn(),
        recordObserved: vi.fn(),
        recordReconciliationRequired: vi.fn(),
        resolve: vi.fn(),
      },
      credential: { resolve: vi.fn() },
      cleanupTwilioProviderResource: vi.fn(),
    }),
    secretBroker: mark("secret-broker", { resolve: vi.fn() }),
  };
}

describe("Twilio provider service deployment assembly", () => {
  it.each([
    ["controller", "controllerAdapters"],
    ["observer", "observerAdapter"],
    ["semantic-judge", "semanticJudgeAdapter"],
    ["cleanup", "cleanupAdapter"],
    ["secret-broker", "secretBrokerAdapter"],
  ] as const)(
    "loads only the %s process collaborators",
    async (role, capability) => {
      const events: string[] = [];
      const deployment =
        await createTwilioProviderCanaryServiceDeploymentFactory(
          collaborators(events),
        )(factoryInput(role));
      expect(events).toEqual(["base", role]);
      expect(deployment.role).toBe(role);
      expect(deployment).toHaveProperty(capability);
      if (deployment.role === "controller") {
        expect(Object.keys(deployment.controllerAdapters)).toEqual(["twilio"]);
      }
    },
  );

  it("refuses controller processes that enable any non-Twilio family", async () => {
    const events: string[] = [];
    const input = factoryInput("controller");
    await expect(
      createTwilioProviderCanaryServiceDeploymentFactory(collaborators(events))(
        {
          ...input,
          roleConfig: {
            role: "controller",
            controllerFamilies: ["twilio", "slack"],
          },
        },
      ),
    ).rejects.toThrow("must enable only the Twilio family");
    expect(events).toEqual([]);
  });

  it("refuses a missing role loader before constructing a partial service", async () => {
    const events: string[] = [];
    const loaders = collaborators(events);
    delete loaders.cleanup;
    await expect(
      createTwilioProviderCanaryServiceDeploymentFactory(loaders)(
        factoryInput("cleanup"),
      ),
    ).rejects.toThrow("cleanup collaborator loader is unavailable");
    expect(events).toEqual(["base"]);
  });
});
