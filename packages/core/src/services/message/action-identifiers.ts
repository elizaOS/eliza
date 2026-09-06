/** Resolves planner action identifiers and inline parameters against the registered runtime action catalog. */

import type { Action } from "../../types/components";
import type { IAgentRuntime } from "../../types/runtime";
import { isObjectRecord as isRecord } from "../../utils/type-guards";
import { normalizeActionIdentifier } from "./direct-action-heuristics";

export function canonicalPlannerControlActionName(
	actionName: string,
): string | null {
	const normalized = normalizeActionIdentifier(actionName);
	switch (normalized) {
		case "REPLY":
		case "RESPOND":
			return "REPLY";
		case "IGNORE":
			return "IGNORE";
		case "STOP":
			return "STOP";
		default:
			return null;
	}
}

export function isReplyActionIdentifier(actionName: string): boolean {
	return canonicalPlannerControlActionName(actionName) === "REPLY";
}

export function getPlannerActionObjectName(
	action: Record<string, unknown>,
): string {
	const rawName = action.name ?? action.action ?? action.actionName;
	return typeof rawName === "string" ? unwrapPlannerIdentifier(rawName) : "";
}

export function attachInlinePlannerActionParams(
	parsedPlanner: Record<string, unknown>,
	actionName: string,
	params: unknown,
): void {
	if (!actionName || !isRecord(params) || Object.keys(params).length === 0) {
		return;
	}

	const existingParams = parsedPlanner.params;
	const nextParams =
		isRecord(existingParams) && !Array.isArray(existingParams)
			? { ...existingParams }
			: {};
	nextParams[actionName.trim().toUpperCase()] = params;
	parsedPlanner.params = nextParams;
}

export function splitPlannerActionList(actionsText: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let inParams = false;
	let inJsonString = false;
	let jsonEscape = false;
	let jsonDepth = 0;
	const lower = actionsText.toLowerCase();

	for (let index = 0; index < actionsText.length; index += 1) {
		if (!inJsonString && lower.startsWith("<params", index)) {
			inParams = true;
			const close = actionsText.indexOf(">", index);
			if (close >= 0) {
				index = close;
			}
			continue;
		}
		if (!inJsonString && lower.startsWith("</params>", index)) {
			inParams = false;
			index += "</params>".length - 1;
			continue;
		}

		const char = actionsText[index];
		if (!inParams) {
			if (inJsonString) {
				if (jsonEscape) {
					jsonEscape = false;
				} else if (char === "\\") {
					jsonEscape = true;
				} else if (char === '"') {
					inJsonString = false;
				}
			} else if (jsonDepth > 0 && char === '"') {
				inJsonString = true;
			} else if (char === "{") {
				jsonDepth += 1;
			} else if (char === "}" && jsonDepth > 0) {
				jsonDepth -= 1;
			}
		}

		if (char === "," && !inParams && jsonDepth === 0 && !inJsonString) {
			parts.push(actionsText.slice(start, index));
			start = index + 1;
		}
	}

	parts.push(actionsText.slice(start));
	return parts;
}

export function parseInlinePlannerParams(
	value: string,
): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : null;
	} catch {
		// error-policy:J3 inline planner parameters are untrusted model input;
		// malformed JSON is an explicit invalid result.
		return null;
	}
}

export function splitInlinePlannerParams(
	value: string,
): { name: string; body: string } | null {
	const lower = value.toLowerCase();
	let open = lower.indexOf("<params");
	while (open >= 0) {
		const boundary = lower[open + "<params".length];
		if (!boundary || !/[a-z0-9_]/i.test(boundary)) break;
		open = lower.indexOf("<params", open + "<params".length);
	}
	if (open < 0) return null;
	const bodyStart = value.indexOf(">", open + "<params".length);
	if (bodyStart < 0) return null;
	const close = lower.indexOf("</params>", bodyStart + 1);
	if (close < 0 || value.slice(close + "</params>".length).trim() !== "") {
		return null;
	}
	return {
		name: value.slice(0, open).trimEnd(),
		body: value.slice(bodyStart + 1, close),
	};
}

export function extractInlinePlannerActionParams(value: string): {
	name: string;
	params?: Record<string, unknown>;
} {
	const inlineJsonMatch = value.match(
		/^\s*([A-Z][A-Z0-9_:-]*)\s+(\{[\s\S]*\})\s*$/i,
	);
	if (inlineJsonMatch) {
		const params = parseInlinePlannerParams(inlineJsonMatch[2]);
		if (params) {
			return {
				name: unwrapPlannerIdentifier(inlineJsonMatch[1]),
				params,
			};
		}
	}

	const inlineParams = splitInlinePlannerParams(value);
	if (inlineParams) {
		return {
			name: unwrapPlannerIdentifier(inlineParams.name),
			params: parseInlinePlannerParams(inlineParams.body) ?? undefined,
		};
	}

	return { name: unwrapPlannerIdentifier(value) };
}

