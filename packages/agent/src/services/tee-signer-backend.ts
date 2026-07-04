/**
 * SignerBackend decorator that gates every signing operation behind a TEE
 * attestation check. Before delegating signMessage/signTransaction to the
 * wrapped signer, it collects evidence from the configured TeeEvidenceProvider
 * and runs it through evaluateTeeEvidencePolicy; a non-trusted decision throws
 * so the underlying signer never sees the request. Address reads pass through
 * ungated, and an optional onDecision hook observes each policy verdict.
 */
import type {
  SignerBackend,
  UnsignedTransaction,
} from "./remote-signing-service.ts";
import type { TeeEvidenceProvider } from "./tee-evidence.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
  type TeeEvidencePolicyDecision,
} from "./tee-policy.ts";

export type TeeSignerBackendConfig = {
  signer: SignerBackend;
  evidenceProvider: TeeEvidenceProvider;
  policy: TeeEvidencePolicy;
  onDecision?: (decision: TeeEvidencePolicyDecision) => void;
};

export class TeeSignerBackend implements SignerBackend {
  constructor(private readonly config: TeeSignerBackendConfig) {}

  async getAddress(): Promise<string> {
    return await this.config.signer.getAddress();
  }

  async signMessage(message: string): Promise<string> {
    await this.requireTrustedTee();
    return await this.config.signer.signMessage(message);
  }

  async signTransaction(tx: UnsignedTransaction): Promise<string> {
    await this.requireTrustedTee();
    return await this.config.signer.signTransaction(tx);
  }

  private async requireTrustedTee(): Promise<void> {
    const evidence = await this.config.evidenceProvider.collectEvidence();
    const decision = evaluateTeeEvidencePolicy(evidence, this.config.policy);
    this.config.onDecision?.(decision);
    if (!decision.trusted) {
      throw new Error(
        `TEE signing policy rejected evidence: ${decision.detail ?? decision.reason}`,
      );
    }
  }
}
