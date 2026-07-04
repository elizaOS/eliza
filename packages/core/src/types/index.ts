// Core types

export { logger } from "../logger";
// Utilities that are part of the public API.
export {
	addHeader,
	composePromptFromState,
	parseKeyValueXml, // audit:allowlist - retained for cloud/ XML evaluators; new prompts must use JSON
} from "../utils";
export * from "./access-context";
export * from "./agent";
// Channel configuration types for plugins
export * from "./channel-config";
// Chat pre-handler contract (generic pre-action dispatch extension point);
// the concrete registry lives in ../runtime/chat-pre-handler-registry.
export * from "./chat-pre-handler";
// Chat-command contract (CommandDefinition + CommandRegistryService); the
// concrete registry lives in @elizaos/plugin-commands and re-exports these.
export * from "./commands";
export * from "./components";
// Connector setup HTTP-route contract (distinct from ./setup onboarding wizard)
export * from "./connector-setup";
export * from "./contexts";
export * from "./database";
export * from "./documents";
export * from "./environment";
export * from "./evaluator";
export * from "./events";
export * from "./hook";
export * from "./interactions";
export * from "./memory";
export * from "./memory-storage";
export * from "./message-source";
export * from "./messaging";
export * from "./model";
export * from "./notification";
export * from "./pairing";
export * from "./payment";
export {
	PENDING_USER_ACTION_WEIGHT,
	type PendingUserAction,
	type PendingUserActionKind,
	type PendingUserActionOption,
	type PendingUserActionResolution,
	type PendingUserActionResolutionTarget,
	type RequiresUserResponse,
} from "./pending-user-action";
export * from "./pipeline-hooks";
export * from "./plugin";
export * from "./plugin-store";
export type { JsonPrimitive } from "./primitives";
export * from "./primitives";
export * from "./prompt-batcher";
export * from "./prompt-optimization-hooks";
export * from "./prompt-optimization-score-card";
export * from "./prompt-optimization-trace";
export * from "./prompts";
export * from "./runtime";
export * from "./schema";
export * from "./schema-builder";
export * from "./service";
export * from "./service-interfaces";
export * from "./settings";
// Setup types
export * from "./setup";
export * from "./shortcut";
export * from "./state";
export * from "./streaming";
export * from "./swarm-coordinator";
export * from "./task";
export * from "./tee";
export type { TestCase, TestSuite } from "./testing";
export * from "./tools";
export * from "./trigger";
export type {
	EnabledViewKinds,
	ViewKind,
	ViewKindBearer,
} from "./view-kind";
// Explicit value + type re-exports: a bare `export *` here gets tree-shaken to
// nothing because `plugin.ts` imports this module via `import type`, which leads
// esbuild/vite to treat the whole module as type-only and drop its runtime
// exports from the star re-export.
export {
	isAlwaysOnViewKind,
	isViewKindEnabled,
	isViewVisible,
	resolveViewKind,
	VIEW_KIND_META,
	VIEW_KINDS,
} from "./view-kind";
