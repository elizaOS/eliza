/**
 * Rigid, deterministic, multilingual view-command matcher — the fast shortcut.
 *
 * The implementation moved to `@elizaos/shared/views/view-command-matcher` so
 * the container-free SHARED-tier cloud runtime (which boots zero plugins and so
 * cannot reach this plugin) resolves navigation intents from the SAME source as
 * the dedicated-runtime VIEWS action. This module re-exports it verbatim so
 * every existing in-plugin importer (`./view-command-matcher.js`) is unchanged.
 *
 * See packages/shared/src/views/view-command-matcher.ts for the matcher itself.
 */

export {
	__matcherData,
	MATCHER_VIEW_IDS,
	matchViewCommand,
} from "@elizaos/shared/views/view-command-matcher";
