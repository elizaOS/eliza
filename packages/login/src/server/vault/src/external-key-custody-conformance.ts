import {
  assertExternalKeyCustodyProviderV1,
  assertNoExternalPrivateKeyMaterial,
  type ExternalKeyCustodyProvider,
  type ExternalKeyHandleImportRequest,
  normalizeExternalKeyHandleRegistration,
} from "./external-key-custody";

export interface ExternalKeyCustodyV1ConformanceSubject {
  /** Return a fresh provider so the negative private-material probe is isolated. */
  createProvider(): ExternalKeyCustodyProvider;
  /** A real/public test handle that the provider can resolve without secret material. */
  validRegistrationRequest: ExternalKeyHandleImportRequest;
}

export interface ExternalKeyCustodyV1ConformanceResult {
  contractVersion: 1;
  providerId: string;
  signingAvailability: "not-supported" | "provider-signing";
}

/**
 * Reusable v1 provider conformance probe for operator-supplied custody adapters.
 *
 * This is intentionally framework-neutral: call it from Bun/Jest/Vitest and
 * expect it to resolve. It verifies the stable identity binding, no-export
 * invariant, registration normalization, provider-signing declaration, and
 * direct-provider rejection of nested private material.
 */
export async function runExternalKeyCustodyV1Conformance(
  subject: ExternalKeyCustodyV1ConformanceSubject,
): Promise<ExternalKeyCustodyV1ConformanceResult> {
  assertNoExternalPrivateKeyMaterial(subject.validRegistrationRequest);
  const provider = subject.createProvider();
  assertExternalKeyCustodyProviderV1(provider);

  const raw = await provider.registerKeyHandle(
    subject.validRegistrationRequest,
  );
  if (
    raw.tenantId !== subject.validRegistrationRequest.tenantId ||
    raw.agentId !== subject.validRegistrationRequest.agentId ||
    raw.chainFamily !== subject.validRegistrationRequest.chainFamily ||
    raw.address.toLowerCase() !==
      subject.validRegistrationRequest.address.toLowerCase() ||
    raw.handle.providerId !==
      subject.validRegistrationRequest.handle.providerId ||
    raw.handle.keyId !== subject.validRegistrationRequest.handle.keyId
  ) {
    throw new Error(
      "External custody v1 provider did not preserve the requested identity binding",
    );
  }
  const registration = normalizeExternalKeyHandleRegistration(
    subject.validRegistrationRequest,
    raw,
  );
  if (registration.exportablePrivateKey !== false) {
    throw new Error(
      "External custody v1 providers must never export private keys",
    );
  }
  if (
    registration.signingAvailability === "provider-signing" &&
    typeof provider.signTransaction !== "function"
  ) {
    throw new Error(
      "External custody v1 provider declares signing without signTransaction",
    );
  }
  const negativeProvider = subject.createProvider();
  const contaminated: ExternalKeyHandleImportRequest = {
    ...subject.validRegistrationRequest,
    metadata: {
      ...(subject.validRegistrationRequest.metadata ?? {}),
      nested: { privateKey: "conformance-probe-must-never-reach-provider" },
    },
  };
  let rejected = false;
  try {
    await negativeProvider.registerKeyHandle(contaminated);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(
      "External custody v1 provider accepted nested private key material",
    );
  }

  return {
    contractVersion: 1,
    providerId: provider.id,
    signingAvailability: registration.signingAvailability,
  };
}
