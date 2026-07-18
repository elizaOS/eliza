/**
 * @module plugin-app-control/runtime/current-view-hook
 * @description The `compose_state_providers` hook that injects the `current_view`
 * state provider into the curated Stage-1 response state only when this turn
 * explicitly requests a view switch.
 *
 * Extracted from the plugin entry so the gating decision is unit-testable
 * without booting a runtime. See #8788.
 */
import {
	getUserMessageText,
	type PipelineHookContextForPhase,
} from "@elizaos/core";
import { resolveIntentView } from "../actions/views-show.js";

export const CURRENT_VIEW_HOOK_ID = "app-control:current-view-on-switch";

/**
 * Add `current_view` to the response provider set when this turn is a switch
 * turn. `resolveIntentView` matches the same way the early shortcut forces
 * VIEWS, so the previous renderer state cannot be mistaken for the requested
 * target. A switch recorded on an earlier turn never injects response context;
 * its action result already owned that turn's visible acknowledgement.
 *
 * Only augments the curated `onlyInclude` compose (the Stage-1 response/reply
 * state). The planner compose already includes `current_view` by default, so
 * non-switch turns pay no extra prompt/token cost.
 */
export function applyCurrentViewComposeHook(
	ctx: PipelineHookContextForPhase<"compose_state_providers">,
): void {
	if (!ctx.onlyInclude) return;
	if (ctx.providers.current.includes("current_view")) return;
	const text = getUserMessageText(ctx.message);
	const imminent = resolveIntentView(text) != null;
	if (imminent) {
		ctx.providers.current = [...ctx.providers.current, "current_view"];
	}
}
