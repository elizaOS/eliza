/**
 * @module plugin-app-control/runtime/current-view-hook
 * @description The `compose_state_providers` hook that injects the `current_view`
 * acknowledgement provider into the curated Stage-1 response state — but only on
 * turns where a view switch is happening or just happened.
 *
 * Extracted from the plugin entry so the gating decision is unit-testable
 * without booting a runtime. See #8788.
 */
import type { PipelineHookContextForPhase } from "@elizaos/core";
import { resolveIntentView } from "../actions/views-show.js";
import { hasFreshViewSwitch } from "./view-switch-signal.js";

export const CURRENT_VIEW_HOOK_ID = "app-control:current-view-on-switch";

/**
 * Add `current_view` to the response provider set when this turn is a switch
 * turn. A switch turn is:
 *  - an imminent explicit command — `resolveIntentView` matches the same way the
 *    early shortcut forces VIEWS, so the reply can acknowledge it same-turn; or
 *  - a switch the agent just executed in this room (VIEWS action / contextual
 *    evaluator recorded it via the process-local signal).
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
	const text =
		typeof ctx.message?.content?.text === "string"
			? ctx.message.content.text
			: "";
	const imminent = resolveIntentView(text) != null;
	const recent = hasFreshViewSwitch(ctx.message?.roomId);
	if (imminent || recent) {
		ctx.providers.current = [...ctx.providers.current, "current_view"];
	}
}
