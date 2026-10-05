/**
 * Reappraises the agent VM before confidential host operations. The measured
 * entry captures the local release authority independently of the remote
 * inference identity; no successful appraisal is cached across operations.
 */
import { ElizaError } from "@elizaos/core";
import { evaluateTeeBootGate } from "../services/tee-boot-gate.ts";
import { resolveTeeEvidenceProvider } from "../services/tee-evidence-provider.ts";

function rejected(): ElizaError {
  return new ElizaError(
    "Confidential host requires current local TEE admission",
    {
      code: "CONFIDENTIAL_LOCAL_ADMISSION_REJECTED",
    },
  );
}

/** Supply only the measured entry's environment, before importing runtime plugins. */
export async function createConfidentialLocalAdmission(
  input: Readonly<Record<string, string | undefined>>,
): Promise<() => Promise<true>> {
  const env = Object.freeze({ ...input });
  if (env.ELIZA_TEE_PRODUCTION_PROFILE !== "dstack-cpu") throw rejected();
  async function admit(): Promise<true> {
    try {
      // Re-resolve to enforce release expiry, pinned verifier bytes, and conflicts
      // with any provider subsequently registered in this process.
      const evidenceProvider = resolveTeeEvidenceProvider({ env });
      if (!evidenceProvider) throw rejected();
      const gate = await evaluateTeeBootGate({ env, evidenceProvider });
      if (
        !gate.teeConfigured ||
        !gate.required ||
        !gate.productionProfile ||
        !gate.secretsEnabled ||
        gate.decision?.trusted !== true
      )
        throw rejected();
      return true;
    } catch {
      // error-policy:J1 Admission errors expose neither control files nor quote contents.
      throw rejected();
    }
  }
  await admit();
  return admit;
}
