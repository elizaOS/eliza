/**
 * Injects current-view state into the curated response prompt only for an
 * explicit navigation request in the current turn. Completed switches never
 * leak acknowledgement instructions into a later, unrelated message.
 */
import type { PipelineHookContextForPhase } from "@elizaos/core";
import { resolveIntentView } from "../actions/views-show.js";
import { userRequestMessageText } from "../params.js";

export const CURRENT_VIEW_HOOK_ID = "app-control:current-view-on-switch";

/**
 * Add `current_view` to the response provider set when this turn explicitly
 * asks to switch. `resolveIntentView` matches the early shortcut, so the
 * requested target remains authoritative while the renderer still reports the
 * previous view.
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
	// Security-unwrapped user words — the envelope must never look like an
	// imminent view-switch command.
	const text = userRequestMessageText(ctx.message);
	const imminent = resolveIntentView(text) != null;
	if (imminent) {
		ctx.providers.current = [...ctx.providers.current, "current_view"];
	}
}
