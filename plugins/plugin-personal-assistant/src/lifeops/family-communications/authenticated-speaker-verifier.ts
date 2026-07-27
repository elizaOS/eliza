/**
 * Short-lived speaker attestations for the explicit runtime-authenticated
 * message ingress. This is not acoustic biometrics: it binds a connector-
 * attributed message principal to a proposal bundle, while raw transcripts and
 * unauthenticated voice-observer events remain unable to mint attestations.
 */
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import {
  type IAgentRuntime,
  type Memory,
  stableStringify,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { resolveAuthenticatedFamilyPrincipal } from "./production-wiring.js";
import {
  FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE,
  FamilyVoiceSpeakerVerifierRuntimeService,
} from "./service.js";
import {
  FamilyCommunicationsError,
  type VerifiedVoiceSpeaker,
  type VoiceSpeakerAttestation,
} from "./types.js";

const AUTHENTICATED_MESSAGE_ISSUER = "elizaos.runtime-authenticated-message.v1";
const ATTESTATION_TTL_MS = 2 * 60 * 1000;

interface IssuedAttestation {
  readonly expiresAtMs: number;
  readonly proof: string;
  readonly principalEntityId: string;
}

export interface AuthenticatedMessageSpeakerAttestation {
  readonly principalEntityId: string;
  readonly capturedAt: string;
  readonly attestation: VoiceSpeakerAttestation;
}

function unsignedAttestation(
  attestation: VoiceSpeakerAttestation,
): Omit<VoiceSpeakerAttestation, "proof"> {
  const { proof: _proof, ...unsigned } = attestation;
  return unsigned;
}

export class AuthenticatedRuntimeSpeakerVerifierService extends FamilyVoiceSpeakerVerifierRuntimeService {
  static override serviceType = FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE;

  override capabilityDescription =
    "Short-lived family speaker binding from authenticated runtime message identity";

  private readonly secret = randomBytes(32);
  private readonly issued = new Map<string, IssuedAttestation>();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new FamilyCommunicationsError(
        "AuthenticatedRuntimeSpeakerVerifierService requires a runtime",
        "FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_UNAVAILABLE",
      );
    }
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<AuthenticatedRuntimeSpeakerVerifierService> {
    return new AuthenticatedRuntimeSpeakerVerifierService(runtime);
  }

  private proofFor(
    attestation: Omit<VoiceSpeakerAttestation, "proof">,
  ): string {
    return createHmac("sha256", this.secret)
      .update(stableStringify(attestation))
      .digest("base64url");
  }

  async issueForAuthenticatedMessage(
    message: Memory,
  ): Promise<AuthenticatedMessageSpeakerAttestation> {
    const principalEntityId = await resolveAuthenticatedFamilyPrincipal(
      this.runtime,
      message,
    );
    if (!principalEntityId) {
      throw new FamilyCommunicationsError(
        "A verified runtime message principal is required to issue a speaker attestation",
        "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
      );
    }
    if (!message.id) {
      throw new FamilyCommunicationsError(
        "Authenticated message capture requires a persisted message ID",
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      );
    }
    const capturedAt = new Date(message.createdAt ?? Date.now()).toISOString();
    const unsigned: Omit<VoiceSpeakerAttestation, "proof"> = {
      schemaVersion: "voice-speaker-attestation.v1",
      attestationId: `runtime-attestation-${randomUUID()}`,
      issuer: AUTHENTICATED_MESSAGE_ISSUER,
      profileId: `runtime-principal:${principalEntityId}`,
      imprintClusterId: `runtime-message:${message.id}`,
      claimedEntityId: principalEntityId,
      bindingRevision: 1,
      matchConfidence: 1,
      observedAt: capturedAt,
    };
    const proof = this.proofFor(unsigned);
    this.issued.set(unsigned.attestationId, {
      expiresAtMs: Date.now() + ATTESTATION_TTL_MS,
      proof,
      principalEntityId,
    });
    return {
      principalEntityId,
      capturedAt,
      attestation: { ...unsigned, proof },
    };
  }

  async verify(
    attestation: VoiceSpeakerAttestation,
  ): Promise<VerifiedVoiceSpeaker> {
    const issued = this.issued.get(attestation.attestationId);
    if (
      attestation.issuer !== AUTHENTICATED_MESSAGE_ISSUER ||
      !issued ||
      issued.expiresAtMs <= Date.now() ||
      attestation.claimedEntityId === null ||
      attestation.claimedEntityId !== issued.principalEntityId
    ) {
      return { kind: "unverified", reason: "invalid_proof" };
    }
    const expectedProof = this.proofFor(unsignedAttestation(attestation));
    const expectedBytes = Buffer.from(expectedProof);
    const actualBytes = Buffer.from(attestation.proof);
    if (
      expectedBytes.length !== actualBytes.length ||
      !timingSafeEqual(expectedBytes, actualBytes) ||
      issued.proof !== expectedProof
    ) {
      return { kind: "unverified", reason: "invalid_proof" };
    }
    const graph = resolveKnowledgeGraphService(this.runtime);
    if (!graph) {
      throw new FamilyCommunicationsError(
        "KnowledgeGraphService is required to verify a family principal",
        "FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_UNAVAILABLE",
        { agentId: this.runtime.agentId },
      );
    }
    const entityStore = graph.getEntityStore(this.runtime.agentId);
    const entity =
      issued.principalEntityId === SELF_ENTITY_ID
        ? await entityStore.ensureSelf()
        : await entityStore.get(issued.principalEntityId);
    if (!entity) return { kind: "unverified", reason: "revoked_binding" };
    return {
      kind: "verified",
      entityId: issued.principalEntityId,
      enrolled: true,
      profileBindingVerified: true,
      matchConfidence: 1,
      bindingRevision: 1,
    };
  }

  override async stop(): Promise<void> {
    this.issued.clear();
    this.secret.fill(0);
  }
}

export function getAuthenticatedRuntimeSpeakerVerifier(
  runtime: IAgentRuntime,
): AuthenticatedRuntimeSpeakerVerifierService | null {
  const service =
    runtime.getService<AuthenticatedRuntimeSpeakerVerifierService>(
      FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_SERVICE,
    );
  return service instanceof AuthenticatedRuntimeSpeakerVerifierService
    ? service
    : null;
}

export async function issueAuthenticatedMessageSpeakerAttestation(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<AuthenticatedMessageSpeakerAttestation> {
  const service = getAuthenticatedRuntimeSpeakerVerifier(runtime);
  if (!service) {
    throw new FamilyCommunicationsError(
      "Authenticated runtime speaker verifier is unavailable",
      "FAMILY_COMMUNICATIONS_SPEAKER_VERIFIER_UNAVAILABLE",
      { agentId: runtime.agentId },
    );
  }
  return service.issueForAuthenticatedMessage(message);
}
