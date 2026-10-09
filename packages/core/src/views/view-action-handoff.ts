/** Pure completed-action handoff parsing shared by product renderers. */
import { normalizeCompletedActionHandoffId } from "../events.ts";
import { parseViewInteractionClientId } from "./view-interact-protocol.ts";

export interface ViewActionHandoff {
	viewId: string;
	viewPath?: string;
	subview?: string;
	completedActionDelivered?: true;
	completedActionHandoffId?: string;
	navigationPrepared?: true;
	navigationBinding?: {
		requestId: string;
		clientId: string;
		viewId: string;
		viewType: "gui";
		installationId: string;
	};
}
function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function readOwnValue(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}
export function findViewActionHandoff(
	actionResults: readonly unknown[] | undefined,
): ViewActionHandoff | null {
	if (!Array.isArray(actionResults)) return null;
	for (let index = actionResults.length - 1; index >= 0; index--) {
		const result = actionResults[index];
		if (readOwnValue(result, "success") !== true) {
			continue;
		}
		const actionName = readString(
			readOwnValue(result, "actionName"),
		)?.toUpperCase();
		const values = readOwnValue(result, "values");
		const mode = readString(readOwnValue(values, "mode"))?.toLowerCase();
		const subaction = readString(
			readOwnValue(values, "subaction"),
		)?.toLowerCase();
		const targetId = readString(
			readOwnValue(values, "targetId"),
		)?.toLowerCase();
		const viewId = readString(readOwnValue(values, "viewId"));
		const isViewsHandoff =
			actionName === "VIEWS" && (mode === "show" || mode === "open");
		const isAppBrowserHandoff =
			actionName === "APP" && mode === "launch" && viewId === "browser";
		const isBrowserWorkspaceHandoff =
			(actionName === "BROWSER" ||
				actionName === "BROWSER_OPEN" ||
				actionName === "BROWSER_NAVIGATE" ||
				actionName === "BROWSER_SHOW") &&
			targetId === "workspace" &&
			(subaction === "open" ||
				subaction === "navigate" ||
				subaction === "show") &&
			viewId === "browser";
		if (
			(isViewsHandoff || isAppBrowserHandoff || isBrowserWorkspaceHandoff) &&
			viewId
		) {
			const actionUrl = readString(readOwnValue(values, "url"));
			const declaredViewPath = readString(readOwnValue(values, "viewPath"));
			// Native mobile browser tabs are intentionally client-owned, while the
			// browser action executes in the remote workspace. Carry the verified
			// destination through the existing browser deep link so the mounted
			// native view can mirror the completed action as well.
			const viewPath =
				isBrowserWorkspaceHandoff && actionUrl
					? `/browser?browse=${encodeURIComponent(actionUrl)}`
					: declaredViewPath;
			const subview = readString(readOwnValue(values, "subview"));
			const completedActionHandoffId = normalizeCompletedActionHandoffId(
				readOwnValue(values, "completedActionHandoffId"),
			);
			let navigationBinding: ViewActionHandoff["navigationBinding"];
			if (readOwnValue(values, "navigationPrepared") === true) {
				const binding = readOwnValue(values, "navigationBinding");
				const requestId = normalizeCompletedActionHandoffId(
					readOwnValue(binding, "requestId"),
				);
				const clientId = parseViewInteractionClientId(
					readOwnValue(binding, "clientId"),
				);
				const installationId = parseViewInteractionClientId(
					readOwnValue(binding, "installationId"),
				);
				if (
					!isViewsHandoff ||
					!completedActionHandoffId ||
					requestId !== completedActionHandoffId ||
					!clientId ||
					!installationId ||
					readOwnValue(binding, "viewId") !== viewId ||
					readOwnValue(binding, "viewType") !== "gui"
				)
					continue;
				navigationBinding = {
					requestId,
					clientId,
					installationId,
					viewId,
					viewType: "gui",
				};
			}
			return {
				viewId,
				...(viewPath ? { viewPath } : {}),
				...(subview ? { subview } : {}),
				...(readOwnValue(values, "completedActionDelivered") === true
					? { completedActionDelivered: true }
					: {}),
				...(completedActionHandoffId ? { completedActionHandoffId } : {}),
				...(navigationBinding
					? { navigationPrepared: true, navigationBinding }
					: {}),
			};
		}
	}
	return null;
}
