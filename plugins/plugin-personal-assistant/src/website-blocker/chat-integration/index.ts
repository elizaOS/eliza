// Reader/writer support BLOCK action=list_active/release without owning the
// planner-facing action envelope.

export {
  BLOCK_RULES_MANAGED_BY,
  type OsBlockSyncResult,
  syncOsBlockToRules,
} from "./block-activator.js";
export {
  BLOCK_RULE_RECONCILE_INTERVAL_MS,
  BLOCK_RULE_RECONCILE_TASK_NAME,
  BLOCK_RULE_RECONCILE_TASK_TAGS,
  type BlockRuleReconcileResult,
  ensureBlockRuleReconcileTask,
  reconcileBlockRulesOnce,
  registerBlockRuleReconcilerWorker,
} from "./block-rule-reconciler.js";
export type {
  BlockRule,
  BlockRuleGateType,
  CreateBlockRuleInput,
} from "./block-rule-schema.js";
export {
  BLOCK_RULES_TABLE,
  BlockRuleRowError,
  rowToBlockRule,
} from "./block-rule-schema.js";
export { BlockRuleReader, BlockRuleWriter } from "./block-rule-service.js";
