/**
 * `inboxTriage` provider — re-export shim.
 *
 * The provider moved to `@elizaos/plugin-inbox`, which PA auto-registers via
 * `ensureLifeOpsInboxPluginRegistered` during `init()` — i.e. BEFORE PA's own
 * provider array is processed, so the plugin-inbox registration always won the
 * runtime's duplicate-name dedup and the old local copy here was dead code at
 * runtime. This shim keeps the historical import path resolving to the one
 * live implementation.
 *
 * The moved provider is owner-only (`roleGate.minRole: OWNER` + hasOwnerAccess
 * gate), so the LifeOps egress redaction the old copy carried was always an
 * owner-context pass-through — the ported provider is observably identical.
 */

export {
  default,
  inboxTriageProvider,
} from "@elizaos/plugin-inbox/providers/inbox-triage";
