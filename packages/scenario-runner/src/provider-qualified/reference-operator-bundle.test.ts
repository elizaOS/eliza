/**
 * Exercises the reference operator bundle's closed deployment inventory and
 * authorization-after-secret-resolution boundary without contacting provider
 * or evidence services.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import { providerCanaryControllerContract } from "./controller-registry.ts";
import { providerServiceIdentitySha256 } from "./provider-service-response-envelope.ts";
import { providerObserverKeyId } from "./qualification.ts";
import {
  createReferenceExternalProviderCanaryCapabilities,
  parseReferenceOperatorConfig,
  REFERENCE_OPERATOR_CONFIG_SCHEMA,
} from "./reference-operator-bundle.ts";
import { remoteEvidenceSignerIdentitySha256 } from "./remote-evidence-signer-client.ts";

function publicKey(): { pem: string; keyId: string } {
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return { pem, keyId: providerObserverKeyId(pem) };
}

function fixtureConfig(): Record<string, unknown> {
  const observerKey = publicKey();
  const judgeKey = publicKey();
  const controllerKey = publicKey();
  const cleanupKey = publicKey();
  const secretKey = publicKey();
  const observerEndpoint = "https://observer.example.test/v1/evidence";
  const judgeEndpoint = "https://judge.example.test/v1/evidence";
  const responseFields = (
    endpoint: string,
    administrativeDomain: string,
    key: ReturnType<typeof publicKey>,
  ) => ({
    responseOrganizationId: administrativeDomain,
    responsePublicKeyPem: key.pem,
    responseKeyId: key.keyId,
    responseServiceIdentitySha256: providerServiceIdentitySha256({
      endpoint,
      organizationId: administrativeDomain,
      administrativeDomain,
      keyId: key.keyId,
    }),
  });
  const deployments = Object.fromEntries(
    PROVIDER_CANARY_SCENARIO_IDS.map((scenarioId) => {
      const contract = providerCanaryControllerContract(scenarioId);
      return [
        scenarioId,
        {
          scenarioId,
          operationKind: contract.operationKind,
          controllerFamily: contract.controllerFamily,
          observerAttestationStatementSha256: "a".repeat(64),
          controller: {
            endpoint: "https://controller.example.test/v1/execute",
            administrativeDomain: "controller-operator",
            bearerSecretRef: "canary/controller-token",
            ...responseFields(
              "https://controller.example.test/v1/execute",
              "controller-operator",
              controllerKey,
            ),
          },
          observer: {
            endpoint: observerEndpoint,
            administrativeDomain: "independent-observer",
            bearerSecretRef: "canary/observer-token",
            organizationId: "independent-observer",
            publicKeyPem: observerKey.pem,
            keyId: observerKey.keyId,
            serviceIdentitySha256: remoteEvidenceSignerIdentitySha256({
              role: "observer",
              endpoint: observerEndpoint,
              organizationId: "independent-observer",
              keyId: observerKey.keyId,
            }),
            ...responseFields(
              observerEndpoint,
              "independent-observer",
              observerKey,
            ),
          },
          semanticJudge: {
            endpoint: judgeEndpoint,
            administrativeDomain: "independent-judge",
            bearerSecretRef: "canary/judge-token",
            organizationId: "independent-judge",
            publicKeyPem: judgeKey.pem,
            keyId: judgeKey.keyId,
            serviceIdentitySha256: remoteEvidenceSignerIdentitySha256({
              role: "semantic-judge",
              endpoint: judgeEndpoint,
              organizationId: "independent-judge",
              keyId: judgeKey.keyId,
            }),
            ...responseFields(judgeEndpoint, "independent-judge", judgeKey),
          },
          cleanup: {
            endpoint: "https://cleanup.example.test/v1/cleanup",
            administrativeDomain: "cleanup-operator",
            bearerSecretRef: "canary/cleanup-token",
            ...responseFields(
              "https://cleanup.example.test/v1/cleanup",
              "cleanup-operator",
              cleanupKey,
            ),
          },
          pinnedObserverPublicKeysPem: [observerKey.pem],
          pinnedDeploymentAttestationIssuerPublicKeysPem: [observerKey.pem],
          pinnedSemanticJudgePublicKeysPem: [judgeKey.pem],
        },
      ];
    }),
  );
  return {
    schema: REFERENCE_OPERATOR_CONFIG_SCHEMA,
    manifestAuthorityOrganizationId: "manifest-authority",
    secretBrokerEndpoint: "https://secrets.example.test/v1/resolve",
    secretBrokerAdministrativeDomain: "secret-broker",
    secretBrokerOrganizationId: "secret-broker",
    secretBrokerPublicKeyPem: secretKey.pem,
    secretBrokerKeyId: secretKey.keyId,
    secretBrokerServiceIdentitySha256: providerServiceIdentitySha256({
      endpoint: "https://secrets.example.test/v1/resolve",
      organizationId: "secret-broker",
      administrativeDomain: "secret-broker",
      keyId: secretKey.keyId,
    }),
    deployments,
  };
}

const factoryInput = {
  scenarioId: "provider.gmail.confirmed-send",
  operationKind: "gmail.email-send" as const,
  runId: "operator-run-001",
  manifestSha256: "a".repeat(64),
  repositorySha: "b".repeat(40),
  deploymentSha: "c".repeat(64),
};

describe("reference operator bundle", () => {
  it("accepts only the complete canonical 13-scenario deployment inventory", () => {
    const parsed = parseReferenceOperatorConfig(fixtureConfig());
    expect(Object.keys(parsed.deployments)).toEqual(
      PROVIDER_CANARY_SCENARIO_IDS,
    );
    expect(
      parsed.deployments["provider.twilio-voice.confirmed-call"],
    ).toMatchObject({
      operationKind: "twilio.call-create",
      controllerFamily: "twilio",
    });
  });

  it("rejects a missing deployment before asking the secret resolver", async () => {
    const config = fixtureConfig();
    delete (config.deployments as Record<string, unknown>)[
      "provider.x-dm.confirmed-send"
    ];
    const resolve = vi.fn();
    await expect(
      createReferenceExternalProviderCanaryCapabilities(factoryInput, {
        config,
        secretResolver: { resolve },
      }),
    ).rejects.toThrow("config.deployments has an unsupported shape");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("validates non-selected deployment pins before secret resolution", async () => {
    const config = fixtureConfig();
    const deployment = (
      config.deployments as Record<string, Record<string, unknown>>
    )["provider.x-dm.confirmed-send"];
    (deployment.observer as Record<string, unknown>).publicKeyPem = "not-a-key";
    const resolve = vi.fn();
    await expect(
      createReferenceExternalProviderCanaryCapabilities(factoryInput, {
        config,
        secretResolver: { resolve },
      }),
    ).rejects.toThrow("must be a valid public key");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("requires an explicit observer workload-attestation statement binding", () => {
    const missing = fixtureConfig();
    delete (missing.deployments as Record<string, Record<string, unknown>>)[
      "provider.gmail.confirmed-send"
    ].observerAttestationStatementSha256;
    expect(() => parseReferenceOperatorConfig(missing)).toThrow(
      "unsupported shape",
    );

    const malformed = fixtureConfig();
    (malformed.deployments as Record<string, Record<string, unknown>>)[
      "provider.gmail.confirmed-send"
    ].observerAttestationStatementSha256 = "not-a-digest";
    expect(() => parseReferenceOperatorConfig(malformed)).toThrow(
      "must be lowercase SHA-256",
    );
  });

  it("resolves only the selected deployment tokens after complete static preflight", async () => {
    const resolve = vi.fn(
      async ({ secretRefs }: { secretRefs: readonly string[] }) =>
        Object.freeze(
          Object.fromEntries(secretRefs.map((ref) => [ref, `token:${ref}`])),
        ),
    );
    const config = fixtureConfig();
    const bundle = await createReferenceExternalProviderCanaryCapabilities(
      factoryInput,
      {
        config,
        secretResolver: { resolve },
      },
    );
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]?.[0].secretRefs).toEqual([
      "canary/cleanup-token",
      "canary/controller-token",
      "canary/judge-token",
      "canary/observer-token",
    ]);
    expect(Object.keys(bundle.capabilities).sort()).toEqual([
      "cleanup",
      "ingress",
      "observer",
      "semanticJudge",
      "trajectories",
    ]);
    expect(bundle.cleanupPublicKeyPem).toBe(
      parseReferenceOperatorConfig(config).deployments[
        "provider.gmail.confirmed-send"
      ].observer.publicKeyPem,
    );
  });

  it("rejects accessor-bearing factory input before reading config or secrets", async () => {
    const resolve = vi.fn();
    const malicious = Object.defineProperty(
      {
        operationKind: "gmail.email-send",
        runId: "run",
        manifestSha256: "a".repeat(64),
        repositorySha: "b".repeat(40),
        deploymentSha: "c".repeat(64),
      },
      "scenarioId",
      { enumerable: true, get: () => "provider.gmail.confirmed-send" },
    );
    await expect(
      createReferenceExternalProviderCanaryCapabilities(
        malicious as typeof factoryInput,
        { config: fixtureConfig(), secretResolver: { resolve } },
      ),
    ).rejects.toThrow(
      "factoryInput.scenarioId must be an enumerable data property",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects a cross-scenario operation before configuration or secrets", async () => {
    const resolve = vi.fn();
    await expect(
      createReferenceExternalProviderCanaryCapabilities(
        { ...factoryInput, operationKind: "slack.message-send" },
        { config: fixtureConfig(), secretResolver: { resolve } },
      ),
    ).rejects.toThrow("operation does not match the canonical scenario");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects accessor-bearing configuration before canonicalization", () => {
    const config = fixtureConfig();
    Object.defineProperty(config, "schema", {
      enumerable: true,
      get: () => REFERENCE_OPERATOR_CONFIG_SCHEMA,
    });
    expect(() => parseReferenceOperatorConfig(config)).toThrow(
      "config.schema must be an enumerable data property",
    );
  });

  it("rejects evaluator/signer identity splits and shared operational origins", () => {
    const config = fixtureConfig();
    const deployment = (
      config.deployments as Record<string, Record<string, unknown>>
    )["provider.gmail.confirmed-send"];
    const observer = deployment.observer as Record<string, unknown>;
    observer.administrativeDomain = "unbound-observer-domain";
    expect(() => parseReferenceOperatorConfig(config)).toThrow(
      "response organization must own its administrative domain",
    );

    const sharedOrigin = fixtureConfig();
    const sharedDeployment = (
      sharedOrigin.deployments as Record<string, Record<string, unknown>>
    )["provider.gmail.confirmed-send"];
    const cleanup = sharedDeployment.cleanup as Record<string, unknown>;
    cleanup.endpoint = "https://controller.example.test/v1/cleanup";
    cleanup.responseServiceIdentitySha256 = providerServiceIdentitySha256({
      endpoint: String(cleanup.endpoint),
      organizationId: String(cleanup.responseOrganizationId),
      administrativeDomain: String(cleanup.administrativeDomain),
      keyId: String(cleanup.responseKeyId),
    });
    expect(() => parseReferenceOperatorConfig(sharedOrigin)).toThrow(
      "origins must be distinct",
    );
  });

  it("requires observer and judge to use distinct signing keys", () => {
    const config = fixtureConfig();
    const deployment = (
      config.deployments as Record<string, Record<string, unknown>>
    )["provider.gmail.confirmed-send"];
    const observer = deployment.observer as Record<string, unknown>;
    const judge = deployment.semanticJudge as Record<string, unknown>;
    judge.publicKeyPem = observer.publicKeyPem;
    judge.keyId = observer.keyId;
    judge.serviceIdentitySha256 = remoteEvidenceSignerIdentitySha256({
      role: "semantic-judge",
      endpoint: judge.endpoint as string,
      organizationId: judge.organizationId as string,
      keyId: judge.keyId as string,
    });
    deployment.pinnedSemanticJudgePublicKeysPem = [observer.publicKeyPem];
    expect(() => parseReferenceOperatorConfig(config)).toThrow(
      "observer and semantic judge signing keys must be distinct",
    );
  });

  it("never accepts private signing material in deployment configuration", () => {
    const config = fixtureConfig();
    const deployment = (
      config.deployments as Record<string, Record<string, unknown>>
    )["provider.gmail.confirmed-send"];
    (deployment.observer as Record<string, unknown>).publicKeyPem =
      "-----BEGIN PRIVATE KEY-----\nforbidden\n-----END PRIVATE KEY-----\n";
    expect(() => parseReferenceOperatorConfig(config)).toThrow(
      "contains private key material",
    );
  });

  it("rejects signing material in the separately administered cleanup service", () => {
    const config = fixtureConfig();
    const deployment = (
      config.deployments as Record<string, Record<string, unknown>>
    )["provider.gmail.confirmed-send"];
    const substitute = publicKey();
    Object.assign(deployment.cleanup as Record<string, unknown>, {
      publicKeyPem: substitute.pem,
      keyId: substitute.keyId,
    });
    expect(() => parseReferenceOperatorConfig(config)).toThrow(
      "cleanup has an unsupported shape",
    );
  });
});