export function extractPlannerActionNames(
	parsedPlanner: Record<string, unknown>,
): string[] {
	return (() => {
		if (typeof parsedPlanner.actions === "string") {
			return splitPlannerActionList(parsedPlanner.actions)
				.map((action) => {
					const { name, params } = extractInlinePlannerActionParams(
						String(action),
					);
					attachInlinePlannerActionParams(parsedPlanner, name, params);
					return name;
				})
				.filter((action) => action.length > 0);
		}
		if (Array.isArray(parsedPlanner.actions)) {
			return parsedPlanner.actions
				.map((action) => {
					if (isRecord(action)) {
						const actionName = getPlannerActionObjectName(action);
						attachInlinePlannerActionParams(
							parsedPlanner,
							actionName,
							action.params,
						);
						return actionName;
					}
					const { name, params } = extractInlinePlannerActionParams(
						String(action),
					);
					attachInlinePlannerActionParams(parsedPlanner, name, params);
					return name;
				})
				.filter((action) => action.length > 0);
		}
		return [];
	})();
}

export function _normalizePlannerActions(
	parsedPlanner: Record<string, unknown>,
	runtime: IAgentRuntime,
): string[] {
	const normalizedActions = extractPlannerActionNames(parsedPlanner);

	const finalActions =
		!runtime.isActionPlanningEnabled() && normalizedActions.length > 1
			? [normalizedActions[0]]
			: normalizedActions;

	const actionLookup = buildRuntimeActionLookup(runtime);
	const validActions = finalActions.flatMap((actionName) => {
		const normalized = normalizeActionIdentifier(actionName);
		if (!normalized) {
			return [];
		}

		const controlActionName = canonicalPlannerControlActionName(actionName);
		if (controlActionName) {
			return [controlActionName];
		}

		const resolvedAction = resolveRuntimeAction(actionLookup, actionName);
		if (resolvedAction) {
			return [resolvedAction.name];
		}

		runtime.logger.warn(
			{
				src: "service:message",
				actionName,
			},
			"Dropping unknown planner action",
		);
		return [];
	});

	if (validActions.length > 0) {
		return validActions;
	}

	const replyText =
		typeof parsedPlanner.text === "string" ? parsedPlanner.text.trim() : "";
	if (replyText.length > 0) return ["REPLY"];

	// Fallthrough: no valid action, no text. By the time the planner ran,
	// the shouldRespond gate already decided the bot needed to respond, so
	// landing on IGNORE here means the user sees silence even though the
	// framework chose to engage. That reads as "the bot is broken" to the
	// operator. Coerce to REPLY so the agent's reply handler emits at
	// least a short clarifying message (e.g. "not sure what you want — can
	// you be more specific?"). The only downside is an extra reply turn
	// on rare cases where the LLM emitted a totally empty response; that's
	// a better failure mode than dead silence.
	return ["REPLY"];
}

export function resolvePlannerActionName(
	runtime: Pick<IAgentRuntime, "actions" | "logger">,
	actionLookup: Map<string, Action> | undefined,
	actionName: string,
	options?: { strict?: boolean },
): string[] {
	const lookup =
		actionLookup ?? buildRuntimeActionLookup(runtime as IAgentRuntime);
	const resolved = resolvePlannerActionNameFromLookup(lookup, actionName);
	if (resolved.length > 0) {
		return resolved;
	}

	// In strict mode don't fall back to the full registry — LLM aliases
	// like WRITE -> FILE would defeat a candidateActions narrow.
	if (actionLookup && !options?.strict) {
		const runtimeResolved = resolvePlannerActionNameFromLookup(
			buildRuntimeActionLookup(runtime as IAgentRuntime),
			actionName,
		);
		if (runtimeResolved.length > 0) {
			return runtimeResolved;
		}
	}

	runtime.logger.warn(
		{
			src: "service:message",
			actionName,
		},
		"Dropping unknown planner action",
	);
	return [];
}

export function resolvePlannerActionNameFromLookup(
	lookup: Map<string, Action>,
	actionName: string,
): string[] {
	const normalized = normalizeActionIdentifier(actionName);
	if (!normalized) {
		return [];
	}

	const controlActionName = canonicalPlannerControlActionName(actionName);
	if (controlActionName) {
		return [controlActionName];
	}

	const resolvedAction = resolveRuntimeAction(lookup, actionName);
	if (resolvedAction) {
		return [resolvedAction.name];
	}

	return [];
}

export function unwrapPlannerIdentifier(value: string): string {
	const trimmed = value
		.trim()
		.replace(/^(?:[-*]|\d+[.)])\s+/, "")
		.replace(/^["'`]+|["'`]+$/g, "");
	if (!trimmed) {
		return "";
	}
	return trimmed;
}

export function buildRuntimeActionLookup(runtime: {
	actions?: readonly Action[];
}): Map<string, Action> {
	const actionMap = new Map<string, Action>();
	const actions = runtime.actions ?? [];

	for (const action of actions) {
		const normalized = normalizeActionIdentifier(action.name);
		if (!normalized || actionMap.has(normalized)) {
			continue;
		}
		actionMap.set(normalized, action);
	}

	for (const action of actions) {
		for (const simile of action.similes ?? []) {
			const normalized = normalizeActionIdentifier(simile);
			if (!normalized || actionMap.has(normalized)) {
				continue;
			}
			actionMap.set(normalized, action);
		}
	}

	return actionMap;
}

export function resolveRuntimeAction(
	actionLookup: Map<string, Action>,
	actionName: string,
): Action | undefined {
	const normalized = normalizeActionIdentifier(actionName);
	if (!normalized) {
		return undefined;
	}

	return actionLookup.get(normalized);
}
