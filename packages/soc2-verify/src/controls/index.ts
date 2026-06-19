import type { Check } from "../types.js";
import {
  branchProtectionScript,
  codeownersPresent,
  securityMd,
} from "./codeowners.js";
import {
  dbSslmode,
  kmsAdoption,
  piiEncryptionColumns,
  softDeleteColumns,
  auditLogRetention,
} from "./db-and-pii.js";
import {
  firmwareSigningScript,
  pluginSignatureVerify,
  subagentEnvAllowlist,
} from "./plugins.js";
import {
  actionsPinnedBySha,
  gitleaksWorkflow,
  noCommittedSecrets,
  workflowPermissions,
} from "./supply-chain.js";
import { alertRulesPresent, monitoringConfig } from "./observability.js";
import { k8sSecurityContext, networkPoliciesPresent } from "./k8s.js";
import { auditActionsComprehensive } from "./audit-actions.js";
import { modelArtifactSigning, trainingConsentBasis } from "./training.js";
import {
  auditDispatcherEmits,
  auditRedaction,
  kmsHmacRoundtrip,
  kmsRoundtrip,
  kmsSignatureRoundtrip,
} from "./dynamic.js";

export const ALL_CHECKS: readonly Check[] = [
  // CC6 — Access
  codeownersPresent,
  branchProtectionScript,
  dbSslmode,

  // CC6.8 — Integrity / supply chain
  pluginSignatureVerify,
  subagentEnvAllowlist,
  firmwareSigningScript,

  // CC4 — Monitoring
  auditActionsComprehensive,
  auditDispatcherEmits,
  auditRedaction,

  // CC6.6 — Infra hardening
  k8sSecurityContext,
  networkPoliciesPresent,

  // CC7 — Operations / monitoring
  monitoringConfig,
  alertRulesPresent,

  // CC8 — SDLC / Supply chain
  gitleaksWorkflow,
  noCommittedSecrets,
  workflowPermissions,
  actionsPinnedBySha,

  // CC9 — Vendor / external disclosure
  securityMd,

  // C1 — Confidentiality
  kmsAdoption,
  piiEncryptionColumns,
  softDeleteColumns,
  auditLogRetention,
  kmsRoundtrip,
  kmsHmacRoundtrip,
  kmsSignatureRoundtrip,

  // PI1 — Processing integrity
  trainingConsentBasis,
  modelArtifactSigning,
];
