import { A as __require, D as require_jsx_runtime, O as __commonJSMin, j as __toESM, k as __exportAll } from "./electrobun-runtime-zXJ9acDW.js";
import { N as getBootConfig, a as formatDurationMs, d as client, i as formatDateTime, n as useApp } from "./useApp-Dh-r7aR7.js";
import { a as providerFromCredType, i as prettyCredName, ia as confirmDesktopAction, r as dispatchFocusConnector } from "./state-BC9WO-N8.js";
import { s as resolveWidgetsForSlot } from "./registry-B89cdzKO.js";
import { t as AppPageSidebar } from "./AppPageSidebar-myyOdXbd.js";
import { a as useAppWorkspaceChatChrome, i as AppWorkspaceChrome, o as PageScopedChatPane, v as ChoiceWidget } from "./AppWorkspaceChrome-aH27ucau.js";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, FieldLabel, FieldSwitch, FormSelect, FormSelectItem, Input, PageLayout, PagePanel, SidebarCollapsedActionButton, SidebarContent, SidebarPanel, SidebarScrollRegion, Spinner, StatusBadge, StatusDot, Textarea } from "@elizaos/ui";
import { ArrowRight, Calendar, CheckCircle2, ChevronDown, ChevronRight, Circle, Clock3, Copy, Edit, ExternalLink, FileText, GitBranch, Grid3x3, LayoutDashboard, Mail, Maximize2, Pause, Play, Plus, RefreshCw, Rss, Settings, Share2, Signal, SquareTerminal, Trash2, Workflow, X, Zap } from "lucide-react";
import React, { Component, createContext, forwardRef, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/client-types-chat.js
function isMissingCredentialsResponse(res) {
	const candidate = res;
	return candidate.warning === "missing credentials" && Array.isArray(candidate.missingCredentials);
}
function isNeedsClarificationResponse(res) {
	const candidate = res;
	return candidate.status === "needs_clarification" && Array.isArray(candidate.clarifications) && Array.isArray(candidate.catalog) && typeof candidate.draft === "object" && candidate.draft !== null;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/widgets/WidgetHost.js
/**
* WidgetHost — renders all enabled plugin widgets for a named slot.
*
* Drop this into any page view:
*   <WidgetHost slot="chat-sidebar" />
*   <WidgetHost slot="wallet" />
*
* Queries the widget registry for matching declarations, wraps each in an
* error boundary, and renders either the bundled React component or falls back
* to the declarative UiRenderer for uiSpec widgets.
*/
var import_jsx_runtime = require_jsx_runtime();
var WidgetErrorBoundary = class extends Component {
	state = { error: null };
	static getDerivedStateFromError(error) {
		return { error };
	}
	componentDidCatch(error, info) {
		console.error(`[widget:${this.props.widgetId}] render error:`, error, info.componentStack);
	}
	render() {
		if (this.state.error) return (0, import_jsx_runtime.jsxs)("div", {
			className: "rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger",
			"data-testid": `widget-error-${this.props.widgetId}`,
			children: [
				"Widget \"",
				this.props.widgetId,
				"\" failed to render."
			]
		});
		return this.props.children;
	}
};
function WidgetHost({ slot, events, clearEvents, className, hideWhenEmpty = true, filter }) {
	const { plugins } = useApp();
	const resolved = useMemo(() => {
		const all = resolveWidgetsForSlot(slot, plugins ?? []);
		return filter ? all.filter((entry) => filter(entry.declaration)) : all;
	}, [
		slot,
		plugins,
		filter
	]);
	if (resolved.length === 0 && hideWhenEmpty) return null;
	return (0, import_jsx_runtime.jsx)("div", {
		className: `flex flex-col gap-3 ${className ?? ""}`,
		"data-testid": `widget-host-${slot}`,
		"data-slot": slot,
		children: resolved.map(({ declaration, Component }) => {
			const widgetKey = `${declaration.pluginId}/${declaration.id}`;
			const pluginState = (plugins ?? []).find((p) => p.id === declaration.pluginId);
			const widgetProps = {
				pluginId: declaration.pluginId,
				pluginState,
				events,
				clearEvents
			};
			if (Component) return (0, import_jsx_runtime.jsx)(WidgetErrorBoundary, {
				widgetId: widgetKey,
				children: (0, import_jsx_runtime.jsx)(Component, { ...widgetProps })
			}, widgetKey);
			if (declaration.uiSpec) return (0, import_jsx_runtime.jsx)(WidgetErrorBoundary, {
				widgetId: widgetKey,
				children: (0, import_jsx_runtime.jsxs)("div", {
					className: "rounded-lg border border-border/60 bg-bg-accent/25 px-3 py-3 text-xs text-muted",
					"data-testid": `widget-uispec-${declaration.id}`,
					children: [declaration.label, " (declarative widget)"]
				})
			}, widgetKey);
			return null;
		})
	});
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/hooks/useWorkflowGenerationState.js
/**
* useWorkflowGenerationState — listens for workflow-generation lifecycle events
* emitted by AutomationRoomChatPane and returns whether a given workflow is
* currently being generated by the agent.
*
* Event protocol: CustomEvent on `window` with type
* `eliza:automations:workflow-generating` and detail
* `{ workflowId: string; inProgress: boolean }`.
*
* The same pattern is used by `eliza:automations:setFilter` in AutomationsView.
*/
/**
* Returns `true` while the agent is generating `workflowId`.
* Pass `null` to always return `false` (no workflow selected).
*/
function useWorkflowGenerationState(workflowId) {
	const [generating, setGenerating] = useState(false);
	useEffect(() => {
		if (!workflowId) {
			setGenerating(false);
			return;
		}
		const handler = (event) => {
			const detail = event.detail;
			if (detail?.workflowId === workflowId) setGenerating(detail.inProgress);
		};
		window.addEventListener("eliza:automations:workflow-generating", handler);
		return () => {
			window.removeEventListener("eliza:automations:workflow-generating", handler);
		};
	}, [workflowId]);
	useEffect(() => {
		setGenerating(false);
	}, []);
	return generating;
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/automation-conversations.js
const AUTOMATION_SCOPES = new Set([
	"automation-coordinator",
	"automation-workflow",
	"automation-workflow-draft",
	"automation-draft"
]);
function sortByUpdatedAtDesc(left, right) {
	return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}
function trimOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function isAutomationConversationMetadata(metadata) {
	return metadata?.scope ? AUTOMATION_SCOPES.has(metadata.scope) : false;
}
function isAutomationConversation(conversation) {
	return isAutomationConversationMetadata(conversation?.metadata);
}
function getAutomationBridgeConversationId(activeConversationId, conversations) {
	const normalizedActiveId = trimOptionalString(activeConversationId);
	if (!normalizedActiveId) return;
	if (isAutomationConversation(conversations.find((conversation) => conversation.id === normalizedActiveId))) return;
	return normalizedActiveId;
}
function buildCoordinatorConversationMetadata(taskId, bridgeConversationId) {
	return {
		scope: "automation-coordinator",
		automationType: "coordinator_text",
		taskId,
		...bridgeConversationId ? {
			sourceConversationId: bridgeConversationId,
			terminalBridgeConversationId: bridgeConversationId
		} : {}
	};
}
function buildCoordinatorTriggerConversationMetadata(triggerId, bridgeConversationId) {
	return {
		scope: "automation-coordinator",
		automationType: "coordinator_text",
		triggerId,
		...bridgeConversationId ? {
			sourceConversationId: bridgeConversationId,
			terminalBridgeConversationId: bridgeConversationId
		} : {}
	};
}
function buildWorkflowConversationMetadata(workflowId, workflowName, bridgeConversationId) {
	return {
		scope: "automation-workflow",
		automationType: "n8n_workflow",
		workflowId,
		workflowName,
		...bridgeConversationId ? {
			sourceConversationId: bridgeConversationId,
			terminalBridgeConversationId: bridgeConversationId
		} : {}
	};
}
function buildWorkflowDraftConversationMetadata(draftId, bridgeConversationId) {
	return {
		scope: "automation-workflow-draft",
		automationType: "n8n_workflow",
		draftId,
		...bridgeConversationId ? {
			sourceConversationId: bridgeConversationId,
			terminalBridgeConversationId: bridgeConversationId
		} : {}
	};
}
function buildAutomationDraftConversationMetadata(draftId, bridgeConversationId) {
	return {
		scope: "automation-draft",
		draftId,
		...bridgeConversationId ? {
			sourceConversationId: bridgeConversationId,
			terminalBridgeConversationId: bridgeConversationId
		} : {}
	};
}
function buildAutomationResponseRoutingMetadata(metadata) {
	if (metadata.scope === "automation-coordinator" || metadata.scope === "automation-workflow" || metadata.scope === "automation-workflow-draft" || metadata.scope === "automation-draft") return { __responseContext: {
		primaryContext: "automation",
		secondaryContexts: [
			"automation",
			"code",
			"system"
		]
	} };
}
function normalizedMetadata(metadata) {
	const next = {};
	const scope = trimOptionalString(metadata?.scope);
	if (scope) next.scope = scope;
	const automationType = trimOptionalString(metadata?.automationType);
	if (automationType) next.automationType = automationType;
	const taskId = trimOptionalString(metadata?.taskId);
	if (taskId) next.taskId = taskId;
	const triggerId = trimOptionalString(metadata?.triggerId);
	if (triggerId) next.triggerId = triggerId;
	const workflowId = trimOptionalString(metadata?.workflowId);
	if (workflowId) next.workflowId = workflowId;
	const workflowName = trimOptionalString(metadata?.workflowName);
	if (workflowName) next.workflowName = workflowName;
	const draftId = trimOptionalString(metadata?.draftId);
	if (draftId) next.draftId = draftId;
	const sourceConversationId = trimOptionalString(metadata?.sourceConversationId);
	if (sourceConversationId) next.sourceConversationId = sourceConversationId;
	const terminalBridgeConversationId = trimOptionalString(metadata?.terminalBridgeConversationId);
	if (terminalBridgeConversationId) next.terminalBridgeConversationId = terminalBridgeConversationId;
	return next;
}
function automationIdentityForMetadata(metadata) {
	if (metadata?.taskId) return `task:${metadata.taskId}`;
	if (metadata?.triggerId) return `trigger:${metadata.triggerId}`;
	if (metadata?.workflowId) return `workflow:${metadata.workflowId}`;
	if (metadata?.draftId) return `workflow-draft:${metadata.draftId}`;
	return null;
}
function metadataMatchesIdentity(left, right) {
	const leftIdentity = automationIdentityForMetadata(left);
	const rightIdentity = automationIdentityForMetadata(right);
	if (!leftIdentity || !rightIdentity) return false;
	return leftIdentity === rightIdentity;
}
function metadataEquals(left, right) {
	const normalizedLeft = normalizedMetadata(left);
	const normalizedRight = normalizedMetadata(right);
	const leftKeys = Object.keys(normalizedLeft).sort();
	const rightKeys = Object.keys(normalizedRight).sort();
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((key, index) => key === rightKeys[index] && normalizedLeft[key] === normalizedRight[key]);
}
function findAutomationConversation(conversations, metadata) {
	return conversations.filter((conversation) => isAutomationConversation(conversation) && metadataMatchesIdentity(conversation.metadata, metadata)).sort(sortByUpdatedAtDesc)[0] ?? null;
}
async function resolveAutomationConversation(params) {
	const { conversations } = await client.listConversations();
	const existing = findAutomationConversation(conversations, params.metadata);
	const normalizedTitle = params.title.trim() || "Automation";
	if (existing) {
		if (existing.title === normalizedTitle && metadataEquals(existing.metadata, params.metadata)) return existing;
		const { conversation } = await client.updateConversation(existing.id, {
			title: normalizedTitle,
			metadata: params.metadata
		});
		return conversation;
	}
	const { conversation } = await client.createConversation(normalizedTitle, { metadata: params.metadata });
	return conversation;
}

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/fields/types.js
var require_types = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/fields/CronField.js
var require_CronField = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronField = void 0;
	/**
	* Represents a field within a cron expression.
	* This is a base class and should not be instantiated directly.
	* @class CronField
	*/
	var CronField = class CronField {
		#hasLastChar = false;
		#hasQuestionMarkChar = false;
		#wildcard = false;
		#values = [];
		options = { rawValue: "" };
		/**
		* Returns the minimum value allowed for this field.
		*/
		/* istanbul ignore next */ static get min() {
			/* istanbul ignore next */
			throw new Error("min must be overridden");
		}
		/**
		* Returns the maximum value allowed for this field.
		*/
		/* istanbul ignore next */ static get max() {
			/* istanbul ignore next */
			throw new Error("max must be overridden");
		}
		/**
		* Returns the allowed characters for this field.
		*/
		/* istanbul ignore next */ static get chars() {
			/* istanbul ignore next - this is overridden */
			return Object.freeze([]);
		}
		/**
		* Returns the regular expression used to validate this field.
		*/
		static get validChars() {
			return /^[?,*\dH/-]+$|^.*H\(\d+-\d+\)\/\d+.*$|^.*H\(\d+-\d+\).*$|^.*H\/\d+.*$/;
		}
		/**
		* Returns the constraints for this field.
		*/
		static get constraints() {
			return {
				min: this.min,
				max: this.max,
				chars: this.chars,
				validChars: this.validChars
			};
		}
		/**
		* CronField constructor. Initializes the field with the provided values.
		* @param {number[] | string[]} values - Values for this field
		* @param {CronFieldOptions} [options] - Options provided by the parser
		* @throws {TypeError} if the constructor is called directly
		* @throws {Error} if validation fails
		*/
		constructor(values, options = { rawValue: "" }) {
			if (!Array.isArray(values)) throw new Error(`${this.constructor.name} Validation error, values is not an array`);
			if (!(values.length > 0)) throw new Error(`${this.constructor.name} Validation error, values contains no values`);
			/* istanbul ignore next */
			this.options = {
				...options,
				rawValue: options.rawValue ?? ""
			};
			this.#values = values.sort(CronField.sorter);
			this.#wildcard = this.options.wildcard !== void 0 ? this.options.wildcard : this.#isWildcardValue();
			this.#hasLastChar = this.options.rawValue.includes("L") || values.includes("L");
			this.#hasQuestionMarkChar = this.options.rawValue.includes("?") || values.includes("?");
		}
		/**
		* Returns the minimum value allowed for this field.
		* @returns {number}
		*/
		get min() {
			return this.constructor.min;
		}
		/**
		* Returns the maximum value allowed for this field.
		* @returns {number}
		*/
		get max() {
			return this.constructor.max;
		}
		/**
		* Returns an array of allowed special characters for this field.
		* @returns {string[]}
		*/
		get chars() {
			return this.constructor.chars;
		}
		/**
		* Indicates whether this field has a "last" character.
		* @returns {boolean}
		*/
		get hasLastChar() {
			return this.#hasLastChar;
		}
		/**
		* Indicates whether this field has a "question mark" character.
		* @returns {boolean}
		*/
		get hasQuestionMarkChar() {
			return this.#hasQuestionMarkChar;
		}
		/**
		* Indicates whether this field is a wildcard.
		* @returns {boolean}
		*/
		get isWildcard() {
			return this.#wildcard;
		}
		/**
		* Returns an array of allowed values for this field.
		* @returns {CronFieldType}
		*/
		get values() {
			return this.#values;
		}
		/**
		* Helper function to sort values in ascending order.
		* @param {number | string} a - First value to compare
		* @param {number | string} b - Second value to compare
		* @returns {number} - A negative, zero, or positive value, depending on the sort order
		*/
		static sorter(a, b) {
			const aIsNumber = typeof a === "number";
			const bIsNumber = typeof b === "number";
			if (aIsNumber && bIsNumber) return a - b;
			if (!aIsNumber && !bIsNumber) return a.localeCompare(b);
			return aIsNumber ? -1 : 1;
		}
		/**
		* Find the next (or previous when `reverse` is true) numeric value in a sorted list.
		* Returns null if there's no value strictly after/before the current one.
		*
		* @param values - Sorted numeric values
		* @param currentValue - Current value to compare against
		* @param reverse - When true, search in reverse for previous smaller value
		*/
		static findNearestValueInList(values, currentValue, reverse = false) {
			if (reverse) {
				for (let i = values.length - 1; i >= 0; i--) if (values[i] < currentValue) return values[i];
				return null;
			}
			for (let i = 0; i < values.length; i++) if (values[i] > currentValue) return values[i];
			return null;
		}
		/**
		* Instance helper that operates on this field's numeric `values`.
		*
		* @param currentValue - Current value to compare against
		* @param reverse - When true, search in reverse for previous smaller value
		*/
		findNearestValue(currentValue, reverse = false) {
			return this.constructor.findNearestValueInList(this.values, currentValue, reverse);
		}
		/**
		* Serializes the field to an object.
		* @returns {SerializedCronField}
		*/
		serialize() {
			return {
				wildcard: this.#wildcard,
				values: this.#values
			};
		}
		/**
		* Validates the field values against the allowed range and special characters.
		* @throws {Error} if validation fails
		*/
		validate() {
			let badValue;
			const charsString = this.chars.length > 0 ? ` or chars ${this.chars.join("")}` : "";
			const charTest = (value) => (char) => new RegExp(`^\\d{0,2}${char}$`).test(value);
			const rangeTest = (value) => {
				badValue = value;
				return typeof value === "number" ? value >= this.min && value <= this.max : this.chars.some(charTest(value));
			};
			if (!this.#values.every(rangeTest)) throw new Error(`${this.constructor.name} Validation error, got value ${badValue} expected range ${this.min}-${this.max}${charsString}`);
			const duplicate = this.#values.find((value, index) => this.#values.indexOf(value) !== index);
			if (duplicate) throw new Error(`${this.constructor.name} Validation error, duplicate values found: ${duplicate}`);
		}
		/**
		* Determines if the field is a wildcard based on the values.
		* When options.rawValue is not empty, it checks if the raw value is a wildcard, otherwise it checks if all values in the range are included.
		* @returns {boolean}
		*/
		#isWildcardValue() {
			if (this.options.rawValue.length > 0) return ["*", "?"].includes(this.options.rawValue);
			return Array.from({ length: this.max - this.min + 1 }, (_, i) => i + this.min).every((value) => this.#values.includes(value));
		}
	};
	exports.CronField = CronField;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/fields/CronDayOfMonth.js
var require_CronDayOfMonth = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronDayOfMonth = void 0;
	const CronField_1 = require_CronField();
	const MIN_DAY = 1;
	const MAX_DAY = 31;
	const DAY_CHARS = Object.freeze(["L"]);
	/**
	* Represents the "day of the month" field within a cron expression.
	* @class CronDayOfMonth
	* @extends CronField
	*/
	var CronDayOfMonth = class extends CronField_1.CronField {
		static get min() {
			return MIN_DAY;
		}
		static get max() {
			return MAX_DAY;
		}
		static get chars() {
			return DAY_CHARS;
		}
		static get validChars() {
			return /^[?,*\dLH/-]+$|^.*H\(\d+-\d+\)\/\d+.*$|^.*H\(\d+-\d+\).*$|^.*H\/\d+.*$/;
		}
		/**
		* CronDayOfMonth constructor. Initializes the "day of the month" field with the provided values.
		* @param {DayOfMonthRange[]} values - Values for the "day of the month" field
		* @param {CronFieldOptions} [options] - Options provided by the parser
		* @throws {Error} if validation fails
		*/
		constructor(values, options) {
			super(values, options);
			this.validate();
		}
		/**
		* Returns an array of allowed values for the "day of the month" field.
		* @returns {DayOfMonthRange[]}
		*/
		get values() {
			return super.values;
		}
	};
	exports.CronDayOfMonth = CronDayOfMonth;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/fields/CronDayOfWeek.js
var require_CronDayOfWeek = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronDayOfWeek = void 0;
	const CronField_1 = require_CronField();
	const MIN_DAY = 0;
	const MAX_DAY = 7;
	const DAY_CHARS = Object.freeze(["L"]);
	/**
	* Represents the "day of the week" field within a cron expression.
	* @class CronDayOfTheWeek
	* @extends CronField
	*/
	var CronDayOfWeek = class extends CronField_1.CronField {
		static get min() {
			return MIN_DAY;
		}
		static get max() {
			return MAX_DAY;
		}
		static get chars() {
			return DAY_CHARS;
		}
		static get validChars() {
			return /^[?,*\dLH#/-]+$|^.*H\(\d+-\d+\)\/\d+.*$|^.*H\(\d+-\d+\).*$|^.*H\/\d+.*$/;
		}
		/**
		* CronDayOfTheWeek constructor. Initializes the "day of the week" field with the provided values.
		* @param {DayOfWeekRange[]} values - Values for the "day of the week" field
		* @param {CronFieldOptions} [options] - Options provided by the parser
		*/
		constructor(values, options) {
			super(values, options);
			this.validate();
		}
		/**
		* Returns an array of allowed values for the "day of the week" field.
		* @returns {DayOfWeekRange[]}
		*/
		get values() {
			return super.values;
		}
		/**
		* Returns the nth day of the week if specified in the cron expression.
		* This is used for the '#' character in the cron expression.
		* @returns {number} The nth day of the week (1-5) or 0 if not specified.
		*/
		get nthDay() {
			return this.options.nthDayOfWeek ?? 0;
		}
	};
	exports.CronDayOfWeek = CronDayOfWeek;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/fields/CronHour.js
var require_CronHour = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronHour = void 0;
	const CronField_1 = require_CronField();
	const MIN_HOUR = 0;
	const MAX_HOUR = 23;
	const HOUR_CHARS = Object.freeze([]);
	/**
	* Represents the "hour" field within a cron expression.
	* @class CronHour
	* @extends CronField
	*/
	var CronHour = class extends CronField_1.CronField {
		static get min() {
			return MIN_HOUR;
		}
		static get max() {
			return MAX_HOUR;
		}
		static get chars() {
			return HOUR_CHARS;
		}
		/**
		* CronHour constructor. Initializes the "hour" field with the provided values.
		* @param {HourRange[]} values - Values for the "hour" field
		* @param {CronFieldOptions} [options] - Options provided by the parser
		*/
		constructor(values, options) {
			super(values, options);
			this.validate();
		}
		/**
		* Returns an array of allowed values for the "hour" field.
		* @returns {HourRange[]}
		*/
		get values() {
			return super.values;
		}
	};
	exports.CronHour = CronHour;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/fields/CronMinute.js
var require_CronMinute = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronMinute = void 0;
	const CronField_1 = require_CronField();
	const MIN_MINUTE = 0;
	const MAX_MINUTE = 59;
	const MINUTE_CHARS = Object.freeze([]);
	/**
	* Represents the "second" field within a cron expression.
	* @class CronSecond
	* @extends CronField
	*/
	var CronMinute = class extends CronField_1.CronField {
		static get min() {
			return MIN_MINUTE;
		}
		static get max() {
			return MAX_MINUTE;
		}
		static get chars() {
			return MINUTE_CHARS;
		}
		/**
		* CronSecond constructor. Initializes the "second" field with the provided values.
		* @param {SixtyRange[]} values - Values for the "second" field
		* @param {CronFieldOptions} [options] - Options provided by the parser
		*/
		constructor(values, options) {
			super(values, options);
			this.validate();
		}
		/**
		* Returns an array of allowed values for the "second" field.
		* @returns {SixtyRange[]}
		*/
		get values() {
			return super.values;
		}
	};
	exports.CronMinute = CronMinute;
}));

//#endregion
//#region node_modules/.bun/luxon@3.7.2/node_modules/luxon/build/node/luxon.js
var require_luxon = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	/**
	* @private
	*/
	var LuxonError = class extends Error {};
	/**
	* @private
	*/
	var InvalidDateTimeError = class extends LuxonError {
		constructor(reason) {
			super(`Invalid DateTime: ${reason.toMessage()}`);
		}
	};
	/**
	* @private
	*/
	var InvalidIntervalError = class extends LuxonError {
		constructor(reason) {
			super(`Invalid Interval: ${reason.toMessage()}`);
		}
	};
	/**
	* @private
	*/
	var InvalidDurationError = class extends LuxonError {
		constructor(reason) {
			super(`Invalid Duration: ${reason.toMessage()}`);
		}
	};
	/**
	* @private
	*/
	var ConflictingSpecificationError = class extends LuxonError {};
	/**
	* @private
	*/
	var InvalidUnitError = class extends LuxonError {
		constructor(unit) {
			super(`Invalid unit ${unit}`);
		}
	};
	/**
	* @private
	*/
	var InvalidArgumentError = class extends LuxonError {};
	/**
	* @private
	*/
	var ZoneIsAbstractError = class extends LuxonError {
		constructor() {
			super("Zone is an abstract class");
		}
	};
	/**
	* @private
	*/
	const n = "numeric", s = "short", l = "long";
	const DATE_SHORT = {
		year: n,
		month: n,
		day: n
	};
	const DATE_MED = {
		year: n,
		month: s,
		day: n
	};
	const DATE_MED_WITH_WEEKDAY = {
		year: n,
		month: s,
		day: n,
		weekday: s
	};
	const DATE_FULL = {
		year: n,
		month: l,
		day: n
	};
	const DATE_HUGE = {
		year: n,
		month: l,
		day: n,
		weekday: l
	};
	const TIME_SIMPLE = {
		hour: n,
		minute: n
	};
	const TIME_WITH_SECONDS = {
		hour: n,
		minute: n,
		second: n
	};
	const TIME_WITH_SHORT_OFFSET = {
		hour: n,
		minute: n,
		second: n,
		timeZoneName: s
	};
	const TIME_WITH_LONG_OFFSET = {
		hour: n,
		minute: n,
		second: n,
		timeZoneName: l
	};
	const TIME_24_SIMPLE = {
		hour: n,
		minute: n,
		hourCycle: "h23"
	};
	const TIME_24_WITH_SECONDS = {
		hour: n,
		minute: n,
		second: n,
		hourCycle: "h23"
	};
	const TIME_24_WITH_SHORT_OFFSET = {
		hour: n,
		minute: n,
		second: n,
		hourCycle: "h23",
		timeZoneName: s
	};
	const TIME_24_WITH_LONG_OFFSET = {
		hour: n,
		minute: n,
		second: n,
		hourCycle: "h23",
		timeZoneName: l
	};
	const DATETIME_SHORT = {
		year: n,
		month: n,
		day: n,
		hour: n,
		minute: n
	};
	const DATETIME_SHORT_WITH_SECONDS = {
		year: n,
		month: n,
		day: n,
		hour: n,
		minute: n,
		second: n
	};
	const DATETIME_MED = {
		year: n,
		month: s,
		day: n,
		hour: n,
		minute: n
	};
	const DATETIME_MED_WITH_SECONDS = {
		year: n,
		month: s,
		day: n,
		hour: n,
		minute: n,
		second: n
	};
	const DATETIME_MED_WITH_WEEKDAY = {
		year: n,
		month: s,
		day: n,
		weekday: s,
		hour: n,
		minute: n
	};
	const DATETIME_FULL = {
		year: n,
		month: l,
		day: n,
		hour: n,
		minute: n,
		timeZoneName: s
	};
	const DATETIME_FULL_WITH_SECONDS = {
		year: n,
		month: l,
		day: n,
		hour: n,
		minute: n,
		second: n,
		timeZoneName: s
	};
	const DATETIME_HUGE = {
		year: n,
		month: l,
		day: n,
		weekday: l,
		hour: n,
		minute: n,
		timeZoneName: l
	};
	const DATETIME_HUGE_WITH_SECONDS = {
		year: n,
		month: l,
		day: n,
		weekday: l,
		hour: n,
		minute: n,
		second: n,
		timeZoneName: l
	};
	/**
	* @interface
	*/
	var Zone = class {
		/**
		* The type of zone
		* @abstract
		* @type {string}
		*/
		get type() {
			throw new ZoneIsAbstractError();
		}
		/**
		* The name of this zone.
		* @abstract
		* @type {string}
		*/
		get name() {
			throw new ZoneIsAbstractError();
		}
		/**
		* The IANA name of this zone.
		* Defaults to `name` if not overwritten by a subclass.
		* @abstract
		* @type {string}
		*/
		get ianaName() {
			return this.name;
		}
		/**
		* Returns whether the offset is known to be fixed for the whole year.
		* @abstract
		* @type {boolean}
		*/
		get isUniversal() {
			throw new ZoneIsAbstractError();
		}
		/**
		* Returns the offset's common name (such as EST) at the specified timestamp
		* @abstract
		* @param {number} ts - Epoch milliseconds for which to get the name
		* @param {Object} opts - Options to affect the format
		* @param {string} opts.format - What style of offset to return. Accepts 'long' or 'short'.
		* @param {string} opts.locale - What locale to return the offset name in.
		* @return {string}
		*/
		offsetName(ts, opts) {
			throw new ZoneIsAbstractError();
		}
		/**
		* Returns the offset's value as a string
		* @abstract
		* @param {number} ts - Epoch milliseconds for which to get the offset
		* @param {string} format - What style of offset to return.
		*                          Accepts 'narrow', 'short', or 'techie'. Returning '+6', '+06:00', or '+0600' respectively
		* @return {string}
		*/
		formatOffset(ts, format) {
			throw new ZoneIsAbstractError();
		}
		/**
		* Return the offset in minutes for this zone at the specified timestamp.
		* @abstract
		* @param {number} ts - Epoch milliseconds for which to compute the offset
		* @return {number}
		*/
		offset(ts) {
			throw new ZoneIsAbstractError();
		}
		/**
		* Return whether this Zone is equal to another zone
		* @abstract
		* @param {Zone} otherZone - the zone to compare
		* @return {boolean}
		*/
		equals(otherZone) {
			throw new ZoneIsAbstractError();
		}
		/**
		* Return whether this Zone is valid.
		* @abstract
		* @type {boolean}
		*/
		get isValid() {
			throw new ZoneIsAbstractError();
		}
	};
	let singleton$1 = null;
	/**
	* Represents the local zone for this JavaScript environment.
	* @implements {Zone}
	*/
	var SystemZone = class SystemZone extends Zone {
		/**
		* Get a singleton instance of the local zone
		* @return {SystemZone}
		*/
		static get instance() {
			if (singleton$1 === null) singleton$1 = new SystemZone();
			return singleton$1;
		}
		/** @override **/
		get type() {
			return "system";
		}
		/** @override **/
		get name() {
			return new Intl.DateTimeFormat().resolvedOptions().timeZone;
		}
		/** @override **/
		get isUniversal() {
			return false;
		}
		/** @override **/
		offsetName(ts, { format, locale }) {
			return parseZoneInfo(ts, format, locale);
		}
		/** @override **/
		formatOffset(ts, format) {
			return formatOffset(this.offset(ts), format);
		}
		/** @override **/
		offset(ts) {
			return -new Date(ts).getTimezoneOffset();
		}
		/** @override **/
		equals(otherZone) {
			return otherZone.type === "system";
		}
		/** @override **/
		get isValid() {
			return true;
		}
	};
	const dtfCache = /* @__PURE__ */ new Map();
	function makeDTF(zoneName) {
		let dtf = dtfCache.get(zoneName);
		if (dtf === void 0) {
			dtf = new Intl.DateTimeFormat("en-US", {
				hour12: false,
				timeZone: zoneName,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				era: "short"
			});
			dtfCache.set(zoneName, dtf);
		}
		return dtf;
	}
	const typeToPos = {
		year: 0,
		month: 1,
		day: 2,
		era: 3,
		hour: 4,
		minute: 5,
		second: 6
	};
	function hackyOffset(dtf, date) {
		const formatted = dtf.format(date).replace(/\u200E/g, ""), [, fMonth, fDay, fYear, fadOrBc, fHour, fMinute, fSecond] = /(\d+)\/(\d+)\/(\d+) (AD|BC),? (\d+):(\d+):(\d+)/.exec(formatted);
		return [
			fYear,
			fMonth,
			fDay,
			fadOrBc,
			fHour,
			fMinute,
			fSecond
		];
	}
	function partsOffset(dtf, date) {
		const formatted = dtf.formatToParts(date);
		const filled = [];
		for (let i = 0; i < formatted.length; i++) {
			const { type, value } = formatted[i];
			const pos = typeToPos[type];
			if (type === "era") filled[pos] = value;
			else if (!isUndefined(pos)) filled[pos] = parseInt(value, 10);
		}
		return filled;
	}
	const ianaZoneCache = /* @__PURE__ */ new Map();
	/**
	* A zone identified by an IANA identifier, like America/New_York
	* @implements {Zone}
	*/
	var IANAZone = class IANAZone extends Zone {
		/**
		* @param {string} name - Zone name
		* @return {IANAZone}
		*/
		static create(name) {
			let zone = ianaZoneCache.get(name);
			if (zone === void 0) ianaZoneCache.set(name, zone = new IANAZone(name));
			return zone;
		}
		/**
		* Reset local caches. Should only be necessary in testing scenarios.
		* @return {void}
		*/
		static resetCache() {
			ianaZoneCache.clear();
			dtfCache.clear();
		}
		/**
		* Returns whether the provided string is a valid specifier. This only checks the string's format, not that the specifier identifies a known zone; see isValidZone for that.
		* @param {string} s - The string to check validity on
		* @example IANAZone.isValidSpecifier("America/New_York") //=> true
		* @example IANAZone.isValidSpecifier("Sport~~blorp") //=> false
		* @deprecated For backward compatibility, this forwards to isValidZone, better use `isValidZone()` directly instead.
		* @return {boolean}
		*/
		static isValidSpecifier(s) {
			return this.isValidZone(s);
		}
		/**
		* Returns whether the provided string identifies a real zone
		* @param {string} zone - The string to check
		* @example IANAZone.isValidZone("America/New_York") //=> true
		* @example IANAZone.isValidZone("Fantasia/Castle") //=> false
		* @example IANAZone.isValidZone("Sport~~blorp") //=> false
		* @return {boolean}
		*/
		static isValidZone(zone) {
			if (!zone) return false;
			try {
				new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
				return true;
			} catch (e) {
				return false;
			}
		}
		constructor(name) {
			super();
			/** @private **/
			this.zoneName = name;
			/** @private **/
			this.valid = IANAZone.isValidZone(name);
		}
		/**
		* The type of zone. `iana` for all instances of `IANAZone`.
		* @override
		* @type {string}
		*/
		get type() {
			return "iana";
		}
		/**
		* The name of this zone (i.e. the IANA zone name).
		* @override
		* @type {string}
		*/
		get name() {
			return this.zoneName;
		}
		/**
		* Returns whether the offset is known to be fixed for the whole year:
		* Always returns false for all IANA zones.
		* @override
		* @type {boolean}
		*/
		get isUniversal() {
			return false;
		}
		/**
		* Returns the offset's common name (such as EST) at the specified timestamp
		* @override
		* @param {number} ts - Epoch milliseconds for which to get the name
		* @param {Object} opts - Options to affect the format
		* @param {string} opts.format - What style of offset to return. Accepts 'long' or 'short'.
		* @param {string} opts.locale - What locale to return the offset name in.
		* @return {string}
		*/
		offsetName(ts, { format, locale }) {
			return parseZoneInfo(ts, format, locale, this.name);
		}
		/**
		* Returns the offset's value as a string
		* @override
		* @param {number} ts - Epoch milliseconds for which to get the offset
		* @param {string} format - What style of offset to return.
		*                          Accepts 'narrow', 'short', or 'techie'. Returning '+6', '+06:00', or '+0600' respectively
		* @return {string}
		*/
		formatOffset(ts, format) {
			return formatOffset(this.offset(ts), format);
		}
		/**
		* Return the offset in minutes for this zone at the specified timestamp.
		* @override
		* @param {number} ts - Epoch milliseconds for which to compute the offset
		* @return {number}
		*/
		offset(ts) {
			if (!this.valid) return NaN;
			const date = new Date(ts);
			if (isNaN(date)) return NaN;
			const dtf = makeDTF(this.name);
			let [year, month, day, adOrBc, hour, minute, second] = dtf.formatToParts ? partsOffset(dtf, date) : hackyOffset(dtf, date);
			if (adOrBc === "BC") year = -Math.abs(year) + 1;
			const asUTC = objToLocalTS({
				year,
				month,
				day,
				hour: hour === 24 ? 0 : hour,
				minute,
				second,
				millisecond: 0
			});
			let asTS = +date;
			const over = asTS % 1e3;
			asTS -= over >= 0 ? over : 1e3 + over;
			return (asUTC - asTS) / (60 * 1e3);
		}
		/**
		* Return whether this Zone is equal to another zone
		* @override
		* @param {Zone} otherZone - the zone to compare
		* @return {boolean}
		*/
		equals(otherZone) {
			return otherZone.type === "iana" && otherZone.name === this.name;
		}
		/**
		* Return whether this Zone is valid.
		* @override
		* @type {boolean}
		*/
		get isValid() {
			return this.valid;
		}
	};
	let intlLFCache = {};
	function getCachedLF(locString, opts = {}) {
		const key = JSON.stringify([locString, opts]);
		let dtf = intlLFCache[key];
		if (!dtf) {
			dtf = new Intl.ListFormat(locString, opts);
			intlLFCache[key] = dtf;
		}
		return dtf;
	}
	const intlDTCache = /* @__PURE__ */ new Map();
	function getCachedDTF(locString, opts = {}) {
		const key = JSON.stringify([locString, opts]);
		let dtf = intlDTCache.get(key);
		if (dtf === void 0) {
			dtf = new Intl.DateTimeFormat(locString, opts);
			intlDTCache.set(key, dtf);
		}
		return dtf;
	}
	const intlNumCache = /* @__PURE__ */ new Map();
	function getCachedINF(locString, opts = {}) {
		const key = JSON.stringify([locString, opts]);
		let inf = intlNumCache.get(key);
		if (inf === void 0) {
			inf = new Intl.NumberFormat(locString, opts);
			intlNumCache.set(key, inf);
		}
		return inf;
	}
	const intlRelCache = /* @__PURE__ */ new Map();
	function getCachedRTF(locString, opts = {}) {
		const { base, ...cacheKeyOpts } = opts;
		const key = JSON.stringify([locString, cacheKeyOpts]);
		let inf = intlRelCache.get(key);
		if (inf === void 0) {
			inf = new Intl.RelativeTimeFormat(locString, opts);
			intlRelCache.set(key, inf);
		}
		return inf;
	}
	let sysLocaleCache = null;
	function systemLocale() {
		if (sysLocaleCache) return sysLocaleCache;
		else {
			sysLocaleCache = new Intl.DateTimeFormat().resolvedOptions().locale;
			return sysLocaleCache;
		}
	}
	const intlResolvedOptionsCache = /* @__PURE__ */ new Map();
	function getCachedIntResolvedOptions(locString) {
		let opts = intlResolvedOptionsCache.get(locString);
		if (opts === void 0) {
			opts = new Intl.DateTimeFormat(locString).resolvedOptions();
			intlResolvedOptionsCache.set(locString, opts);
		}
		return opts;
	}
	const weekInfoCache = /* @__PURE__ */ new Map();
	function getCachedWeekInfo(locString) {
		let data = weekInfoCache.get(locString);
		if (!data) {
			const locale = new Intl.Locale(locString);
			data = "getWeekInfo" in locale ? locale.getWeekInfo() : locale.weekInfo;
			if (!("minimalDays" in data)) data = {
				...fallbackWeekSettings,
				...data
			};
			weekInfoCache.set(locString, data);
		}
		return data;
	}
	function parseLocaleString(localeStr) {
		const xIndex = localeStr.indexOf("-x-");
		if (xIndex !== -1) localeStr = localeStr.substring(0, xIndex);
		const uIndex = localeStr.indexOf("-u-");
		if (uIndex === -1) return [localeStr];
		else {
			let options;
			let selectedStr;
			try {
				options = getCachedDTF(localeStr).resolvedOptions();
				selectedStr = localeStr;
			} catch (e) {
				const smaller = localeStr.substring(0, uIndex);
				options = getCachedDTF(smaller).resolvedOptions();
				selectedStr = smaller;
			}
			const { numberingSystem, calendar } = options;
			return [
				selectedStr,
				numberingSystem,
				calendar
			];
		}
	}
	function intlConfigString(localeStr, numberingSystem, outputCalendar) {
		if (outputCalendar || numberingSystem) {
			if (!localeStr.includes("-u-")) localeStr += "-u";
			if (outputCalendar) localeStr += `-ca-${outputCalendar}`;
			if (numberingSystem) localeStr += `-nu-${numberingSystem}`;
			return localeStr;
		} else return localeStr;
	}
	function mapMonths(f) {
		const ms = [];
		for (let i = 1; i <= 12; i++) {
			const dt = DateTime.utc(2009, i, 1);
			ms.push(f(dt));
		}
		return ms;
	}
	function mapWeekdays(f) {
		const ms = [];
		for (let i = 1; i <= 7; i++) {
			const dt = DateTime.utc(2016, 11, 13 + i);
			ms.push(f(dt));
		}
		return ms;
	}
	function listStuff(loc, length, englishFn, intlFn) {
		const mode = loc.listingMode();
		if (mode === "error") return null;
		else if (mode === "en") return englishFn(length);
		else return intlFn(length);
	}
	function supportsFastNumbers(loc) {
		if (loc.numberingSystem && loc.numberingSystem !== "latn") return false;
		else return loc.numberingSystem === "latn" || !loc.locale || loc.locale.startsWith("en") || getCachedIntResolvedOptions(loc.locale).numberingSystem === "latn";
	}
	/**
	* @private
	*/
	var PolyNumberFormatter = class {
		constructor(intl, forceSimple, opts) {
			this.padTo = opts.padTo || 0;
			this.floor = opts.floor || false;
			const { padTo, floor, ...otherOpts } = opts;
			if (!forceSimple || Object.keys(otherOpts).length > 0) {
				const intlOpts = {
					useGrouping: false,
					...opts
				};
				if (opts.padTo > 0) intlOpts.minimumIntegerDigits = opts.padTo;
				this.inf = getCachedINF(intl, intlOpts);
			}
		}
		format(i) {
			if (this.inf) {
				const fixed = this.floor ? Math.floor(i) : i;
				return this.inf.format(fixed);
			} else return padStart(this.floor ? Math.floor(i) : roundTo(i, 3), this.padTo);
		}
	};
	/**
	* @private
	*/
	var PolyDateFormatter = class {
		constructor(dt, intl, opts) {
			this.opts = opts;
			this.originalZone = void 0;
			let z = void 0;
			if (this.opts.timeZone) this.dt = dt;
			else if (dt.zone.type === "fixed") {
				const gmtOffset = -1 * (dt.offset / 60);
				const offsetZ = gmtOffset >= 0 ? `Etc/GMT+${gmtOffset}` : `Etc/GMT${gmtOffset}`;
				if (dt.offset !== 0 && IANAZone.create(offsetZ).valid) {
					z = offsetZ;
					this.dt = dt;
				} else {
					z = "UTC";
					this.dt = dt.offset === 0 ? dt : dt.setZone("UTC").plus({ minutes: dt.offset });
					this.originalZone = dt.zone;
				}
			} else if (dt.zone.type === "system") this.dt = dt;
			else if (dt.zone.type === "iana") {
				this.dt = dt;
				z = dt.zone.name;
			} else {
				z = "UTC";
				this.dt = dt.setZone("UTC").plus({ minutes: dt.offset });
				this.originalZone = dt.zone;
			}
			const intlOpts = { ...this.opts };
			intlOpts.timeZone = intlOpts.timeZone || z;
			this.dtf = getCachedDTF(intl, intlOpts);
		}
		format() {
			if (this.originalZone) return this.formatToParts().map(({ value }) => value).join("");
			return this.dtf.format(this.dt.toJSDate());
		}
		formatToParts() {
			const parts = this.dtf.formatToParts(this.dt.toJSDate());
			if (this.originalZone) return parts.map((part) => {
				if (part.type === "timeZoneName") {
					const offsetName = this.originalZone.offsetName(this.dt.ts, {
						locale: this.dt.locale,
						format: this.opts.timeZoneName
					});
					return {
						...part,
						value: offsetName
					};
				} else return part;
			});
			return parts;
		}
		resolvedOptions() {
			return this.dtf.resolvedOptions();
		}
	};
	/**
	* @private
	*/
	var PolyRelFormatter = class {
		constructor(intl, isEnglish, opts) {
			this.opts = {
				style: "long",
				...opts
			};
			if (!isEnglish && hasRelative()) this.rtf = getCachedRTF(intl, opts);
		}
		format(count, unit) {
			if (this.rtf) return this.rtf.format(count, unit);
			else return formatRelativeTime(unit, count, this.opts.numeric, this.opts.style !== "long");
		}
		formatToParts(count, unit) {
			if (this.rtf) return this.rtf.formatToParts(count, unit);
			else return [];
		}
	};
	const fallbackWeekSettings = {
		firstDay: 1,
		minimalDays: 4,
		weekend: [6, 7]
	};
	/**
	* @private
	*/
	var Locale = class Locale {
		static fromOpts(opts) {
			return Locale.create(opts.locale, opts.numberingSystem, opts.outputCalendar, opts.weekSettings, opts.defaultToEN);
		}
		static create(locale, numberingSystem, outputCalendar, weekSettings, defaultToEN = false) {
			const specifiedLocale = locale || Settings.defaultLocale;
			return new Locale(specifiedLocale || (defaultToEN ? "en-US" : systemLocale()), numberingSystem || Settings.defaultNumberingSystem, outputCalendar || Settings.defaultOutputCalendar, validateWeekSettings(weekSettings) || Settings.defaultWeekSettings, specifiedLocale);
		}
		static resetCache() {
			sysLocaleCache = null;
			intlDTCache.clear();
			intlNumCache.clear();
			intlRelCache.clear();
			intlResolvedOptionsCache.clear();
			weekInfoCache.clear();
		}
		static fromObject({ locale, numberingSystem, outputCalendar, weekSettings } = {}) {
			return Locale.create(locale, numberingSystem, outputCalendar, weekSettings);
		}
		constructor(locale, numbering, outputCalendar, weekSettings, specifiedLocale) {
			const [parsedLocale, parsedNumberingSystem, parsedOutputCalendar] = parseLocaleString(locale);
			this.locale = parsedLocale;
			this.numberingSystem = numbering || parsedNumberingSystem || null;
			this.outputCalendar = outputCalendar || parsedOutputCalendar || null;
			this.weekSettings = weekSettings;
			this.intl = intlConfigString(this.locale, this.numberingSystem, this.outputCalendar);
			this.weekdaysCache = {
				format: {},
				standalone: {}
			};
			this.monthsCache = {
				format: {},
				standalone: {}
			};
			this.meridiemCache = null;
			this.eraCache = {};
			this.specifiedLocale = specifiedLocale;
			this.fastNumbersCached = null;
		}
		get fastNumbers() {
			if (this.fastNumbersCached == null) this.fastNumbersCached = supportsFastNumbers(this);
			return this.fastNumbersCached;
		}
		listingMode() {
			const isActuallyEn = this.isEnglish();
			const hasNoWeirdness = (this.numberingSystem === null || this.numberingSystem === "latn") && (this.outputCalendar === null || this.outputCalendar === "gregory");
			return isActuallyEn && hasNoWeirdness ? "en" : "intl";
		}
		clone(alts) {
			if (!alts || Object.getOwnPropertyNames(alts).length === 0) return this;
			else return Locale.create(alts.locale || this.specifiedLocale, alts.numberingSystem || this.numberingSystem, alts.outputCalendar || this.outputCalendar, validateWeekSettings(alts.weekSettings) || this.weekSettings, alts.defaultToEN || false);
		}
		redefaultToEN(alts = {}) {
			return this.clone({
				...alts,
				defaultToEN: true
			});
		}
		redefaultToSystem(alts = {}) {
			return this.clone({
				...alts,
				defaultToEN: false
			});
		}
		months(length, format = false) {
			return listStuff(this, length, months, () => {
				const monthSpecialCase = this.intl === "ja" || this.intl.startsWith("ja-");
				format &= !monthSpecialCase;
				const intl = format ? {
					month: length,
					day: "numeric"
				} : { month: length }, formatStr = format ? "format" : "standalone";
				if (!this.monthsCache[formatStr][length]) {
					const mapper = !monthSpecialCase ? (dt) => this.extract(dt, intl, "month") : (dt) => this.dtFormatter(dt, intl).format();
					this.monthsCache[formatStr][length] = mapMonths(mapper);
				}
				return this.monthsCache[formatStr][length];
			});
		}
		weekdays(length, format = false) {
			return listStuff(this, length, weekdays, () => {
				const intl = format ? {
					weekday: length,
					year: "numeric",
					month: "long",
					day: "numeric"
				} : { weekday: length }, formatStr = format ? "format" : "standalone";
				if (!this.weekdaysCache[formatStr][length]) this.weekdaysCache[formatStr][length] = mapWeekdays((dt) => this.extract(dt, intl, "weekday"));
				return this.weekdaysCache[formatStr][length];
			});
		}
		meridiems() {
			return listStuff(this, void 0, () => meridiems, () => {
				if (!this.meridiemCache) {
					const intl = {
						hour: "numeric",
						hourCycle: "h12"
					};
					this.meridiemCache = [DateTime.utc(2016, 11, 13, 9), DateTime.utc(2016, 11, 13, 19)].map((dt) => this.extract(dt, intl, "dayperiod"));
				}
				return this.meridiemCache;
			});
		}
		eras(length) {
			return listStuff(this, length, eras, () => {
				const intl = { era: length };
				if (!this.eraCache[length]) this.eraCache[length] = [DateTime.utc(-40, 1, 1), DateTime.utc(2017, 1, 1)].map((dt) => this.extract(dt, intl, "era"));
				return this.eraCache[length];
			});
		}
		extract(dt, intlOpts, field) {
			const matching = this.dtFormatter(dt, intlOpts).formatToParts().find((m) => m.type.toLowerCase() === field);
			return matching ? matching.value : null;
		}
		numberFormatter(opts = {}) {
			return new PolyNumberFormatter(this.intl, opts.forceSimple || this.fastNumbers, opts);
		}
		dtFormatter(dt, intlOpts = {}) {
			return new PolyDateFormatter(dt, this.intl, intlOpts);
		}
		relFormatter(opts = {}) {
			return new PolyRelFormatter(this.intl, this.isEnglish(), opts);
		}
		listFormatter(opts = {}) {
			return getCachedLF(this.intl, opts);
		}
		isEnglish() {
			return this.locale === "en" || this.locale.toLowerCase() === "en-us" || getCachedIntResolvedOptions(this.intl).locale.startsWith("en-us");
		}
		getWeekSettings() {
			if (this.weekSettings) return this.weekSettings;
			else if (!hasLocaleWeekInfo()) return fallbackWeekSettings;
			else return getCachedWeekInfo(this.locale);
		}
		getStartOfWeek() {
			return this.getWeekSettings().firstDay;
		}
		getMinDaysInFirstWeek() {
			return this.getWeekSettings().minimalDays;
		}
		getWeekendDays() {
			return this.getWeekSettings().weekend;
		}
		equals(other) {
			return this.locale === other.locale && this.numberingSystem === other.numberingSystem && this.outputCalendar === other.outputCalendar;
		}
		toString() {
			return `Locale(${this.locale}, ${this.numberingSystem}, ${this.outputCalendar})`;
		}
	};
	let singleton = null;
	/**
	* A zone with a fixed offset (meaning no DST)
	* @implements {Zone}
	*/
	var FixedOffsetZone = class FixedOffsetZone extends Zone {
		/**
		* Get a singleton instance of UTC
		* @return {FixedOffsetZone}
		*/
		static get utcInstance() {
			if (singleton === null) singleton = new FixedOffsetZone(0);
			return singleton;
		}
		/**
		* Get an instance with a specified offset
		* @param {number} offset - The offset in minutes
		* @return {FixedOffsetZone}
		*/
		static instance(offset) {
			return offset === 0 ? FixedOffsetZone.utcInstance : new FixedOffsetZone(offset);
		}
		/**
		* Get an instance of FixedOffsetZone from a UTC offset string, like "UTC+6"
		* @param {string} s - The offset string to parse
		* @example FixedOffsetZone.parseSpecifier("UTC+6")
		* @example FixedOffsetZone.parseSpecifier("UTC+06")
		* @example FixedOffsetZone.parseSpecifier("UTC-6:00")
		* @return {FixedOffsetZone}
		*/
		static parseSpecifier(s) {
			if (s) {
				const r = s.match(/^utc(?:([+-]\d{1,2})(?::(\d{2}))?)?$/i);
				if (r) return new FixedOffsetZone(signedOffset(r[1], r[2]));
			}
			return null;
		}
		constructor(offset) {
			super();
			/** @private **/
			this.fixed = offset;
		}
		/**
		* The type of zone. `fixed` for all instances of `FixedOffsetZone`.
		* @override
		* @type {string}
		*/
		get type() {
			return "fixed";
		}
		/**
		* The name of this zone.
		* All fixed zones' names always start with "UTC" (plus optional offset)
		* @override
		* @type {string}
		*/
		get name() {
			return this.fixed === 0 ? "UTC" : `UTC${formatOffset(this.fixed, "narrow")}`;
		}
		/**
		* The IANA name of this zone, i.e. `Etc/UTC` or `Etc/GMT+/-nn`
		*
		* @override
		* @type {string}
		*/
		get ianaName() {
			if (this.fixed === 0) return "Etc/UTC";
			else return `Etc/GMT${formatOffset(-this.fixed, "narrow")}`;
		}
		/**
		* Returns the offset's common name at the specified timestamp.
		*
		* For fixed offset zones this equals to the zone name.
		* @override
		*/
		offsetName() {
			return this.name;
		}
		/**
		* Returns the offset's value as a string
		* @override
		* @param {number} ts - Epoch milliseconds for which to get the offset
		* @param {string} format - What style of offset to return.
		*                          Accepts 'narrow', 'short', or 'techie'. Returning '+6', '+06:00', or '+0600' respectively
		* @return {string}
		*/
		formatOffset(ts, format) {
			return formatOffset(this.fixed, format);
		}
		/**
		* Returns whether the offset is known to be fixed for the whole year:
		* Always returns true for all fixed offset zones.
		* @override
		* @type {boolean}
		*/
		get isUniversal() {
			return true;
		}
		/**
		* Return the offset in minutes for this zone at the specified timestamp.
		*
		* For fixed offset zones, this is constant and does not depend on a timestamp.
		* @override
		* @return {number}
		*/
		offset() {
			return this.fixed;
		}
		/**
		* Return whether this Zone is equal to another zone (i.e. also fixed and same offset)
		* @override
		* @param {Zone} otherZone - the zone to compare
		* @return {boolean}
		*/
		equals(otherZone) {
			return otherZone.type === "fixed" && otherZone.fixed === this.fixed;
		}
		/**
		* Return whether this Zone is valid:
		* All fixed offset zones are valid.
		* @override
		* @type {boolean}
		*/
		get isValid() {
			return true;
		}
	};
	/**
	* A zone that failed to parse. You should never need to instantiate this.
	* @implements {Zone}
	*/
	var InvalidZone = class extends Zone {
		constructor(zoneName) {
			super();
			/**  @private */
			this.zoneName = zoneName;
		}
		/** @override **/
		get type() {
			return "invalid";
		}
		/** @override **/
		get name() {
			return this.zoneName;
		}
		/** @override **/
		get isUniversal() {
			return false;
		}
		/** @override **/
		offsetName() {
			return null;
		}
		/** @override **/
		formatOffset() {
			return "";
		}
		/** @override **/
		offset() {
			return NaN;
		}
		/** @override **/
		equals() {
			return false;
		}
		/** @override **/
		get isValid() {
			return false;
		}
	};
	/**
	* @private
	*/
	function normalizeZone(input, defaultZone) {
		if (isUndefined(input) || input === null) return defaultZone;
		else if (input instanceof Zone) return input;
		else if (isString(input)) {
			const lowered = input.toLowerCase();
			if (lowered === "default") return defaultZone;
			else if (lowered === "local" || lowered === "system") return SystemZone.instance;
			else if (lowered === "utc" || lowered === "gmt") return FixedOffsetZone.utcInstance;
			else return FixedOffsetZone.parseSpecifier(lowered) || IANAZone.create(input);
		} else if (isNumber(input)) return FixedOffsetZone.instance(input);
		else if (typeof input === "object" && "offset" in input && typeof input.offset === "function") return input;
		else return new InvalidZone(input);
	}
	const numberingSystems = {
		arab: "[٠-٩]",
		arabext: "[۰-۹]",
		bali: "[᭐-᭙]",
		beng: "[০-৯]",
		deva: "[०-९]",
		fullwide: "[０-９]",
		gujr: "[૦-૯]",
		hanidec: "[〇|一|二|三|四|五|六|七|八|九]",
		khmr: "[០-៩]",
		knda: "[೦-೯]",
		laoo: "[໐-໙]",
		limb: "[᥆-᥏]",
		mlym: "[൦-൯]",
		mong: "[᠐-᠙]",
		mymr: "[၀-၉]",
		orya: "[୦-୯]",
		tamldec: "[௦-௯]",
		telu: "[౦-౯]",
		thai: "[๐-๙]",
		tibt: "[༠-༩]",
		latn: "\\d"
	};
	const numberingSystemsUTF16 = {
		arab: [1632, 1641],
		arabext: [1776, 1785],
		bali: [6992, 7001],
		beng: [2534, 2543],
		deva: [2406, 2415],
		fullwide: [65296, 65303],
		gujr: [2790, 2799],
		khmr: [6112, 6121],
		knda: [3302, 3311],
		laoo: [3792, 3801],
		limb: [6470, 6479],
		mlym: [3430, 3439],
		mong: [6160, 6169],
		mymr: [4160, 4169],
		orya: [2918, 2927],
		tamldec: [3046, 3055],
		telu: [3174, 3183],
		thai: [3664, 3673],
		tibt: [3872, 3881]
	};
	const hanidecChars = numberingSystems.hanidec.replace(/[\[|\]]/g, "").split("");
	function parseDigits(str) {
		let value = parseInt(str, 10);
		if (isNaN(value)) {
			value = "";
			for (let i = 0; i < str.length; i++) {
				const code = str.charCodeAt(i);
				if (str[i].search(numberingSystems.hanidec) !== -1) value += hanidecChars.indexOf(str[i]);
				else for (const key in numberingSystemsUTF16) {
					const [min, max] = numberingSystemsUTF16[key];
					if (code >= min && code <= max) value += code - min;
				}
			}
			return parseInt(value, 10);
		} else return value;
	}
	const digitRegexCache = /* @__PURE__ */ new Map();
	function resetDigitRegexCache() {
		digitRegexCache.clear();
	}
	function digitRegex({ numberingSystem }, append = "") {
		const ns = numberingSystem || "latn";
		let appendCache = digitRegexCache.get(ns);
		if (appendCache === void 0) {
			appendCache = /* @__PURE__ */ new Map();
			digitRegexCache.set(ns, appendCache);
		}
		let regex = appendCache.get(append);
		if (regex === void 0) {
			regex = new RegExp(`${numberingSystems[ns]}${append}`);
			appendCache.set(append, regex);
		}
		return regex;
	}
	let now = () => Date.now(), defaultZone = "system", defaultLocale = null, defaultNumberingSystem = null, defaultOutputCalendar = null, twoDigitCutoffYear = 60, throwOnInvalid, defaultWeekSettings = null;
	/**
	* Settings contains static getters and setters that control Luxon's overall behavior. Luxon is a simple library with few options, but the ones it does have live here.
	*/
	var Settings = class {
		/**
		* Get the callback for returning the current timestamp.
		* @type {function}
		*/
		static get now() {
			return now;
		}
		/**
		* Set the callback for returning the current timestamp.
		* The function should return a number, which will be interpreted as an Epoch millisecond count
		* @type {function}
		* @example Settings.now = () => Date.now() + 3000 // pretend it is 3 seconds in the future
		* @example Settings.now = () => 0 // always pretend it's Jan 1, 1970 at midnight in UTC time
		*/
		static set now(n) {
			now = n;
		}
		/**
		* Set the default time zone to create DateTimes in. Does not affect existing instances.
		* Use the value "system" to reset this value to the system's time zone.
		* @type {string}
		*/
		static set defaultZone(zone) {
			defaultZone = zone;
		}
		/**
		* Get the default time zone object currently used to create DateTimes. Does not affect existing instances.
		* The default value is the system's time zone (the one set on the machine that runs this code).
		* @type {Zone}
		*/
		static get defaultZone() {
			return normalizeZone(defaultZone, SystemZone.instance);
		}
		/**
		* Get the default locale to create DateTimes with. Does not affect existing instances.
		* @type {string}
		*/
		static get defaultLocale() {
			return defaultLocale;
		}
		/**
		* Set the default locale to create DateTimes with. Does not affect existing instances.
		* @type {string}
		*/
		static set defaultLocale(locale) {
			defaultLocale = locale;
		}
		/**
		* Get the default numbering system to create DateTimes with. Does not affect existing instances.
		* @type {string}
		*/
		static get defaultNumberingSystem() {
			return defaultNumberingSystem;
		}
		/**
		* Set the default numbering system to create DateTimes with. Does not affect existing instances.
		* @type {string}
		*/
		static set defaultNumberingSystem(numberingSystem) {
			defaultNumberingSystem = numberingSystem;
		}
		/**
		* Get the default output calendar to create DateTimes with. Does not affect existing instances.
		* @type {string}
		*/
		static get defaultOutputCalendar() {
			return defaultOutputCalendar;
		}
		/**
		* Set the default output calendar to create DateTimes with. Does not affect existing instances.
		* @type {string}
		*/
		static set defaultOutputCalendar(outputCalendar) {
			defaultOutputCalendar = outputCalendar;
		}
		/**
		* @typedef {Object} WeekSettings
		* @property {number} firstDay
		* @property {number} minimalDays
		* @property {number[]} weekend
		*/
		/**
		* @return {WeekSettings|null}
		*/
		static get defaultWeekSettings() {
			return defaultWeekSettings;
		}
		/**
		* Allows overriding the default locale week settings, i.e. the start of the week, the weekend and
		* how many days are required in the first week of a year.
		* Does not affect existing instances.
		*
		* @param {WeekSettings|null} weekSettings
		*/
		static set defaultWeekSettings(weekSettings) {
			defaultWeekSettings = validateWeekSettings(weekSettings);
		}
		/**
		* Get the cutoff year for whether a 2-digit year string is interpreted in the current or previous century. Numbers higher than the cutoff will be considered to mean 19xx and numbers lower or equal to the cutoff will be considered 20xx.
		* @type {number}
		*/
		static get twoDigitCutoffYear() {
			return twoDigitCutoffYear;
		}
		/**
		* Set the cutoff year for whether a 2-digit year string is interpreted in the current or previous century. Numbers higher than the cutoff will be considered to mean 19xx and numbers lower or equal to the cutoff will be considered 20xx.
		* @type {number}
		* @example Settings.twoDigitCutoffYear = 0 // all 'yy' are interpreted as 20th century
		* @example Settings.twoDigitCutoffYear = 99 // all 'yy' are interpreted as 21st century
		* @example Settings.twoDigitCutoffYear = 50 // '49' -> 2049; '50' -> 1950
		* @example Settings.twoDigitCutoffYear = 1950 // interpreted as 50
		* @example Settings.twoDigitCutoffYear = 2050 // ALSO interpreted as 50
		*/
		static set twoDigitCutoffYear(cutoffYear) {
			twoDigitCutoffYear = cutoffYear % 100;
		}
		/**
		* Get whether Luxon will throw when it encounters invalid DateTimes, Durations, or Intervals
		* @type {boolean}
		*/
		static get throwOnInvalid() {
			return throwOnInvalid;
		}
		/**
		* Set whether Luxon will throw when it encounters invalid DateTimes, Durations, or Intervals
		* @type {boolean}
		*/
		static set throwOnInvalid(t) {
			throwOnInvalid = t;
		}
		/**
		* Reset Luxon's global caches. Should only be necessary in testing scenarios.
		* @return {void}
		*/
		static resetCaches() {
			Locale.resetCache();
			IANAZone.resetCache();
			DateTime.resetCache();
			resetDigitRegexCache();
		}
	};
	var Invalid = class {
		constructor(reason, explanation) {
			this.reason = reason;
			this.explanation = explanation;
		}
		toMessage() {
			if (this.explanation) return `${this.reason}: ${this.explanation}`;
			else return this.reason;
		}
	};
	const nonLeapLadder = [
		0,
		31,
		59,
		90,
		120,
		151,
		181,
		212,
		243,
		273,
		304,
		334
	], leapLadder = [
		0,
		31,
		60,
		91,
		121,
		152,
		182,
		213,
		244,
		274,
		305,
		335
	];
	function unitOutOfRange(unit, value) {
		return new Invalid("unit out of range", `you specified ${value} (of type ${typeof value}) as a ${unit}, which is invalid`);
	}
	function dayOfWeek(year, month, day) {
		const d = new Date(Date.UTC(year, month - 1, day));
		if (year < 100 && year >= 0) d.setUTCFullYear(d.getUTCFullYear() - 1900);
		const js = d.getUTCDay();
		return js === 0 ? 7 : js;
	}
	function computeOrdinal(year, month, day) {
		return day + (isLeapYear(year) ? leapLadder : nonLeapLadder)[month - 1];
	}
	function uncomputeOrdinal(year, ordinal) {
		const table = isLeapYear(year) ? leapLadder : nonLeapLadder, month0 = table.findIndex((i) => i < ordinal), day = ordinal - table[month0];
		return {
			month: month0 + 1,
			day
		};
	}
	function isoWeekdayToLocal(isoWeekday, startOfWeek) {
		return (isoWeekday - startOfWeek + 7) % 7 + 1;
	}
	/**
	* @private
	*/
	function gregorianToWeek(gregObj, minDaysInFirstWeek = 4, startOfWeek = 1) {
		const { year, month, day } = gregObj, ordinal = computeOrdinal(year, month, day), weekday = isoWeekdayToLocal(dayOfWeek(year, month, day), startOfWeek);
		let weekNumber = Math.floor((ordinal - weekday + 14 - minDaysInFirstWeek) / 7), weekYear;
		if (weekNumber < 1) {
			weekYear = year - 1;
			weekNumber = weeksInWeekYear(weekYear, minDaysInFirstWeek, startOfWeek);
		} else if (weekNumber > weeksInWeekYear(year, minDaysInFirstWeek, startOfWeek)) {
			weekYear = year + 1;
			weekNumber = 1;
		} else weekYear = year;
		return {
			weekYear,
			weekNumber,
			weekday,
			...timeObject(gregObj)
		};
	}
	function weekToGregorian(weekData, minDaysInFirstWeek = 4, startOfWeek = 1) {
		const { weekYear, weekNumber, weekday } = weekData, weekdayOfJan4 = isoWeekdayToLocal(dayOfWeek(weekYear, 1, minDaysInFirstWeek), startOfWeek), yearInDays = daysInYear(weekYear);
		let ordinal = weekNumber * 7 + weekday - weekdayOfJan4 - 7 + minDaysInFirstWeek, year;
		if (ordinal < 1) {
			year = weekYear - 1;
			ordinal += daysInYear(year);
		} else if (ordinal > yearInDays) {
			year = weekYear + 1;
			ordinal -= daysInYear(weekYear);
		} else year = weekYear;
		const { month, day } = uncomputeOrdinal(year, ordinal);
		return {
			year,
			month,
			day,
			...timeObject(weekData)
		};
	}
	function gregorianToOrdinal(gregData) {
		const { year, month, day } = gregData;
		return {
			year,
			ordinal: computeOrdinal(year, month, day),
			...timeObject(gregData)
		};
	}
	function ordinalToGregorian(ordinalData) {
		const { year, ordinal } = ordinalData;
		const { month, day } = uncomputeOrdinal(year, ordinal);
		return {
			year,
			month,
			day,
			...timeObject(ordinalData)
		};
	}
	/**
	* Check if local week units like localWeekday are used in obj.
	* If so, validates that they are not mixed with ISO week units and then copies them to the normal week unit properties.
	* Modifies obj in-place!
	* @param obj the object values
	*/
	function usesLocalWeekValues(obj, loc) {
		if (!isUndefined(obj.localWeekday) || !isUndefined(obj.localWeekNumber) || !isUndefined(obj.localWeekYear)) {
			if (!isUndefined(obj.weekday) || !isUndefined(obj.weekNumber) || !isUndefined(obj.weekYear)) throw new ConflictingSpecificationError("Cannot mix locale-based week fields with ISO-based week fields");
			if (!isUndefined(obj.localWeekday)) obj.weekday = obj.localWeekday;
			if (!isUndefined(obj.localWeekNumber)) obj.weekNumber = obj.localWeekNumber;
			if (!isUndefined(obj.localWeekYear)) obj.weekYear = obj.localWeekYear;
			delete obj.localWeekday;
			delete obj.localWeekNumber;
			delete obj.localWeekYear;
			return {
				minDaysInFirstWeek: loc.getMinDaysInFirstWeek(),
				startOfWeek: loc.getStartOfWeek()
			};
		} else return {
			minDaysInFirstWeek: 4,
			startOfWeek: 1
		};
	}
	function hasInvalidWeekData(obj, minDaysInFirstWeek = 4, startOfWeek = 1) {
		const validYear = isInteger(obj.weekYear), validWeek = integerBetween(obj.weekNumber, 1, weeksInWeekYear(obj.weekYear, minDaysInFirstWeek, startOfWeek)), validWeekday = integerBetween(obj.weekday, 1, 7);
		if (!validYear) return unitOutOfRange("weekYear", obj.weekYear);
		else if (!validWeek) return unitOutOfRange("week", obj.weekNumber);
		else if (!validWeekday) return unitOutOfRange("weekday", obj.weekday);
		else return false;
	}
	function hasInvalidOrdinalData(obj) {
		const validYear = isInteger(obj.year), validOrdinal = integerBetween(obj.ordinal, 1, daysInYear(obj.year));
		if (!validYear) return unitOutOfRange("year", obj.year);
		else if (!validOrdinal) return unitOutOfRange("ordinal", obj.ordinal);
		else return false;
	}
	function hasInvalidGregorianData(obj) {
		const validYear = isInteger(obj.year), validMonth = integerBetween(obj.month, 1, 12), validDay = integerBetween(obj.day, 1, daysInMonth(obj.year, obj.month));
		if (!validYear) return unitOutOfRange("year", obj.year);
		else if (!validMonth) return unitOutOfRange("month", obj.month);
		else if (!validDay) return unitOutOfRange("day", obj.day);
		else return false;
	}
	function hasInvalidTimeData(obj) {
		const { hour, minute, second, millisecond } = obj;
		const validHour = integerBetween(hour, 0, 23) || hour === 24 && minute === 0 && second === 0 && millisecond === 0, validMinute = integerBetween(minute, 0, 59), validSecond = integerBetween(second, 0, 59), validMillisecond = integerBetween(millisecond, 0, 999);
		if (!validHour) return unitOutOfRange("hour", hour);
		else if (!validMinute) return unitOutOfRange("minute", minute);
		else if (!validSecond) return unitOutOfRange("second", second);
		else if (!validMillisecond) return unitOutOfRange("millisecond", millisecond);
		else return false;
	}
	/**
	* @private
	*/
	function isUndefined(o) {
		return typeof o === "undefined";
	}
	function isNumber(o) {
		return typeof o === "number";
	}
	function isInteger(o) {
		return typeof o === "number" && o % 1 === 0;
	}
	function isString(o) {
		return typeof o === "string";
	}
	function isDate(o) {
		return Object.prototype.toString.call(o) === "[object Date]";
	}
	function hasRelative() {
		try {
			return typeof Intl !== "undefined" && !!Intl.RelativeTimeFormat;
		} catch (e) {
			return false;
		}
	}
	function hasLocaleWeekInfo() {
		try {
			return typeof Intl !== "undefined" && !!Intl.Locale && ("weekInfo" in Intl.Locale.prototype || "getWeekInfo" in Intl.Locale.prototype);
		} catch (e) {
			return false;
		}
	}
	function maybeArray(thing) {
		return Array.isArray(thing) ? thing : [thing];
	}
	function bestBy(arr, by, compare) {
		if (arr.length === 0) return;
		return arr.reduce((best, next) => {
			const pair = [by(next), next];
			if (!best) return pair;
			else if (compare(best[0], pair[0]) === best[0]) return best;
			else return pair;
		}, null)[1];
	}
	function pick(obj, keys) {
		return keys.reduce((a, k) => {
			a[k] = obj[k];
			return a;
		}, {});
	}
	function hasOwnProperty(obj, prop) {
		return Object.prototype.hasOwnProperty.call(obj, prop);
	}
	function validateWeekSettings(settings) {
		if (settings == null) return null;
		else if (typeof settings !== "object") throw new InvalidArgumentError("Week settings must be an object");
		else {
			if (!integerBetween(settings.firstDay, 1, 7) || !integerBetween(settings.minimalDays, 1, 7) || !Array.isArray(settings.weekend) || settings.weekend.some((v) => !integerBetween(v, 1, 7))) throw new InvalidArgumentError("Invalid week settings");
			return {
				firstDay: settings.firstDay,
				minimalDays: settings.minimalDays,
				weekend: Array.from(settings.weekend)
			};
		}
	}
	function integerBetween(thing, bottom, top) {
		return isInteger(thing) && thing >= bottom && thing <= top;
	}
	function floorMod(x, n) {
		return x - n * Math.floor(x / n);
	}
	function padStart(input, n = 2) {
		const isNeg = input < 0;
		let padded;
		if (isNeg) padded = "-" + ("" + -input).padStart(n, "0");
		else padded = ("" + input).padStart(n, "0");
		return padded;
	}
	function parseInteger(string) {
		if (isUndefined(string) || string === null || string === "") return;
		else return parseInt(string, 10);
	}
	function parseFloating(string) {
		if (isUndefined(string) || string === null || string === "") return;
		else return parseFloat(string);
	}
	function parseMillis(fraction) {
		if (isUndefined(fraction) || fraction === null || fraction === "") return;
		else {
			const f = parseFloat("0." + fraction) * 1e3;
			return Math.floor(f);
		}
	}
	function roundTo(number, digits, rounding = "round") {
		const factor = 10 ** digits;
		switch (rounding) {
			case "expand": return number > 0 ? Math.ceil(number * factor) / factor : Math.floor(number * factor) / factor;
			case "trunc": return Math.trunc(number * factor) / factor;
			case "round": return Math.round(number * factor) / factor;
			case "floor": return Math.floor(number * factor) / factor;
			case "ceil": return Math.ceil(number * factor) / factor;
			default: throw new RangeError(`Value rounding ${rounding} is out of range`);
		}
	}
	function isLeapYear(year) {
		return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	}
	function daysInYear(year) {
		return isLeapYear(year) ? 366 : 365;
	}
	function daysInMonth(year, month) {
		const modMonth = floorMod(month - 1, 12) + 1, modYear = year + (month - modMonth) / 12;
		if (modMonth === 2) return isLeapYear(modYear) ? 29 : 28;
		else return [
			31,
			null,
			31,
			30,
			31,
			30,
			31,
			31,
			30,
			31,
			30,
			31
		][modMonth - 1];
	}
	function objToLocalTS(obj) {
		let d = Date.UTC(obj.year, obj.month - 1, obj.day, obj.hour, obj.minute, obj.second, obj.millisecond);
		if (obj.year < 100 && obj.year >= 0) {
			d = new Date(d);
			d.setUTCFullYear(obj.year, obj.month - 1, obj.day);
		}
		return +d;
	}
	function firstWeekOffset(year, minDaysInFirstWeek, startOfWeek) {
		return -isoWeekdayToLocal(dayOfWeek(year, 1, minDaysInFirstWeek), startOfWeek) + minDaysInFirstWeek - 1;
	}
	function weeksInWeekYear(weekYear, minDaysInFirstWeek = 4, startOfWeek = 1) {
		const weekOffset = firstWeekOffset(weekYear, minDaysInFirstWeek, startOfWeek);
		const weekOffsetNext = firstWeekOffset(weekYear + 1, minDaysInFirstWeek, startOfWeek);
		return (daysInYear(weekYear) - weekOffset + weekOffsetNext) / 7;
	}
	function untruncateYear(year) {
		if (year > 99) return year;
		else return year > Settings.twoDigitCutoffYear ? 1900 + year : 2e3 + year;
	}
	function parseZoneInfo(ts, offsetFormat, locale, timeZone = null) {
		const date = new Date(ts), intlOpts = {
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit"
		};
		if (timeZone) intlOpts.timeZone = timeZone;
		const modified = {
			timeZoneName: offsetFormat,
			...intlOpts
		};
		const parsed = new Intl.DateTimeFormat(locale, modified).formatToParts(date).find((m) => m.type.toLowerCase() === "timezonename");
		return parsed ? parsed.value : null;
	}
	function signedOffset(offHourStr, offMinuteStr) {
		let offHour = parseInt(offHourStr, 10);
		if (Number.isNaN(offHour)) offHour = 0;
		const offMin = parseInt(offMinuteStr, 10) || 0, offMinSigned = offHour < 0 || Object.is(offHour, -0) ? -offMin : offMin;
		return offHour * 60 + offMinSigned;
	}
	function asNumber(value) {
		const numericValue = Number(value);
		if (typeof value === "boolean" || value === "" || !Number.isFinite(numericValue)) throw new InvalidArgumentError(`Invalid unit value ${value}`);
		return numericValue;
	}
	function normalizeObject(obj, normalizer) {
		const normalized = {};
		for (const u in obj) if (hasOwnProperty(obj, u)) {
			const v = obj[u];
			if (v === void 0 || v === null) continue;
			normalized[normalizer(u)] = asNumber(v);
		}
		return normalized;
	}
	/**
	* Returns the offset's value as a string
	* @param {number} ts - Epoch milliseconds for which to get the offset
	* @param {string} format - What style of offset to return.
	*                          Accepts 'narrow', 'short', or 'techie'. Returning '+6', '+06:00', or '+0600' respectively
	* @return {string}
	*/
	function formatOffset(offset, format) {
		const hours = Math.trunc(Math.abs(offset / 60)), minutes = Math.trunc(Math.abs(offset % 60)), sign = offset >= 0 ? "+" : "-";
		switch (format) {
			case "short": return `${sign}${padStart(hours, 2)}:${padStart(minutes, 2)}`;
			case "narrow": return `${sign}${hours}${minutes > 0 ? `:${minutes}` : ""}`;
			case "techie": return `${sign}${padStart(hours, 2)}${padStart(minutes, 2)}`;
			default: throw new RangeError(`Value format ${format} is out of range for property format`);
		}
	}
	function timeObject(obj) {
		return pick(obj, [
			"hour",
			"minute",
			"second",
			"millisecond"
		]);
	}
	/**
	* @private
	*/
	const monthsLong = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December"
	];
	const monthsShort = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec"
	];
	const monthsNarrow = [
		"J",
		"F",
		"M",
		"A",
		"M",
		"J",
		"J",
		"A",
		"S",
		"O",
		"N",
		"D"
	];
	function months(length) {
		switch (length) {
			case "narrow": return [...monthsNarrow];
			case "short": return [...monthsShort];
			case "long": return [...monthsLong];
			case "numeric": return [
				"1",
				"2",
				"3",
				"4",
				"5",
				"6",
				"7",
				"8",
				"9",
				"10",
				"11",
				"12"
			];
			case "2-digit": return [
				"01",
				"02",
				"03",
				"04",
				"05",
				"06",
				"07",
				"08",
				"09",
				"10",
				"11",
				"12"
			];
			default: return null;
		}
	}
	const weekdaysLong = [
		"Monday",
		"Tuesday",
		"Wednesday",
		"Thursday",
		"Friday",
		"Saturday",
		"Sunday"
	];
	const weekdaysShort = [
		"Mon",
		"Tue",
		"Wed",
		"Thu",
		"Fri",
		"Sat",
		"Sun"
	];
	const weekdaysNarrow = [
		"M",
		"T",
		"W",
		"T",
		"F",
		"S",
		"S"
	];
	function weekdays(length) {
		switch (length) {
			case "narrow": return [...weekdaysNarrow];
			case "short": return [...weekdaysShort];
			case "long": return [...weekdaysLong];
			case "numeric": return [
				"1",
				"2",
				"3",
				"4",
				"5",
				"6",
				"7"
			];
			default: return null;
		}
	}
	const meridiems = ["AM", "PM"];
	const erasLong = ["Before Christ", "Anno Domini"];
	const erasShort = ["BC", "AD"];
	const erasNarrow = ["B", "A"];
	function eras(length) {
		switch (length) {
			case "narrow": return [...erasNarrow];
			case "short": return [...erasShort];
			case "long": return [...erasLong];
			default: return null;
		}
	}
	function meridiemForDateTime(dt) {
		return meridiems[dt.hour < 12 ? 0 : 1];
	}
	function weekdayForDateTime(dt, length) {
		return weekdays(length)[dt.weekday - 1];
	}
	function monthForDateTime(dt, length) {
		return months(length)[dt.month - 1];
	}
	function eraForDateTime(dt, length) {
		return eras(length)[dt.year < 0 ? 0 : 1];
	}
	function formatRelativeTime(unit, count, numeric = "always", narrow = false) {
		const units = {
			years: ["year", "yr."],
			quarters: ["quarter", "qtr."],
			months: ["month", "mo."],
			weeks: ["week", "wk."],
			days: [
				"day",
				"day",
				"days"
			],
			hours: ["hour", "hr."],
			minutes: ["minute", "min."],
			seconds: ["second", "sec."]
		};
		const lastable = [
			"hours",
			"minutes",
			"seconds"
		].indexOf(unit) === -1;
		if (numeric === "auto" && lastable) {
			const isDay = unit === "days";
			switch (count) {
				case 1: return isDay ? "tomorrow" : `next ${units[unit][0]}`;
				case -1: return isDay ? "yesterday" : `last ${units[unit][0]}`;
				case 0: return isDay ? "today" : `this ${units[unit][0]}`;
			}
		}
		const isInPast = Object.is(count, -0) || count < 0, fmtValue = Math.abs(count), singular = fmtValue === 1, lilUnits = units[unit], fmtUnit = narrow ? singular ? lilUnits[1] : lilUnits[2] || lilUnits[1] : singular ? units[unit][0] : unit;
		return isInPast ? `${fmtValue} ${fmtUnit} ago` : `in ${fmtValue} ${fmtUnit}`;
	}
	function stringifyTokens(splits, tokenToString) {
		let s = "";
		for (const token of splits) if (token.literal) s += token.val;
		else s += tokenToString(token.val);
		return s;
	}
	const macroTokenToFormatOpts = {
		D: DATE_SHORT,
		DD: DATE_MED,
		DDD: DATE_FULL,
		DDDD: DATE_HUGE,
		t: TIME_SIMPLE,
		tt: TIME_WITH_SECONDS,
		ttt: TIME_WITH_SHORT_OFFSET,
		tttt: TIME_WITH_LONG_OFFSET,
		T: TIME_24_SIMPLE,
		TT: TIME_24_WITH_SECONDS,
		TTT: TIME_24_WITH_SHORT_OFFSET,
		TTTT: TIME_24_WITH_LONG_OFFSET,
		f: DATETIME_SHORT,
		ff: DATETIME_MED,
		fff: DATETIME_FULL,
		ffff: DATETIME_HUGE,
		F: DATETIME_SHORT_WITH_SECONDS,
		FF: DATETIME_MED_WITH_SECONDS,
		FFF: DATETIME_FULL_WITH_SECONDS,
		FFFF: DATETIME_HUGE_WITH_SECONDS
	};
	/**
	* @private
	*/
	var Formatter = class Formatter {
		static create(locale, opts = {}) {
			return new Formatter(locale, opts);
		}
		static parseFormat(fmt) {
			let current = null, currentFull = "", bracketed = false;
			const splits = [];
			for (let i = 0; i < fmt.length; i++) {
				const c = fmt.charAt(i);
				if (c === "'") {
					if (currentFull.length > 0 || bracketed) splits.push({
						literal: bracketed || /^\s+$/.test(currentFull),
						val: currentFull === "" ? "'" : currentFull
					});
					current = null;
					currentFull = "";
					bracketed = !bracketed;
				} else if (bracketed) currentFull += c;
				else if (c === current) currentFull += c;
				else {
					if (currentFull.length > 0) splits.push({
						literal: /^\s+$/.test(currentFull),
						val: currentFull
					});
					currentFull = c;
					current = c;
				}
			}
			if (currentFull.length > 0) splits.push({
				literal: bracketed || /^\s+$/.test(currentFull),
				val: currentFull
			});
			return splits;
		}
		static macroTokenToFormatOpts(token) {
			return macroTokenToFormatOpts[token];
		}
		constructor(locale, formatOpts) {
			this.opts = formatOpts;
			this.loc = locale;
			this.systemLoc = null;
		}
		formatWithSystemDefault(dt, opts) {
			if (this.systemLoc === null) this.systemLoc = this.loc.redefaultToSystem();
			return this.systemLoc.dtFormatter(dt, {
				...this.opts,
				...opts
			}).format();
		}
		dtFormatter(dt, opts = {}) {
			return this.loc.dtFormatter(dt, {
				...this.opts,
				...opts
			});
		}
		formatDateTime(dt, opts) {
			return this.dtFormatter(dt, opts).format();
		}
		formatDateTimeParts(dt, opts) {
			return this.dtFormatter(dt, opts).formatToParts();
		}
		formatInterval(interval, opts) {
			return this.dtFormatter(interval.start, opts).dtf.formatRange(interval.start.toJSDate(), interval.end.toJSDate());
		}
		resolvedOptions(dt, opts) {
			return this.dtFormatter(dt, opts).resolvedOptions();
		}
		num(n, p = 0, signDisplay = void 0) {
			if (this.opts.forceSimple) return padStart(n, p);
			const opts = { ...this.opts };
			if (p > 0) opts.padTo = p;
			if (signDisplay) opts.signDisplay = signDisplay;
			return this.loc.numberFormatter(opts).format(n);
		}
		formatDateTimeFromString(dt, fmt) {
			const knownEnglish = this.loc.listingMode() === "en", useDateTimeFormatter = this.loc.outputCalendar && this.loc.outputCalendar !== "gregory", string = (opts, extract) => this.loc.extract(dt, opts, extract), formatOffset = (opts) => {
				if (dt.isOffsetFixed && dt.offset === 0 && opts.allowZ) return "Z";
				return dt.isValid ? dt.zone.formatOffset(dt.ts, opts.format) : "";
			}, meridiem = () => knownEnglish ? meridiemForDateTime(dt) : string({
				hour: "numeric",
				hourCycle: "h12"
			}, "dayperiod"), month = (length, standalone) => knownEnglish ? monthForDateTime(dt, length) : string(standalone ? { month: length } : {
				month: length,
				day: "numeric"
			}, "month"), weekday = (length, standalone) => knownEnglish ? weekdayForDateTime(dt, length) : string(standalone ? { weekday: length } : {
				weekday: length,
				month: "long",
				day: "numeric"
			}, "weekday"), maybeMacro = (token) => {
				const formatOpts = Formatter.macroTokenToFormatOpts(token);
				if (formatOpts) return this.formatWithSystemDefault(dt, formatOpts);
				else return token;
			}, era = (length) => knownEnglish ? eraForDateTime(dt, length) : string({ era: length }, "era"), tokenToString = (token) => {
				switch (token) {
					case "S": return this.num(dt.millisecond);
					case "u":
					case "SSS": return this.num(dt.millisecond, 3);
					case "s": return this.num(dt.second);
					case "ss": return this.num(dt.second, 2);
					case "uu": return this.num(Math.floor(dt.millisecond / 10), 2);
					case "uuu": return this.num(Math.floor(dt.millisecond / 100));
					case "m": return this.num(dt.minute);
					case "mm": return this.num(dt.minute, 2);
					case "h": return this.num(dt.hour % 12 === 0 ? 12 : dt.hour % 12);
					case "hh": return this.num(dt.hour % 12 === 0 ? 12 : dt.hour % 12, 2);
					case "H": return this.num(dt.hour);
					case "HH": return this.num(dt.hour, 2);
					case "Z": return formatOffset({
						format: "narrow",
						allowZ: this.opts.allowZ
					});
					case "ZZ": return formatOffset({
						format: "short",
						allowZ: this.opts.allowZ
					});
					case "ZZZ": return formatOffset({
						format: "techie",
						allowZ: this.opts.allowZ
					});
					case "ZZZZ": return dt.zone.offsetName(dt.ts, {
						format: "short",
						locale: this.loc.locale
					});
					case "ZZZZZ": return dt.zone.offsetName(dt.ts, {
						format: "long",
						locale: this.loc.locale
					});
					case "z": return dt.zoneName;
					case "a": return meridiem();
					case "d": return useDateTimeFormatter ? string({ day: "numeric" }, "day") : this.num(dt.day);
					case "dd": return useDateTimeFormatter ? string({ day: "2-digit" }, "day") : this.num(dt.day, 2);
					case "c": return this.num(dt.weekday);
					case "ccc": return weekday("short", true);
					case "cccc": return weekday("long", true);
					case "ccccc": return weekday("narrow", true);
					case "E": return this.num(dt.weekday);
					case "EEE": return weekday("short", false);
					case "EEEE": return weekday("long", false);
					case "EEEEE": return weekday("narrow", false);
					case "L": return useDateTimeFormatter ? string({
						month: "numeric",
						day: "numeric"
					}, "month") : this.num(dt.month);
					case "LL": return useDateTimeFormatter ? string({
						month: "2-digit",
						day: "numeric"
					}, "month") : this.num(dt.month, 2);
					case "LLL": return month("short", true);
					case "LLLL": return month("long", true);
					case "LLLLL": return month("narrow", true);
					case "M": return useDateTimeFormatter ? string({ month: "numeric" }, "month") : this.num(dt.month);
					case "MM": return useDateTimeFormatter ? string({ month: "2-digit" }, "month") : this.num(dt.month, 2);
					case "MMM": return month("short", false);
					case "MMMM": return month("long", false);
					case "MMMMM": return month("narrow", false);
					case "y": return useDateTimeFormatter ? string({ year: "numeric" }, "year") : this.num(dt.year);
					case "yy": return useDateTimeFormatter ? string({ year: "2-digit" }, "year") : this.num(dt.year.toString().slice(-2), 2);
					case "yyyy": return useDateTimeFormatter ? string({ year: "numeric" }, "year") : this.num(dt.year, 4);
					case "yyyyyy": return useDateTimeFormatter ? string({ year: "numeric" }, "year") : this.num(dt.year, 6);
					case "G": return era("short");
					case "GG": return era("long");
					case "GGGGG": return era("narrow");
					case "kk": return this.num(dt.weekYear.toString().slice(-2), 2);
					case "kkkk": return this.num(dt.weekYear, 4);
					case "W": return this.num(dt.weekNumber);
					case "WW": return this.num(dt.weekNumber, 2);
					case "n": return this.num(dt.localWeekNumber);
					case "nn": return this.num(dt.localWeekNumber, 2);
					case "ii": return this.num(dt.localWeekYear.toString().slice(-2), 2);
					case "iiii": return this.num(dt.localWeekYear, 4);
					case "o": return this.num(dt.ordinal);
					case "ooo": return this.num(dt.ordinal, 3);
					case "q": return this.num(dt.quarter);
					case "qq": return this.num(dt.quarter, 2);
					case "X": return this.num(Math.floor(dt.ts / 1e3));
					case "x": return this.num(dt.ts);
					default: return maybeMacro(token);
				}
			};
			return stringifyTokens(Formatter.parseFormat(fmt), tokenToString);
		}
		formatDurationFromString(dur, fmt) {
			const invertLargest = this.opts.signMode === "negativeLargestOnly" ? -1 : 1;
			const tokenToField = (token) => {
				switch (token[0]) {
					case "S": return "milliseconds";
					case "s": return "seconds";
					case "m": return "minutes";
					case "h": return "hours";
					case "d": return "days";
					case "w": return "weeks";
					case "M": return "months";
					case "y": return "years";
					default: return null;
				}
			}, tokenToString = (lildur, info) => (token) => {
				const mapped = tokenToField(token);
				if (mapped) {
					const inversionFactor = info.isNegativeDuration && mapped !== info.largestUnit ? invertLargest : 1;
					let signDisplay;
					if (this.opts.signMode === "negativeLargestOnly" && mapped !== info.largestUnit) signDisplay = "never";
					else if (this.opts.signMode === "all") signDisplay = "always";
					else signDisplay = "auto";
					return this.num(lildur.get(mapped) * inversionFactor, token.length, signDisplay);
				} else return token;
			}, tokens = Formatter.parseFormat(fmt), realTokens = tokens.reduce((found, { literal, val }) => literal ? found : found.concat(val), []), collapsed = dur.shiftTo(...realTokens.map(tokenToField).filter((t) => t));
			return stringifyTokens(tokens, tokenToString(collapsed, {
				isNegativeDuration: collapsed < 0,
				largestUnit: Object.keys(collapsed.values)[0]
			}));
		}
	};
	const ianaRegex = /[A-Za-z_+-]{1,256}(?::?\/[A-Za-z0-9_+-]{1,256}(?:\/[A-Za-z0-9_+-]{1,256})?)?/;
	function combineRegexes(...regexes) {
		const full = regexes.reduce((f, r) => f + r.source, "");
		return RegExp(`^${full}$`);
	}
	function combineExtractors(...extractors) {
		return (m) => extractors.reduce(([mergedVals, mergedZone, cursor], ex) => {
			const [val, zone, next] = ex(m, cursor);
			return [
				{
					...mergedVals,
					...val
				},
				zone || mergedZone,
				next
			];
		}, [
			{},
			null,
			1
		]).slice(0, 2);
	}
	function parse(s, ...patterns) {
		if (s == null) return [null, null];
		for (const [regex, extractor] of patterns) {
			const m = regex.exec(s);
			if (m) return extractor(m);
		}
		return [null, null];
	}
	function simpleParse(...keys) {
		return (match, cursor) => {
			const ret = {};
			let i;
			for (i = 0; i < keys.length; i++) ret[keys[i]] = parseInteger(match[cursor + i]);
			return [
				ret,
				null,
				cursor + i
			];
		};
	}
	const offsetRegex = /(?:([Zz])|([+-]\d\d)(?::?(\d\d))?)/;
	const isoExtendedZone = `(?:${offsetRegex.source}?(?:\\[(${ianaRegex.source})\\])?)?`;
	const isoTimeBaseRegex = /(\d\d)(?::?(\d\d)(?::?(\d\d)(?:[.,](\d{1,30}))?)?)?/;
	const isoTimeRegex = RegExp(`${isoTimeBaseRegex.source}${isoExtendedZone}`);
	const isoTimeExtensionRegex = RegExp(`(?:[Tt]${isoTimeRegex.source})?`);
	const isoYmdRegex = /([+-]\d{6}|\d{4})(?:-?(\d\d)(?:-?(\d\d))?)?/;
	const isoWeekRegex = /(\d{4})-?W(\d\d)(?:-?(\d))?/;
	const isoOrdinalRegex = /(\d{4})-?(\d{3})/;
	const extractISOWeekData = simpleParse("weekYear", "weekNumber", "weekDay");
	const extractISOOrdinalData = simpleParse("year", "ordinal");
	const sqlYmdRegex = /(\d{4})-(\d\d)-(\d\d)/;
	const sqlTimeRegex = RegExp(`${isoTimeBaseRegex.source} ?(?:${offsetRegex.source}|(${ianaRegex.source}))?`);
	const sqlTimeExtensionRegex = RegExp(`(?: ${sqlTimeRegex.source})?`);
	function int(match, pos, fallback) {
		const m = match[pos];
		return isUndefined(m) ? fallback : parseInteger(m);
	}
	function extractISOYmd(match, cursor) {
		return [
			{
				year: int(match, cursor),
				month: int(match, cursor + 1, 1),
				day: int(match, cursor + 2, 1)
			},
			null,
			cursor + 3
		];
	}
	function extractISOTime(match, cursor) {
		return [
			{
				hours: int(match, cursor, 0),
				minutes: int(match, cursor + 1, 0),
				seconds: int(match, cursor + 2, 0),
				milliseconds: parseMillis(match[cursor + 3])
			},
			null,
			cursor + 4
		];
	}
	function extractISOOffset(match, cursor) {
		const local = !match[cursor] && !match[cursor + 1], fullOffset = signedOffset(match[cursor + 1], match[cursor + 2]);
		return [
			{},
			local ? null : FixedOffsetZone.instance(fullOffset),
			cursor + 3
		];
	}
	function extractIANAZone(match, cursor) {
		return [
			{},
			match[cursor] ? IANAZone.create(match[cursor]) : null,
			cursor + 1
		];
	}
	const isoTimeOnly = RegExp(`^T?${isoTimeBaseRegex.source}$`);
	const isoDuration = /^-?P(?:(?:(-?\d{1,20}(?:\.\d{1,20})?)Y)?(?:(-?\d{1,20}(?:\.\d{1,20})?)M)?(?:(-?\d{1,20}(?:\.\d{1,20})?)W)?(?:(-?\d{1,20}(?:\.\d{1,20})?)D)?(?:T(?:(-?\d{1,20}(?:\.\d{1,20})?)H)?(?:(-?\d{1,20}(?:\.\d{1,20})?)M)?(?:(-?\d{1,20})(?:[.,](-?\d{1,20}))?S)?)?)$/;
	function extractISODuration(match) {
		const [s, yearStr, monthStr, weekStr, dayStr, hourStr, minuteStr, secondStr, millisecondsStr] = match;
		const hasNegativePrefix = s[0] === "-";
		const negativeSeconds = secondStr && secondStr[0] === "-";
		const maybeNegate = (num, force = false) => num !== void 0 && (force || num && hasNegativePrefix) ? -num : num;
		return [{
			years: maybeNegate(parseFloating(yearStr)),
			months: maybeNegate(parseFloating(monthStr)),
			weeks: maybeNegate(parseFloating(weekStr)),
			days: maybeNegate(parseFloating(dayStr)),
			hours: maybeNegate(parseFloating(hourStr)),
			minutes: maybeNegate(parseFloating(minuteStr)),
			seconds: maybeNegate(parseFloating(secondStr), secondStr === "-0"),
			milliseconds: maybeNegate(parseMillis(millisecondsStr), negativeSeconds)
		}];
	}
	const obsOffsets = {
		GMT: 0,
		EDT: -240,
		EST: -300,
		CDT: -300,
		CST: -360,
		MDT: -360,
		MST: -420,
		PDT: -420,
		PST: -480
	};
	function fromStrings(weekdayStr, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr) {
		const result = {
			year: yearStr.length === 2 ? untruncateYear(parseInteger(yearStr)) : parseInteger(yearStr),
			month: monthsShort.indexOf(monthStr) + 1,
			day: parseInteger(dayStr),
			hour: parseInteger(hourStr),
			minute: parseInteger(minuteStr)
		};
		if (secondStr) result.second = parseInteger(secondStr);
		if (weekdayStr) result.weekday = weekdayStr.length > 3 ? weekdaysLong.indexOf(weekdayStr) + 1 : weekdaysShort.indexOf(weekdayStr) + 1;
		return result;
	}
	const rfc2822 = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s)?(\d{1,2})\s(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s(\d{2,4})\s(\d\d):(\d\d)(?::(\d\d))?\s(?:(UT|GMT|[ECMP][SD]T)|([Zz])|(?:([+-]\d\d)(\d\d)))$/;
	function extractRFC2822(match) {
		const [, weekdayStr, dayStr, monthStr, yearStr, hourStr, minuteStr, secondStr, obsOffset, milOffset, offHourStr, offMinuteStr] = match, result = fromStrings(weekdayStr, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr);
		let offset;
		if (obsOffset) offset = obsOffsets[obsOffset];
		else if (milOffset) offset = 0;
		else offset = signedOffset(offHourStr, offMinuteStr);
		return [result, new FixedOffsetZone(offset)];
	}
	function preprocessRFC2822(s) {
		return s.replace(/\([^()]*\)|[\n\t]/g, " ").replace(/(\s\s+)/g, " ").trim();
	}
	const rfc1123 = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d\d) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d\d):(\d\d):(\d\d) GMT$/, rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d\d)-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d\d) (\d\d):(\d\d):(\d\d) GMT$/, ascii = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d\d) (\d\d):(\d\d):(\d\d) (\d{4})$/;
	function extractRFC1123Or850(match) {
		const [, weekdayStr, dayStr, monthStr, yearStr, hourStr, minuteStr, secondStr] = match;
		return [fromStrings(weekdayStr, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr), FixedOffsetZone.utcInstance];
	}
	function extractASCII(match) {
		const [, weekdayStr, monthStr, dayStr, hourStr, minuteStr, secondStr, yearStr] = match;
		return [fromStrings(weekdayStr, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr), FixedOffsetZone.utcInstance];
	}
	const isoYmdWithTimeExtensionRegex = combineRegexes(isoYmdRegex, isoTimeExtensionRegex);
	const isoWeekWithTimeExtensionRegex = combineRegexes(isoWeekRegex, isoTimeExtensionRegex);
	const isoOrdinalWithTimeExtensionRegex = combineRegexes(isoOrdinalRegex, isoTimeExtensionRegex);
	const isoTimeCombinedRegex = combineRegexes(isoTimeRegex);
	const extractISOYmdTimeAndOffset = combineExtractors(extractISOYmd, extractISOTime, extractISOOffset, extractIANAZone);
	const extractISOWeekTimeAndOffset = combineExtractors(extractISOWeekData, extractISOTime, extractISOOffset, extractIANAZone);
	const extractISOOrdinalDateAndTime = combineExtractors(extractISOOrdinalData, extractISOTime, extractISOOffset, extractIANAZone);
	const extractISOTimeAndOffset = combineExtractors(extractISOTime, extractISOOffset, extractIANAZone);
	function parseISODate(s) {
		return parse(s, [isoYmdWithTimeExtensionRegex, extractISOYmdTimeAndOffset], [isoWeekWithTimeExtensionRegex, extractISOWeekTimeAndOffset], [isoOrdinalWithTimeExtensionRegex, extractISOOrdinalDateAndTime], [isoTimeCombinedRegex, extractISOTimeAndOffset]);
	}
	function parseRFC2822Date(s) {
		return parse(preprocessRFC2822(s), [rfc2822, extractRFC2822]);
	}
	function parseHTTPDate(s) {
		return parse(s, [rfc1123, extractRFC1123Or850], [rfc850, extractRFC1123Or850], [ascii, extractASCII]);
	}
	function parseISODuration(s) {
		return parse(s, [isoDuration, extractISODuration]);
	}
	const extractISOTimeOnly = combineExtractors(extractISOTime);
	function parseISOTimeOnly(s) {
		return parse(s, [isoTimeOnly, extractISOTimeOnly]);
	}
	const sqlYmdWithTimeExtensionRegex = combineRegexes(sqlYmdRegex, sqlTimeExtensionRegex);
	const sqlTimeCombinedRegex = combineRegexes(sqlTimeRegex);
	const extractISOTimeOffsetAndIANAZone = combineExtractors(extractISOTime, extractISOOffset, extractIANAZone);
	function parseSQL(s) {
		return parse(s, [sqlYmdWithTimeExtensionRegex, extractISOYmdTimeAndOffset], [sqlTimeCombinedRegex, extractISOTimeOffsetAndIANAZone]);
	}
	const INVALID$2 = "Invalid Duration";
	const lowOrderMatrix = {
		weeks: {
			days: 7,
			hours: 168,
			minutes: 10080,
			seconds: 10080 * 60,
			milliseconds: 10080 * 60 * 1e3
		},
		days: {
			hours: 24,
			minutes: 1440,
			seconds: 1440 * 60,
			milliseconds: 1440 * 60 * 1e3
		},
		hours: {
			minutes: 60,
			seconds: 3600,
			milliseconds: 3600 * 1e3
		},
		minutes: {
			seconds: 60,
			milliseconds: 60 * 1e3
		},
		seconds: { milliseconds: 1e3 }
	}, casualMatrix = {
		years: {
			quarters: 4,
			months: 12,
			weeks: 52,
			days: 365,
			hours: 365 * 24,
			minutes: 365 * 24 * 60,
			seconds: 365 * 24 * 60 * 60,
			milliseconds: 365 * 24 * 60 * 60 * 1e3
		},
		quarters: {
			months: 3,
			weeks: 13,
			days: 91,
			hours: 2184,
			minutes: 2184 * 60,
			seconds: 2184 * 60 * 60,
			milliseconds: 2184 * 60 * 60 * 1e3
		},
		months: {
			weeks: 4,
			days: 30,
			hours: 720,
			minutes: 720 * 60,
			seconds: 720 * 60 * 60,
			milliseconds: 720 * 60 * 60 * 1e3
		},
		...lowOrderMatrix
	}, daysInYearAccurate = 146097 / 400, daysInMonthAccurate = 146097 / 4800, accurateMatrix = {
		years: {
			quarters: 4,
			months: 12,
			weeks: daysInYearAccurate / 7,
			days: daysInYearAccurate,
			hours: daysInYearAccurate * 24,
			minutes: daysInYearAccurate * 24 * 60,
			seconds: daysInYearAccurate * 24 * 60 * 60,
			milliseconds: daysInYearAccurate * 24 * 60 * 60 * 1e3
		},
		quarters: {
			months: 3,
			weeks: daysInYearAccurate / 28,
			days: daysInYearAccurate / 4,
			hours: daysInYearAccurate * 24 / 4,
			minutes: daysInYearAccurate * 24 * 60 / 4,
			seconds: daysInYearAccurate * 24 * 60 * 60 / 4,
			milliseconds: daysInYearAccurate * 24 * 60 * 60 * 1e3 / 4
		},
		months: {
			weeks: daysInMonthAccurate / 7,
			days: daysInMonthAccurate,
			hours: daysInMonthAccurate * 24,
			minutes: daysInMonthAccurate * 24 * 60,
			seconds: daysInMonthAccurate * 24 * 60 * 60,
			milliseconds: daysInMonthAccurate * 24 * 60 * 60 * 1e3
		},
		...lowOrderMatrix
	};
	const orderedUnits$1 = [
		"years",
		"quarters",
		"months",
		"weeks",
		"days",
		"hours",
		"minutes",
		"seconds",
		"milliseconds"
	];
	const reverseUnits = orderedUnits$1.slice(0).reverse();
	function clone$1(dur, alts, clear = false) {
		return new Duration({
			values: clear ? alts.values : {
				...dur.values,
				...alts.values || {}
			},
			loc: dur.loc.clone(alts.loc),
			conversionAccuracy: alts.conversionAccuracy || dur.conversionAccuracy,
			matrix: alts.matrix || dur.matrix
		});
	}
	function durationToMillis(matrix, vals) {
		var _vals$milliseconds;
		let sum = (_vals$milliseconds = vals.milliseconds) != null ? _vals$milliseconds : 0;
		for (const unit of reverseUnits.slice(1)) if (vals[unit]) sum += vals[unit] * matrix[unit]["milliseconds"];
		return sum;
	}
	function normalizeValues(matrix, vals) {
		const factor = durationToMillis(matrix, vals) < 0 ? -1 : 1;
		orderedUnits$1.reduceRight((previous, current) => {
			if (!isUndefined(vals[current])) {
				if (previous) {
					const previousVal = vals[previous] * factor;
					const conv = matrix[current][previous];
					const rollUp = Math.floor(previousVal / conv);
					vals[current] += rollUp * factor;
					vals[previous] -= rollUp * conv * factor;
				}
				return current;
			} else return previous;
		}, null);
		orderedUnits$1.reduce((previous, current) => {
			if (!isUndefined(vals[current])) {
				if (previous) {
					const fraction = vals[previous] % 1;
					vals[previous] -= fraction;
					vals[current] += fraction * matrix[previous][current];
				}
				return current;
			} else return previous;
		}, null);
	}
	function removeZeroes(vals) {
		const newVals = {};
		for (const [key, value] of Object.entries(vals)) if (value !== 0) newVals[key] = value;
		return newVals;
	}
	/**
	* A Duration object represents a period of time, like "2 months" or "1 day, 1 hour". Conceptually, it's just a map of units to their quantities, accompanied by some additional configuration and methods for creating, parsing, interrogating, transforming, and formatting them. They can be used on their own or in conjunction with other Luxon types; for example, you can use {@link DateTime#plus} to add a Duration object to a DateTime, producing another DateTime.
	*
	* Here is a brief overview of commonly used methods and getters in Duration:
	*
	* * **Creation** To create a Duration, use {@link Duration.fromMillis}, {@link Duration.fromObject}, or {@link Duration.fromISO}.
	* * **Unit values** See the {@link Duration#years}, {@link Duration#months}, {@link Duration#weeks}, {@link Duration#days}, {@link Duration#hours}, {@link Duration#minutes}, {@link Duration#seconds}, {@link Duration#milliseconds} accessors.
	* * **Configuration** See  {@link Duration#locale} and {@link Duration#numberingSystem} accessors.
	* * **Transformation** To create new Durations out of old ones use {@link Duration#plus}, {@link Duration#minus}, {@link Duration#normalize}, {@link Duration#set}, {@link Duration#reconfigure}, {@link Duration#shiftTo}, and {@link Duration#negate}.
	* * **Output** To convert the Duration into other representations, see {@link Duration#as}, {@link Duration#toISO}, {@link Duration#toFormat}, and {@link Duration#toJSON}
	*
	* There's are more methods documented below. In addition, for more information on subtler topics like internationalization and validity, see the external documentation.
	*/
	var Duration = class Duration {
		/**
		* @private
		*/
		constructor(config) {
			const accurate = config.conversionAccuracy === "longterm" || false;
			let matrix = accurate ? accurateMatrix : casualMatrix;
			if (config.matrix) matrix = config.matrix;
			/**
			* @access private
			*/
			this.values = config.values;
			/**
			* @access private
			*/
			this.loc = config.loc || Locale.create();
			/**
			* @access private
			*/
			this.conversionAccuracy = accurate ? "longterm" : "casual";
			/**
			* @access private
			*/
			this.invalid = config.invalid || null;
			/**
			* @access private
			*/
			this.matrix = matrix;
			/**
			* @access private
			*/
			this.isLuxonDuration = true;
		}
		/**
		* Create Duration from a number of milliseconds.
		* @param {number} count of milliseconds
		* @param {Object} opts - options for parsing
		* @param {string} [opts.locale='en-US'] - the locale to use
		* @param {string} opts.numberingSystem - the numbering system to use
		* @param {string} [opts.conversionAccuracy='casual'] - the conversion system to use
		* @return {Duration}
		*/
		static fromMillis(count, opts) {
			return Duration.fromObject({ milliseconds: count }, opts);
		}
		/**
		* Create a Duration from a JavaScript object with keys like 'years' and 'hours'.
		* If this object is empty then a zero milliseconds duration is returned.
		* @param {Object} obj - the object to create the DateTime from
		* @param {number} obj.years
		* @param {number} obj.quarters
		* @param {number} obj.months
		* @param {number} obj.weeks
		* @param {number} obj.days
		* @param {number} obj.hours
		* @param {number} obj.minutes
		* @param {number} obj.seconds
		* @param {number} obj.milliseconds
		* @param {Object} [opts=[]] - options for creating this Duration
		* @param {string} [opts.locale='en-US'] - the locale to use
		* @param {string} opts.numberingSystem - the numbering system to use
		* @param {string} [opts.conversionAccuracy='casual'] - the preset conversion system to use
		* @param {string} [opts.matrix=Object] - the custom conversion system to use
		* @return {Duration}
		*/
		static fromObject(obj, opts = {}) {
			if (obj == null || typeof obj !== "object") throw new InvalidArgumentError(`Duration.fromObject: argument expected to be an object, got ${obj === null ? "null" : typeof obj}`);
			return new Duration({
				values: normalizeObject(obj, Duration.normalizeUnit),
				loc: Locale.fromObject(opts),
				conversionAccuracy: opts.conversionAccuracy,
				matrix: opts.matrix
			});
		}
		/**
		* Create a Duration from DurationLike.
		*
		* @param {Object | number | Duration} durationLike
		* One of:
		* - object with keys like 'years' and 'hours'.
		* - number representing milliseconds
		* - Duration instance
		* @return {Duration}
		*/
		static fromDurationLike(durationLike) {
			if (isNumber(durationLike)) return Duration.fromMillis(durationLike);
			else if (Duration.isDuration(durationLike)) return durationLike;
			else if (typeof durationLike === "object") return Duration.fromObject(durationLike);
			else throw new InvalidArgumentError(`Unknown duration argument ${durationLike} of type ${typeof durationLike}`);
		}
		/**
		* Create a Duration from an ISO 8601 duration string.
		* @param {string} text - text to parse
		* @param {Object} opts - options for parsing
		* @param {string} [opts.locale='en-US'] - the locale to use
		* @param {string} opts.numberingSystem - the numbering system to use
		* @param {string} [opts.conversionAccuracy='casual'] - the preset conversion system to use
		* @param {string} [opts.matrix=Object] - the preset conversion system to use
		* @see https://en.wikipedia.org/wiki/ISO_8601#Durations
		* @example Duration.fromISO('P3Y6M1W4DT12H30M5S').toObject() //=> { years: 3, months: 6, weeks: 1, days: 4, hours: 12, minutes: 30, seconds: 5 }
		* @example Duration.fromISO('PT23H').toObject() //=> { hours: 23 }
		* @example Duration.fromISO('P5Y3M').toObject() //=> { years: 5, months: 3 }
		* @return {Duration}
		*/
		static fromISO(text, opts) {
			const [parsed] = parseISODuration(text);
			if (parsed) return Duration.fromObject(parsed, opts);
			else return Duration.invalid("unparsable", `the input "${text}" can't be parsed as ISO 8601`);
		}
		/**
		* Create a Duration from an ISO 8601 time string.
		* @param {string} text - text to parse
		* @param {Object} opts - options for parsing
		* @param {string} [opts.locale='en-US'] - the locale to use
		* @param {string} opts.numberingSystem - the numbering system to use
		* @param {string} [opts.conversionAccuracy='casual'] - the preset conversion system to use
		* @param {string} [opts.matrix=Object] - the conversion system to use
		* @see https://en.wikipedia.org/wiki/ISO_8601#Times
		* @example Duration.fromISOTime('11:22:33.444').toObject() //=> { hours: 11, minutes: 22, seconds: 33, milliseconds: 444 }
		* @example Duration.fromISOTime('11:00').toObject() //=> { hours: 11, minutes: 0, seconds: 0 }
		* @example Duration.fromISOTime('T11:00').toObject() //=> { hours: 11, minutes: 0, seconds: 0 }
		* @example Duration.fromISOTime('1100').toObject() //=> { hours: 11, minutes: 0, seconds: 0 }
		* @example Duration.fromISOTime('T1100').toObject() //=> { hours: 11, minutes: 0, seconds: 0 }
		* @return {Duration}
		*/
		static fromISOTime(text, opts) {
			const [parsed] = parseISOTimeOnly(text);
			if (parsed) return Duration.fromObject(parsed, opts);
			else return Duration.invalid("unparsable", `the input "${text}" can't be parsed as ISO 8601`);
		}
		/**
		* Create an invalid Duration.
		* @param {string} reason - simple string of why this datetime is invalid. Should not contain parameters or anything else data-dependent
		* @param {string} [explanation=null] - longer explanation, may include parameters and other useful debugging information
		* @return {Duration}
		*/
		static invalid(reason, explanation = null) {
			if (!reason) throw new InvalidArgumentError("need to specify a reason the Duration is invalid");
			const invalid = reason instanceof Invalid ? reason : new Invalid(reason, explanation);
			if (Settings.throwOnInvalid) throw new InvalidDurationError(invalid);
			else return new Duration({ invalid });
		}
		/**
		* @private
		*/
		static normalizeUnit(unit) {
			const normalized = {
				year: "years",
				years: "years",
				quarter: "quarters",
				quarters: "quarters",
				month: "months",
				months: "months",
				week: "weeks",
				weeks: "weeks",
				day: "days",
				days: "days",
				hour: "hours",
				hours: "hours",
				minute: "minutes",
				minutes: "minutes",
				second: "seconds",
				seconds: "seconds",
				millisecond: "milliseconds",
				milliseconds: "milliseconds"
			}[unit ? unit.toLowerCase() : unit];
			if (!normalized) throw new InvalidUnitError(unit);
			return normalized;
		}
		/**
		* Check if an object is a Duration. Works across context boundaries
		* @param {object} o
		* @return {boolean}
		*/
		static isDuration(o) {
			return o && o.isLuxonDuration || false;
		}
		/**
		* Get  the locale of a Duration, such 'en-GB'
		* @type {string}
		*/
		get locale() {
			return this.isValid ? this.loc.locale : null;
		}
		/**
		* Get the numbering system of a Duration, such 'beng'. The numbering system is used when formatting the Duration
		*
		* @type {string}
		*/
		get numberingSystem() {
			return this.isValid ? this.loc.numberingSystem : null;
		}
		/**
		* Returns a string representation of this Duration formatted according to the specified format string. You may use these tokens:
		* * `S` for milliseconds
		* * `s` for seconds
		* * `m` for minutes
		* * `h` for hours
		* * `d` for days
		* * `w` for weeks
		* * `M` for months
		* * `y` for years
		* Notes:
		* * Add padding by repeating the token, e.g. "yy" pads the years to two digits, "hhhh" pads the hours out to four digits
		* * Tokens can be escaped by wrapping with single quotes.
		* * The duration will be converted to the set of units in the format string using {@link Duration#shiftTo} and the Durations's conversion accuracy setting.
		* @param {string} fmt - the format string
		* @param {Object} opts - options
		* @param {boolean} [opts.floor=true] - floor numerical values
		* @param {'negative'|'all'|'negativeLargestOnly'} [opts.signMode=negative] - How to handle signs
		* @example Duration.fromObject({ years: 1, days: 6, seconds: 2 }).toFormat("y d s") //=> "1 6 2"
		* @example Duration.fromObject({ years: 1, days: 6, seconds: 2 }).toFormat("yy dd sss") //=> "01 06 002"
		* @example Duration.fromObject({ years: 1, days: 6, seconds: 2 }).toFormat("M S") //=> "12 518402000"
		* @example Duration.fromObject({ days: 6, seconds: 2 }).toFormat("d s", { signMode: "all" }) //=> "+6 +2"
		* @example Duration.fromObject({ days: -6, seconds: -2 }).toFormat("d s", { signMode: "all" }) //=> "-6 -2"
		* @example Duration.fromObject({ days: -6, seconds: -2 }).toFormat("d s", { signMode: "negativeLargestOnly" }) //=> "-6 2"
		* @return {string}
		*/
		toFormat(fmt, opts = {}) {
			const fmtOpts = {
				...opts,
				floor: opts.round !== false && opts.floor !== false
			};
			return this.isValid ? Formatter.create(this.loc, fmtOpts).formatDurationFromString(this, fmt) : INVALID$2;
		}
		/**
		* Returns a string representation of a Duration with all units included.
		* To modify its behavior, use `listStyle` and any Intl.NumberFormat option, though `unitDisplay` is especially relevant.
		* @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat/NumberFormat#options
		* @param {Object} opts - Formatting options. Accepts the same keys as the options parameter of the native `Intl.NumberFormat` constructor, as well as `listStyle`.
		* @param {string} [opts.listStyle='narrow'] - How to format the merged list. Corresponds to the `style` property of the options parameter of the native `Intl.ListFormat` constructor.
		* @param {boolean} [opts.showZeros=true] - Show all units previously used by the duration even if they are zero
		* @example
		* ```js
		* var dur = Duration.fromObject({ months: 1, weeks: 0, hours: 5, minutes: 6 })
		* dur.toHuman() //=> '1 month, 0 weeks, 5 hours, 6 minutes'
		* dur.toHuman({ listStyle: "long" }) //=> '1 month, 0 weeks, 5 hours, and 6 minutes'
		* dur.toHuman({ unitDisplay: "short" }) //=> '1 mth, 0 wks, 5 hr, 6 min'
		* dur.toHuman({ showZeros: false }) //=> '1 month, 5 hours, 6 minutes'
		* ```
		*/
		toHuman(opts = {}) {
			if (!this.isValid) return INVALID$2;
			const showZeros = opts.showZeros !== false;
			const l = orderedUnits$1.map((unit) => {
				const val = this.values[unit];
				if (isUndefined(val) || val === 0 && !showZeros) return null;
				return this.loc.numberFormatter({
					style: "unit",
					unitDisplay: "long",
					...opts,
					unit: unit.slice(0, -1)
				}).format(val);
			}).filter((n) => n);
			return this.loc.listFormatter({
				type: "conjunction",
				style: opts.listStyle || "narrow",
				...opts
			}).format(l);
		}
		/**
		* Returns a JavaScript object with this Duration's values.
		* @example Duration.fromObject({ years: 1, days: 6, seconds: 2 }).toObject() //=> { years: 1, days: 6, seconds: 2 }
		* @return {Object}
		*/
		toObject() {
			if (!this.isValid) return {};
			return { ...this.values };
		}
		/**
		* Returns an ISO 8601-compliant string representation of this Duration.
		* @see https://en.wikipedia.org/wiki/ISO_8601#Durations
		* @example Duration.fromObject({ years: 3, seconds: 45 }).toISO() //=> 'P3YT45S'
		* @example Duration.fromObject({ months: 4, seconds: 45 }).toISO() //=> 'P4MT45S'
		* @example Duration.fromObject({ months: 5 }).toISO() //=> 'P5M'
		* @example Duration.fromObject({ minutes: 5 }).toISO() //=> 'PT5M'
		* @example Duration.fromObject({ milliseconds: 6 }).toISO() //=> 'PT0.006S'
		* @return {string}
		*/
		toISO() {
			if (!this.isValid) return null;
			let s = "P";
			if (this.years !== 0) s += this.years + "Y";
			if (this.months !== 0 || this.quarters !== 0) s += this.months + this.quarters * 3 + "M";
			if (this.weeks !== 0) s += this.weeks + "W";
			if (this.days !== 0) s += this.days + "D";
			if (this.hours !== 0 || this.minutes !== 0 || this.seconds !== 0 || this.milliseconds !== 0) s += "T";
			if (this.hours !== 0) s += this.hours + "H";
			if (this.minutes !== 0) s += this.minutes + "M";
			if (this.seconds !== 0 || this.milliseconds !== 0) s += roundTo(this.seconds + this.milliseconds / 1e3, 3) + "S";
			if (s === "P") s += "T0S";
			return s;
		}
		/**
		* Returns an ISO 8601-compliant string representation of this Duration, formatted as a time of day.
		* Note that this will return null if the duration is invalid, negative, or equal to or greater than 24 hours.
		* @see https://en.wikipedia.org/wiki/ISO_8601#Times
		* @param {Object} opts - options
		* @param {boolean} [opts.suppressMilliseconds=false] - exclude milliseconds from the format if they're 0
		* @param {boolean} [opts.suppressSeconds=false] - exclude seconds from the format if they're 0
		* @param {boolean} [opts.includePrefix=false] - include the `T` prefix
		* @param {string} [opts.format='extended'] - choose between the basic and extended format
		* @example Duration.fromObject({ hours: 11 }).toISOTime() //=> '11:00:00.000'
		* @example Duration.fromObject({ hours: 11 }).toISOTime({ suppressMilliseconds: true }) //=> '11:00:00'
		* @example Duration.fromObject({ hours: 11 }).toISOTime({ suppressSeconds: true }) //=> '11:00'
		* @example Duration.fromObject({ hours: 11 }).toISOTime({ includePrefix: true }) //=> 'T11:00:00.000'
		* @example Duration.fromObject({ hours: 11 }).toISOTime({ format: 'basic' }) //=> '110000.000'
		* @return {string}
		*/
		toISOTime(opts = {}) {
			if (!this.isValid) return null;
			const millis = this.toMillis();
			if (millis < 0 || millis >= 864e5) return null;
			opts = {
				suppressMilliseconds: false,
				suppressSeconds: false,
				includePrefix: false,
				format: "extended",
				...opts,
				includeOffset: false
			};
			return DateTime.fromMillis(millis, { zone: "UTC" }).toISOTime(opts);
		}
		/**
		* Returns an ISO 8601 representation of this Duration appropriate for use in JSON.
		* @return {string}
		*/
		toJSON() {
			return this.toISO();
		}
		/**
		* Returns an ISO 8601 representation of this Duration appropriate for use in debugging.
		* @return {string}
		*/
		toString() {
			return this.toISO();
		}
		/**
		* Returns a string representation of this Duration appropriate for the REPL.
		* @return {string}
		*/
		[Symbol.for("nodejs.util.inspect.custom")]() {
			if (this.isValid) return `Duration { values: ${JSON.stringify(this.values)} }`;
			else return `Duration { Invalid, reason: ${this.invalidReason} }`;
		}
		/**
		* Returns an milliseconds value of this Duration.
		* @return {number}
		*/
		toMillis() {
			if (!this.isValid) return NaN;
			return durationToMillis(this.matrix, this.values);
		}
		/**
		* Returns an milliseconds value of this Duration. Alias of {@link toMillis}
		* @return {number}
		*/
		valueOf() {
			return this.toMillis();
		}
		/**
		* Make this Duration longer by the specified amount. Return a newly-constructed Duration.
		* @param {Duration|Object|number} duration - The amount to add. Either a Luxon Duration, a number of milliseconds, the object argument to Duration.fromObject()
		* @return {Duration}
		*/
		plus(duration) {
			if (!this.isValid) return this;
			const dur = Duration.fromDurationLike(duration), result = {};
			for (const k of orderedUnits$1) if (hasOwnProperty(dur.values, k) || hasOwnProperty(this.values, k)) result[k] = dur.get(k) + this.get(k);
			return clone$1(this, { values: result }, true);
		}
		/**
		* Make this Duration shorter by the specified amount. Return a newly-constructed Duration.
		* @param {Duration|Object|number} duration - The amount to subtract. Either a Luxon Duration, a number of milliseconds, the object argument to Duration.fromObject()
		* @return {Duration}
		*/
		minus(duration) {
			if (!this.isValid) return this;
			const dur = Duration.fromDurationLike(duration);
			return this.plus(dur.negate());
		}
		/**
		* Scale this Duration by the specified amount. Return a newly-constructed Duration.
		* @param {function} fn - The function to apply to each unit. Arity is 1 or 2: the value of the unit and, optionally, the unit name. Must return a number.
		* @example Duration.fromObject({ hours: 1, minutes: 30 }).mapUnits(x => x * 2) //=> { hours: 2, minutes: 60 }
		* @example Duration.fromObject({ hours: 1, minutes: 30 }).mapUnits((x, u) => u === "hours" ? x * 2 : x) //=> { hours: 2, minutes: 30 }
		* @return {Duration}
		*/
		mapUnits(fn) {
			if (!this.isValid) return this;
			const result = {};
			for (const k of Object.keys(this.values)) result[k] = asNumber(fn(this.values[k], k));
			return clone$1(this, { values: result }, true);
		}
		/**
		* Get the value of unit.
		* @param {string} unit - a unit such as 'minute' or 'day'
		* @example Duration.fromObject({years: 2, days: 3}).get('years') //=> 2
		* @example Duration.fromObject({years: 2, days: 3}).get('months') //=> 0
		* @example Duration.fromObject({years: 2, days: 3}).get('days') //=> 3
		* @return {number}
		*/
		get(unit) {
			return this[Duration.normalizeUnit(unit)];
		}
		/**
		* "Set" the values of specified units. Return a newly-constructed Duration.
		* @param {Object} values - a mapping of units to numbers
		* @example dur.set({ years: 2017 })
		* @example dur.set({ hours: 8, minutes: 30 })
		* @return {Duration}
		*/
		set(values) {
			if (!this.isValid) return this;
			const mixed = {
				...this.values,
				...normalizeObject(values, Duration.normalizeUnit)
			};
			return clone$1(this, { values: mixed });
		}
		/**
		* "Set" the locale and/or numberingSystem.  Returns a newly-constructed Duration.
		* @example dur.reconfigure({ locale: 'en-GB' })
		* @return {Duration}
		*/
		reconfigure({ locale, numberingSystem, conversionAccuracy, matrix } = {}) {
			const opts = {
				loc: this.loc.clone({
					locale,
					numberingSystem
				}),
				matrix,
				conversionAccuracy
			};
			return clone$1(this, opts);
		}
		/**
		* Return the length of the duration in the specified unit.
		* @param {string} unit - a unit such as 'minutes' or 'days'
		* @example Duration.fromObject({years: 1}).as('days') //=> 365
		* @example Duration.fromObject({years: 1}).as('months') //=> 12
		* @example Duration.fromObject({hours: 60}).as('days') //=> 2.5
		* @return {number}
		*/
		as(unit) {
			return this.isValid ? this.shiftTo(unit).get(unit) : NaN;
		}
		/**
		* Reduce this Duration to its canonical representation in its current units.
		* Assuming the overall value of the Duration is positive, this means:
		* - excessive values for lower-order units are converted to higher-order units (if possible, see first and second example)
		* - negative lower-order units are converted to higher order units (there must be such a higher order unit, otherwise
		*   the overall value would be negative, see third example)
		* - fractional values for higher-order units are converted to lower-order units (if possible, see fourth example)
		*
		* If the overall value is negative, the result of this method is equivalent to `this.negate().normalize().negate()`.
		* @example Duration.fromObject({ years: 2, days: 5000 }).normalize().toObject() //=> { years: 15, days: 255 }
		* @example Duration.fromObject({ days: 5000 }).normalize().toObject() //=> { days: 5000 }
		* @example Duration.fromObject({ hours: 12, minutes: -45 }).normalize().toObject() //=> { hours: 11, minutes: 15 }
		* @example Duration.fromObject({ years: 2.5, days: 0, hours: 0 }).normalize().toObject() //=> { years: 2, days: 182, hours: 12 }
		* @return {Duration}
		*/
		normalize() {
			if (!this.isValid) return this;
			const vals = this.toObject();
			normalizeValues(this.matrix, vals);
			return clone$1(this, { values: vals }, true);
		}
		/**
		* Rescale units to its largest representation
		* @example Duration.fromObject({ milliseconds: 90000 }).rescale().toObject() //=> { minutes: 1, seconds: 30 }
		* @return {Duration}
		*/
		rescale() {
			if (!this.isValid) return this;
			const vals = removeZeroes(this.normalize().shiftToAll().toObject());
			return clone$1(this, { values: vals }, true);
		}
		/**
		* Convert this Duration into its representation in a different set of units.
		* @example Duration.fromObject({ hours: 1, seconds: 30 }).shiftTo('minutes', 'milliseconds').toObject() //=> { minutes: 60, milliseconds: 30000 }
		* @return {Duration}
		*/
		shiftTo(...units) {
			if (!this.isValid) return this;
			if (units.length === 0) return this;
			units = units.map((u) => Duration.normalizeUnit(u));
			const built = {}, accumulated = {}, vals = this.toObject();
			let lastUnit;
			for (const k of orderedUnits$1) if (units.indexOf(k) >= 0) {
				lastUnit = k;
				let own = 0;
				for (const ak in accumulated) {
					own += this.matrix[ak][k] * accumulated[ak];
					accumulated[ak] = 0;
				}
				if (isNumber(vals[k])) own += vals[k];
				const i = Math.trunc(own);
				built[k] = i;
				accumulated[k] = (own * 1e3 - i * 1e3) / 1e3;
			} else if (isNumber(vals[k])) accumulated[k] = vals[k];
			for (const key in accumulated) if (accumulated[key] !== 0) built[lastUnit] += key === lastUnit ? accumulated[key] : accumulated[key] / this.matrix[lastUnit][key];
			normalizeValues(this.matrix, built);
			return clone$1(this, { values: built }, true);
		}
		/**
		* Shift this Duration to all available units.
		* Same as shiftTo("years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds")
		* @return {Duration}
		*/
		shiftToAll() {
			if (!this.isValid) return this;
			return this.shiftTo("years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds");
		}
		/**
		* Return the negative of this Duration.
		* @example Duration.fromObject({ hours: 1, seconds: 30 }).negate().toObject() //=> { hours: -1, seconds: -30 }
		* @return {Duration}
		*/
		negate() {
			if (!this.isValid) return this;
			const negated = {};
			for (const k of Object.keys(this.values)) negated[k] = this.values[k] === 0 ? 0 : -this.values[k];
			return clone$1(this, { values: negated }, true);
		}
		/**
		* Removes all units with values equal to 0 from this Duration.
		* @example Duration.fromObject({ years: 2, days: 0, hours: 0, minutes: 0 }).removeZeros().toObject() //=> { years: 2 }
		* @return {Duration}
		*/
		removeZeros() {
			if (!this.isValid) return this;
			const vals = removeZeroes(this.values);
			return clone$1(this, { values: vals }, true);
		}
		/**
		* Get the years.
		* @type {number}
		*/
		get years() {
			return this.isValid ? this.values.years || 0 : NaN;
		}
		/**
		* Get the quarters.
		* @type {number}
		*/
		get quarters() {
			return this.isValid ? this.values.quarters || 0 : NaN;
		}
		/**
		* Get the months.
		* @type {number}
		*/
		get months() {
			return this.isValid ? this.values.months || 0 : NaN;
		}
		/**
		* Get the weeks
		* @type {number}
		*/
		get weeks() {
			return this.isValid ? this.values.weeks || 0 : NaN;
		}
		/**
		* Get the days.
		* @type {number}
		*/
		get days() {
			return this.isValid ? this.values.days || 0 : NaN;
		}
		/**
		* Get the hours.
		* @type {number}
		*/
		get hours() {
			return this.isValid ? this.values.hours || 0 : NaN;
		}
		/**
		* Get the minutes.
		* @type {number}
		*/
		get minutes() {
			return this.isValid ? this.values.minutes || 0 : NaN;
		}
		/**
		* Get the seconds.
		* @return {number}
		*/
		get seconds() {
			return this.isValid ? this.values.seconds || 0 : NaN;
		}
		/**
		* Get the milliseconds.
		* @return {number}
		*/
		get milliseconds() {
			return this.isValid ? this.values.milliseconds || 0 : NaN;
		}
		/**
		* Returns whether the Duration is invalid. Invalid durations are returned by diff operations
		* on invalid DateTimes or Intervals.
		* @return {boolean}
		*/
		get isValid() {
			return this.invalid === null;
		}
		/**
		* Returns an error code if this Duration became invalid, or null if the Duration is valid
		* @return {string}
		*/
		get invalidReason() {
			return this.invalid ? this.invalid.reason : null;
		}
		/**
		* Returns an explanation of why this Duration became invalid, or null if the Duration is valid
		* @type {string}
		*/
		get invalidExplanation() {
			return this.invalid ? this.invalid.explanation : null;
		}
		/**
		* Equality check
		* Two Durations are equal iff they have the same units and the same values for each unit.
		* @param {Duration} other
		* @return {boolean}
		*/
		equals(other) {
			if (!this.isValid || !other.isValid) return false;
			if (!this.loc.equals(other.loc)) return false;
			function eq(v1, v2) {
				if (v1 === void 0 || v1 === 0) return v2 === void 0 || v2 === 0;
				return v1 === v2;
			}
			for (const u of orderedUnits$1) if (!eq(this.values[u], other.values[u])) return false;
			return true;
		}
	};
	const INVALID$1 = "Invalid Interval";
	function validateStartEnd(start, end) {
		if (!start || !start.isValid) return Interval.invalid("missing or invalid start");
		else if (!end || !end.isValid) return Interval.invalid("missing or invalid end");
		else if (end < start) return Interval.invalid("end before start", `The end of an interval must be after its start, but you had start=${start.toISO()} and end=${end.toISO()}`);
		else return null;
	}
	/**
	* An Interval object represents a half-open interval of time, where each endpoint is a {@link DateTime}. Conceptually, it's a container for those two endpoints, accompanied by methods for creating, parsing, interrogating, comparing, transforming, and formatting them.
	*
	* Here is a brief overview of the most commonly used methods and getters in Interval:
	*
	* * **Creation** To create an Interval, use {@link Interval.fromDateTimes}, {@link Interval.after}, {@link Interval.before}, or {@link Interval.fromISO}.
	* * **Accessors** Use {@link Interval#start} and {@link Interval#end} to get the start and end.
	* * **Interrogation** To analyze the Interval, use {@link Interval#count}, {@link Interval#length}, {@link Interval#hasSame}, {@link Interval#contains}, {@link Interval#isAfter}, or {@link Interval#isBefore}.
	* * **Transformation** To create other Intervals out of this one, use {@link Interval#set}, {@link Interval#splitAt}, {@link Interval#splitBy}, {@link Interval#divideEqually}, {@link Interval.merge}, {@link Interval.xor}, {@link Interval#union}, {@link Interval#intersection}, or {@link Interval#difference}.
	* * **Comparison** To compare this Interval to another one, use {@link Interval#equals}, {@link Interval#overlaps}, {@link Interval#abutsStart}, {@link Interval#abutsEnd}, {@link Interval#engulfs}
	* * **Output** To convert the Interval into other representations, see {@link Interval#toString}, {@link Interval#toLocaleString}, {@link Interval#toISO}, {@link Interval#toISODate}, {@link Interval#toISOTime}, {@link Interval#toFormat}, and {@link Interval#toDuration}.
	*/
	var Interval = class Interval {
		/**
		* @private
		*/
		constructor(config) {
			/**
			* @access private
			*/
			this.s = config.start;
			/**
			* @access private
			*/
			this.e = config.end;
			/**
			* @access private
			*/
			this.invalid = config.invalid || null;
			/**
			* @access private
			*/
			this.isLuxonInterval = true;
		}
		/**
		* Create an invalid Interval.
		* @param {string} reason - simple string of why this Interval is invalid. Should not contain parameters or anything else data-dependent
		* @param {string} [explanation=null] - longer explanation, may include parameters and other useful debugging information
		* @return {Interval}
		*/
		static invalid(reason, explanation = null) {
			if (!reason) throw new InvalidArgumentError("need to specify a reason the Interval is invalid");
			const invalid = reason instanceof Invalid ? reason : new Invalid(reason, explanation);
			if (Settings.throwOnInvalid) throw new InvalidIntervalError(invalid);
			else return new Interval({ invalid });
		}
		/**
		* Create an Interval from a start DateTime and an end DateTime. Inclusive of the start but not the end.
		* @param {DateTime|Date|Object} start
		* @param {DateTime|Date|Object} end
		* @return {Interval}
		*/
		static fromDateTimes(start, end) {
			const builtStart = friendlyDateTime(start), builtEnd = friendlyDateTime(end);
			const validateError = validateStartEnd(builtStart, builtEnd);
			if (validateError == null) return new Interval({
				start: builtStart,
				end: builtEnd
			});
			else return validateError;
		}
		/**
		* Create an Interval from a start DateTime and a Duration to extend to.
		* @param {DateTime|Date|Object} start
		* @param {Duration|Object|number} duration - the length of the Interval.
		* @return {Interval}
		*/
		static after(start, duration) {
			const dur = Duration.fromDurationLike(duration), dt = friendlyDateTime(start);
			return Interval.fromDateTimes(dt, dt.plus(dur));
		}
		/**
		* Create an Interval from an end DateTime and a Duration to extend backwards to.
		* @param {DateTime|Date|Object} end
		* @param {Duration|Object|number} duration - the length of the Interval.
		* @return {Interval}
		*/
		static before(end, duration) {
			const dur = Duration.fromDurationLike(duration), dt = friendlyDateTime(end);
			return Interval.fromDateTimes(dt.minus(dur), dt);
		}
		/**
		* Create an Interval from an ISO 8601 string.
		* Accepts `<start>/<end>`, `<start>/<duration>`, and `<duration>/<end>` formats.
		* @param {string} text - the ISO string to parse
		* @param {Object} [opts] - options to pass {@link DateTime#fromISO} and optionally {@link Duration#fromISO}
		* @see https://en.wikipedia.org/wiki/ISO_8601#Time_intervals
		* @return {Interval}
		*/
		static fromISO(text, opts) {
			const [s, e] = (text || "").split("/", 2);
			if (s && e) {
				let start, startIsValid;
				try {
					start = DateTime.fromISO(s, opts);
					startIsValid = start.isValid;
				} catch (e) {
					startIsValid = false;
				}
				let end, endIsValid;
				try {
					end = DateTime.fromISO(e, opts);
					endIsValid = end.isValid;
				} catch (e) {
					endIsValid = false;
				}
				if (startIsValid && endIsValid) return Interval.fromDateTimes(start, end);
				if (startIsValid) {
					const dur = Duration.fromISO(e, opts);
					if (dur.isValid) return Interval.after(start, dur);
				} else if (endIsValid) {
					const dur = Duration.fromISO(s, opts);
					if (dur.isValid) return Interval.before(end, dur);
				}
			}
			return Interval.invalid("unparsable", `the input "${text}" can't be parsed as ISO 8601`);
		}
		/**
		* Check if an object is an Interval. Works across context boundaries
		* @param {object} o
		* @return {boolean}
		*/
		static isInterval(o) {
			return o && o.isLuxonInterval || false;
		}
		/**
		* Returns the start of the Interval
		* @type {DateTime}
		*/
		get start() {
			return this.isValid ? this.s : null;
		}
		/**
		* Returns the end of the Interval. This is the first instant which is not part of the interval
		* (Interval is half-open).
		* @type {DateTime}
		*/
		get end() {
			return this.isValid ? this.e : null;
		}
		/**
		* Returns the last DateTime included in the interval (since end is not part of the interval)
		* @type {DateTime}
		*/
		get lastDateTime() {
			return this.isValid ? this.e ? this.e.minus(1) : null : null;
		}
		/**
		* Returns whether this Interval's end is at least its start, meaning that the Interval isn't 'backwards'.
		* @type {boolean}
		*/
		get isValid() {
			return this.invalidReason === null;
		}
		/**
		* Returns an error code if this Interval is invalid, or null if the Interval is valid
		* @type {string}
		*/
		get invalidReason() {
			return this.invalid ? this.invalid.reason : null;
		}
		/**
		* Returns an explanation of why this Interval became invalid, or null if the Interval is valid
		* @type {string}
		*/
		get invalidExplanation() {
			return this.invalid ? this.invalid.explanation : null;
		}
		/**
		* Returns the length of the Interval in the specified unit.
		* @param {string} unit - the unit (such as 'hours' or 'days') to return the length in.
		* @return {number}
		*/
		length(unit = "milliseconds") {
			return this.isValid ? this.toDuration(...[unit]).get(unit) : NaN;
		}
		/**
		* Returns the count of minutes, hours, days, months, or years included in the Interval, even in part.
		* Unlike {@link Interval#length} this counts sections of the calendar, not periods of time, e.g. specifying 'day'
		* asks 'what dates are included in this interval?', not 'how many days long is this interval?'
		* @param {string} [unit='milliseconds'] - the unit of time to count.
		* @param {Object} opts - options
		* @param {boolean} [opts.useLocaleWeeks=false] - If true, use weeks based on the locale, i.e. use the locale-dependent start of the week; this operation will always use the locale of the start DateTime
		* @return {number}
		*/
		count(unit = "milliseconds", opts) {
			if (!this.isValid) return NaN;
			const start = this.start.startOf(unit, opts);
			let end;
			if (opts != null && opts.useLocaleWeeks) end = this.end.reconfigure({ locale: start.locale });
			else end = this.end;
			end = end.startOf(unit, opts);
			return Math.floor(end.diff(start, unit).get(unit)) + (end.valueOf() !== this.end.valueOf());
		}
		/**
		* Returns whether this Interval's start and end are both in the same unit of time
		* @param {string} unit - the unit of time to check sameness on
		* @return {boolean}
		*/
		hasSame(unit) {
			return this.isValid ? this.isEmpty() || this.e.minus(1).hasSame(this.s, unit) : false;
		}
		/**
		* Return whether this Interval has the same start and end DateTimes.
		* @return {boolean}
		*/
		isEmpty() {
			return this.s.valueOf() === this.e.valueOf();
		}
		/**
		* Return whether this Interval's start is after the specified DateTime.
		* @param {DateTime} dateTime
		* @return {boolean}
		*/
		isAfter(dateTime) {
			if (!this.isValid) return false;
			return this.s > dateTime;
		}
		/**
		* Return whether this Interval's end is before the specified DateTime.
		* @param {DateTime} dateTime
		* @return {boolean}
		*/
		isBefore(dateTime) {
			if (!this.isValid) return false;
			return this.e <= dateTime;
		}
		/**
		* Return whether this Interval contains the specified DateTime.
		* @param {DateTime} dateTime
		* @return {boolean}
		*/
		contains(dateTime) {
			if (!this.isValid) return false;
			return this.s <= dateTime && this.e > dateTime;
		}
		/**
		* "Sets" the start and/or end dates. Returns a newly-constructed Interval.
		* @param {Object} values - the values to set
		* @param {DateTime} values.start - the starting DateTime
		* @param {DateTime} values.end - the ending DateTime
		* @return {Interval}
		*/
		set({ start, end } = {}) {
			if (!this.isValid) return this;
			return Interval.fromDateTimes(start || this.s, end || this.e);
		}
		/**
		* Split this Interval at each of the specified DateTimes
		* @param {...DateTime} dateTimes - the unit of time to count.
		* @return {Array}
		*/
		splitAt(...dateTimes) {
			if (!this.isValid) return [];
			const sorted = dateTimes.map(friendlyDateTime).filter((d) => this.contains(d)).sort((a, b) => a.toMillis() - b.toMillis()), results = [];
			let { s } = this, i = 0;
			while (s < this.e) {
				const added = sorted[i] || this.e, next = +added > +this.e ? this.e : added;
				results.push(Interval.fromDateTimes(s, next));
				s = next;
				i += 1;
			}
			return results;
		}
		/**
		* Split this Interval into smaller Intervals, each of the specified length.
		* Left over time is grouped into a smaller interval
		* @param {Duration|Object|number} duration - The length of each resulting interval.
		* @return {Array}
		*/
		splitBy(duration) {
			const dur = Duration.fromDurationLike(duration);
			if (!this.isValid || !dur.isValid || dur.as("milliseconds") === 0) return [];
			let { s } = this, idx = 1, next;
			const results = [];
			while (s < this.e) {
				const added = this.start.plus(dur.mapUnits((x) => x * idx));
				next = +added > +this.e ? this.e : added;
				results.push(Interval.fromDateTimes(s, next));
				s = next;
				idx += 1;
			}
			return results;
		}
		/**
		* Split this Interval into the specified number of smaller intervals.
		* @param {number} numberOfParts - The number of Intervals to divide the Interval into.
		* @return {Array}
		*/
		divideEqually(numberOfParts) {
			if (!this.isValid) return [];
			return this.splitBy(this.length() / numberOfParts).slice(0, numberOfParts);
		}
		/**
		* Return whether this Interval overlaps with the specified Interval
		* @param {Interval} other
		* @return {boolean}
		*/
		overlaps(other) {
			return this.e > other.s && this.s < other.e;
		}
		/**
		* Return whether this Interval's end is adjacent to the specified Interval's start.
		* @param {Interval} other
		* @return {boolean}
		*/
		abutsStart(other) {
			if (!this.isValid) return false;
			return +this.e === +other.s;
		}
		/**
		* Return whether this Interval's start is adjacent to the specified Interval's end.
		* @param {Interval} other
		* @return {boolean}
		*/
		abutsEnd(other) {
			if (!this.isValid) return false;
			return +other.e === +this.s;
		}
		/**
		* Returns true if this Interval fully contains the specified Interval, specifically if the intersect (of this Interval and the other Interval) is equal to the other Interval; false otherwise.
		* @param {Interval} other
		* @return {boolean}
		*/
		engulfs(other) {
			if (!this.isValid) return false;
			return this.s <= other.s && this.e >= other.e;
		}
		/**
		* Return whether this Interval has the same start and end as the specified Interval.
		* @param {Interval} other
		* @return {boolean}
		*/
		equals(other) {
			if (!this.isValid || !other.isValid) return false;
			return this.s.equals(other.s) && this.e.equals(other.e);
		}
		/**
		* Return an Interval representing the intersection of this Interval and the specified Interval.
		* Specifically, the resulting Interval has the maximum start time and the minimum end time of the two Intervals.
		* Returns null if the intersection is empty, meaning, the intervals don't intersect.
		* @param {Interval} other
		* @return {Interval}
		*/
		intersection(other) {
			if (!this.isValid) return this;
			const s = this.s > other.s ? this.s : other.s, e = this.e < other.e ? this.e : other.e;
			if (s >= e) return null;
			else return Interval.fromDateTimes(s, e);
		}
		/**
		* Return an Interval representing the union of this Interval and the specified Interval.
		* Specifically, the resulting Interval has the minimum start time and the maximum end time of the two Intervals.
		* @param {Interval} other
		* @return {Interval}
		*/
		union(other) {
			if (!this.isValid) return this;
			const s = this.s < other.s ? this.s : other.s, e = this.e > other.e ? this.e : other.e;
			return Interval.fromDateTimes(s, e);
		}
		/**
		* Merge an array of Intervals into an equivalent minimal set of Intervals.
		* Combines overlapping and adjacent Intervals.
		* The resulting array will contain the Intervals in ascending order, that is, starting with the earliest Interval
		* and ending with the latest.
		*
		* @param {Array} intervals
		* @return {Array}
		*/
		static merge(intervals) {
			const [found, final] = intervals.sort((a, b) => a.s - b.s).reduce(([sofar, current], item) => {
				if (!current) return [sofar, item];
				else if (current.overlaps(item) || current.abutsStart(item)) return [sofar, current.union(item)];
				else return [sofar.concat([current]), item];
			}, [[], null]);
			if (final) found.push(final);
			return found;
		}
		/**
		* Return an array of Intervals representing the spans of time that only appear in one of the specified Intervals.
		* @param {Array} intervals
		* @return {Array}
		*/
		static xor(intervals) {
			let start = null, currentCount = 0;
			const results = [], ends = intervals.map((i) => [{
				time: i.s,
				type: "s"
			}, {
				time: i.e,
				type: "e"
			}]), arr = Array.prototype.concat(...ends).sort((a, b) => a.time - b.time);
			for (const i of arr) {
				currentCount += i.type === "s" ? 1 : -1;
				if (currentCount === 1) start = i.time;
				else {
					if (start && +start !== +i.time) results.push(Interval.fromDateTimes(start, i.time));
					start = null;
				}
			}
			return Interval.merge(results);
		}
		/**
		* Return an Interval representing the span of time in this Interval that doesn't overlap with any of the specified Intervals.
		* @param {...Interval} intervals
		* @return {Array}
		*/
		difference(...intervals) {
			return Interval.xor([this].concat(intervals)).map((i) => this.intersection(i)).filter((i) => i && !i.isEmpty());
		}
		/**
		* Returns a string representation of this Interval appropriate for debugging.
		* @return {string}
		*/
		toString() {
			if (!this.isValid) return INVALID$1;
			return `[${this.s.toISO()} – ${this.e.toISO()})`;
		}
		/**
		* Returns a string representation of this Interval appropriate for the REPL.
		* @return {string}
		*/
		[Symbol.for("nodejs.util.inspect.custom")]() {
			if (this.isValid) return `Interval { start: ${this.s.toISO()}, end: ${this.e.toISO()} }`;
			else return `Interval { Invalid, reason: ${this.invalidReason} }`;
		}
		/**
		* Returns a localized string representing this Interval. Accepts the same options as the
		* Intl.DateTimeFormat constructor and any presets defined by Luxon, such as
		* {@link DateTime.DATE_FULL} or {@link DateTime.TIME_SIMPLE}. The exact behavior of this method
		* is browser-specific, but in general it will return an appropriate representation of the
		* Interval in the assigned locale. Defaults to the system's locale if no locale has been
		* specified.
		* @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat
		* @param {Object} [formatOpts=DateTime.DATE_SHORT] - Either a DateTime preset or
		* Intl.DateTimeFormat constructor options.
		* @param {Object} opts - Options to override the configuration of the start DateTime.
		* @example Interval.fromISO('2022-11-07T09:00Z/2022-11-08T09:00Z').toLocaleString(); //=> 11/7/2022 – 11/8/2022
		* @example Interval.fromISO('2022-11-07T09:00Z/2022-11-08T09:00Z').toLocaleString(DateTime.DATE_FULL); //=> November 7 – 8, 2022
		* @example Interval.fromISO('2022-11-07T09:00Z/2022-11-08T09:00Z').toLocaleString(DateTime.DATE_FULL, { locale: 'fr-FR' }); //=> 7–8 novembre 2022
		* @example Interval.fromISO('2022-11-07T17:00Z/2022-11-07T19:00Z').toLocaleString(DateTime.TIME_SIMPLE); //=> 6:00 – 8:00 PM
		* @example Interval.fromISO('2022-11-07T17:00Z/2022-11-07T19:00Z').toLocaleString({ weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); //=> Mon, Nov 07, 6:00 – 8:00 p
		* @return {string}
		*/
		toLocaleString(formatOpts = DATE_SHORT, opts = {}) {
			return this.isValid ? Formatter.create(this.s.loc.clone(opts), formatOpts).formatInterval(this) : INVALID$1;
		}
		/**
		* Returns an ISO 8601-compliant string representation of this Interval.
		* @see https://en.wikipedia.org/wiki/ISO_8601#Time_intervals
		* @param {Object} opts - The same options as {@link DateTime#toISO}
		* @return {string}
		*/
		toISO(opts) {
			if (!this.isValid) return INVALID$1;
			return `${this.s.toISO(opts)}/${this.e.toISO(opts)}`;
		}
		/**
		* Returns an ISO 8601-compliant string representation of date of this Interval.
		* The time components are ignored.
		* @see https://en.wikipedia.org/wiki/ISO_8601#Time_intervals
		* @return {string}
		*/
		toISODate() {
			if (!this.isValid) return INVALID$1;
			return `${this.s.toISODate()}/${this.e.toISODate()}`;
		}
		/**
		* Returns an ISO 8601-compliant string representation of time of this Interval.
		* The date components are ignored.
		* @see https://en.wikipedia.org/wiki/ISO_8601#Time_intervals
		* @param {Object} opts - The same options as {@link DateTime#toISO}
		* @return {string}
		*/
		toISOTime(opts) {
			if (!this.isValid) return INVALID$1;
			return `${this.s.toISOTime(opts)}/${this.e.toISOTime(opts)}`;
		}
		/**
		* Returns a string representation of this Interval formatted according to the specified format
		* string. **You may not want this.** See {@link Interval#toLocaleString} for a more flexible
		* formatting tool.
		* @param {string} dateFormat - The format string. This string formats the start and end time.
		* See {@link DateTime#toFormat} for details.
		* @param {Object} opts - Options.
		* @param {string} [opts.separator =  ' – '] - A separator to place between the start and end
		* representations.
		* @return {string}
		*/
		toFormat(dateFormat, { separator = " – " } = {}) {
			if (!this.isValid) return INVALID$1;
			return `${this.s.toFormat(dateFormat)}${separator}${this.e.toFormat(dateFormat)}`;
		}
		/**
		* Return a Duration representing the time spanned by this interval.
		* @param {string|string[]} [unit=['milliseconds']] - the unit or units (such as 'hours' or 'days') to include in the duration.
		* @param {Object} opts - options that affect the creation of the Duration
		* @param {string} [opts.conversionAccuracy='casual'] - the conversion system to use
		* @example Interval.fromDateTimes(dt1, dt2).toDuration().toObject() //=> { milliseconds: 88489257 }
		* @example Interval.fromDateTimes(dt1, dt2).toDuration('days').toObject() //=> { days: 1.0241812152777778 }
		* @example Interval.fromDateTimes(dt1, dt2).toDuration(['hours', 'minutes']).toObject() //=> { hours: 24, minutes: 34.82095 }
		* @example Interval.fromDateTimes(dt1, dt2).toDuration(['hours', 'minutes', 'seconds']).toObject() //=> { hours: 24, minutes: 34, seconds: 49.257 }
		* @example Interval.fromDateTimes(dt1, dt2).toDuration('seconds').toObject() //=> { seconds: 88489.257 }
		* @return {Duration}
		*/
		toDuration(unit, opts) {
			if (!this.isValid) return Duration.invalid(this.invalidReason);
			return this.e.diff(this.s, unit, opts);
		}
		/**
		* Run mapFn on the interval start and end, returning a new Interval from the resulting DateTimes
		* @param {function} mapFn
		* @return {Interval}
		* @example Interval.fromDateTimes(dt1, dt2).mapEndpoints(endpoint => endpoint.toUTC())
		* @example Interval.fromDateTimes(dt1, dt2).mapEndpoints(endpoint => endpoint.plus({ hours: 2 }))
		*/
		mapEndpoints(mapFn) {
			return Interval.fromDateTimes(mapFn(this.s), mapFn(this.e));
		}
	};
	/**
	* The Info class contains static methods for retrieving general time and date related data. For example, it has methods for finding out if a time zone has a DST, for listing the months in any supported locale, and for discovering which of Luxon features are available in the current environment.
	*/
	var Info = class {
		/**
		* Return whether the specified zone contains a DST.
		* @param {string|Zone} [zone='local'] - Zone to check. Defaults to the environment's local zone.
		* @return {boolean}
		*/
		static hasDST(zone = Settings.defaultZone) {
			const proto = DateTime.now().setZone(zone).set({ month: 12 });
			return !zone.isUniversal && proto.offset !== proto.set({ month: 6 }).offset;
		}
		/**
		* Return whether the specified zone is a valid IANA specifier.
		* @param {string} zone - Zone to check
		* @return {boolean}
		*/
		static isValidIANAZone(zone) {
			return IANAZone.isValidZone(zone);
		}
		/**
		* Converts the input into a {@link Zone} instance.
		*
		* * If `input` is already a Zone instance, it is returned unchanged.
		* * If `input` is a string containing a valid time zone name, a Zone instance
		*   with that name is returned.
		* * If `input` is a string that doesn't refer to a known time zone, a Zone
		*   instance with {@link Zone#isValid} == false is returned.
		* * If `input is a number, a Zone instance with the specified fixed offset
		*   in minutes is returned.
		* * If `input` is `null` or `undefined`, the default zone is returned.
		* @param {string|Zone|number} [input] - the value to be converted
		* @return {Zone}
		*/
		static normalizeZone(input) {
			return normalizeZone(input, Settings.defaultZone);
		}
		/**
		* Get the weekday on which the week starts according to the given locale.
		* @param {Object} opts - options
		* @param {string} [opts.locale] - the locale code
		* @param {string} [opts.locObj=null] - an existing locale object to use
		* @returns {number} the start of the week, 1 for Monday through 7 for Sunday
		*/
		static getStartOfWeek({ locale = null, locObj = null } = {}) {
			return (locObj || Locale.create(locale)).getStartOfWeek();
		}
		/**
		* Get the minimum number of days necessary in a week before it is considered part of the next year according
		* to the given locale.
		* @param {Object} opts - options
		* @param {string} [opts.locale] - the locale code
		* @param {string} [opts.locObj=null] - an existing locale object to use
		* @returns {number}
		*/
		static getMinimumDaysInFirstWeek({ locale = null, locObj = null } = {}) {
			return (locObj || Locale.create(locale)).getMinDaysInFirstWeek();
		}
		/**
		* Get the weekdays, which are considered the weekend according to the given locale
		* @param {Object} opts - options
		* @param {string} [opts.locale] - the locale code
		* @param {string} [opts.locObj=null] - an existing locale object to use
		* @returns {number[]} an array of weekdays, 1 for Monday through 7 for Sunday
		*/
		static getWeekendWeekdays({ locale = null, locObj = null } = {}) {
			return (locObj || Locale.create(locale)).getWeekendDays().slice();
		}
		/**
		* Return an array of standalone month names.
		* @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat
		* @param {string} [length='long'] - the length of the month representation, such as "numeric", "2-digit", "narrow", "short", "long"
		* @param {Object} opts - options
		* @param {string} [opts.locale] - the locale code
		* @param {string} [opts.numberingSystem=null] - the numbering system
		* @param {string} [opts.locObj=null] - an existing locale object to use
		* @param {string} [opts.outputCalendar='gregory'] - the calendar
		* @example Info.months()[0] //=> 'January'
		* @example Info.months('short')[0] //=> 'Jan'
		* @example Info.months('numeric')[0] //=> '1'
		* @example Info.months('short', { locale: 'fr-CA' } )[0] //=> 'janv.'
		* @example Info.months('numeric', { locale: 'ar' })[0] //=> '١'
		* @example Info.months('long', { outputCalendar: 'islamic' })[0] //=> 'Rabiʻ I'
		* @return {Array}
		*/
		static months(length = "long", { locale = null, numberingSystem = null, locObj = null, outputCalendar = "gregory" } = {}) {
			return (locObj || Locale.create(locale, numberingSystem, outputCalendar)).months(length);
		}
		/**
		* Return an array of format month names.
		* Format months differ from standalone months in that they're meant to appear next to the day of the month. In some languages, that
		* changes the string.
		* See {@link Info#months}
		* @param {string} [length='long'] - the length of the month representation, such as "numeric", "2-digit", "narrow", "short", "long"
		* @param {Object} opts - options
		* @param {string} [opts.locale] - the locale code
		* @param {string} [opts.numberingSystem=null] - the numbering system
		* @param {string} [opts.locObj=null] - an existing locale object to use
		* @param {string} [opts.outputCalendar='gregory'] - the calendar
		* @return {Array}
		*/
		static monthsFormat(length = "long", { locale = null, numberingSystem = null, locObj = null, outputCalendar = "gregory" } = {}) {
			return (locObj || Locale.create(locale, numberingSystem, outputCalendar)).months(length, true);
		}
		/**
		* Return an array of standalone week names.
		* @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat
		* @param {string} [length='long'] - the length of the weekday representation, such as "narrow", "short", "long".
		* @param {Object} opts - options
		* @param {string} [opts.locale] - the locale code
		* @param {string} [opts.numberingSystem=null] - the numbering system
		* @param {string} [opts.locObj=null] - an existing locale object to use
		* @example Info.weekdays()[0] //=> 'Monday'
		* @example Info.weekdays('short')[0] //=> 'Mon'
		* @example Info.weekdays('short', { locale: 'fr-CA' })[0] //=> 'lun.'
		* @example Info.weekdays('short', { locale: 'ar' })[0] //=> 'الاثنين'
		* @return {Array}
		*/
		static weekdays(length = "long", { locale = null, numberingSystem = null, locObj = null } = {}) {
			return (locObj || Locale.create(locale, numberingSystem, null)).weekdays(length);
		}
		/**
		* Return an array of format week names.
		* Format weekdays differ from standalone weekdays in that they're meant to appear next to more date information. In some languages, that
		* changes the string.
		* See {@link Info#weekdays}
		* @param {string} [length='long'] - the length of the month representation, such as "narrow", "short", "long".
		* @param {Object} opts - options
		* @param {string} [opts.locale=null] - the locale code
		* @param {string} [opts.numberingSystem=null] - the numbering system
		* @param {string} [opts.locObj=null] - an existing locale object to use
		* @return {Array}
		*/
		static weekdaysFormat(length = "long", { locale = null, numberingSystem = null, locObj = null } = {}) {
			return (locObj || Locale.create(locale, numberingSystem, null)).weekdays(length, true);
		}
		/**
		* Return an array of meridiems.
		* @param {Object} opts - options
		* @param {string} [opts.locale] - the locale code
		* @example Info.meridiems() //=> [ 'AM', 'PM' ]
		* @example Info.meridiems({ locale: 'my' }) //=> [ 'နံနက်', 'ညနေ' ]
		* @return {Array}
		*/
		static meridiems({ locale = null } = {}) {
			return Locale.create(locale).meridiems();
		}
		/**
		* Return an array of eras, such as ['BC', 'AD']. The locale can be specified, but the calendar system is always Gregorian.
		* @param {string} [length='short'] - the length of the era representation, such as "short" or "long".
		* @param {Object} opts - options
		* @param {string} [opts.locale] - the locale code
		* @example Info.eras() //=> [ 'BC', 'AD' ]
		* @example Info.eras('long') //=> [ 'Before Christ', 'Anno Domini' ]
		* @example Info.eras('long', { locale: 'fr' }) //=> [ 'avant Jésus-Christ', 'après Jésus-Christ' ]
		* @return {Array}
		*/
		static eras(length = "short", { locale = null } = {}) {
			return Locale.create(locale, null, "gregory").eras(length);
		}
		/**
		* Return the set of available features in this environment.
		* Some features of Luxon are not available in all environments. For example, on older browsers, relative time formatting support is not available. Use this function to figure out if that's the case.
		* Keys:
		* * `relative`: whether this environment supports relative time formatting
		* * `localeWeek`: whether this environment supports different weekdays for the start of the week based on the locale
		* @example Info.features() //=> { relative: false, localeWeek: true }
		* @return {Object}
		*/
		static features() {
			return {
				relative: hasRelative(),
				localeWeek: hasLocaleWeekInfo()
			};
		}
	};
	function dayDiff(earlier, later) {
		const utcDayStart = (dt) => dt.toUTC(0, { keepLocalTime: true }).startOf("day").valueOf(), ms = utcDayStart(later) - utcDayStart(earlier);
		return Math.floor(Duration.fromMillis(ms).as("days"));
	}
	function highOrderDiffs(cursor, later, units) {
		const differs = [
			["years", (a, b) => b.year - a.year],
			["quarters", (a, b) => b.quarter - a.quarter + (b.year - a.year) * 4],
			["months", (a, b) => b.month - a.month + (b.year - a.year) * 12],
			["weeks", (a, b) => {
				const days = dayDiff(a, b);
				return (days - days % 7) / 7;
			}],
			["days", dayDiff]
		];
		const results = {};
		const earlier = cursor;
		let lowestOrder, highWater;
		for (const [unit, differ] of differs) if (units.indexOf(unit) >= 0) {
			lowestOrder = unit;
			results[unit] = differ(cursor, later);
			highWater = earlier.plus(results);
			if (highWater > later) {
				results[unit]--;
				cursor = earlier.plus(results);
				if (cursor > later) {
					highWater = cursor;
					results[unit]--;
					cursor = earlier.plus(results);
				}
			} else cursor = highWater;
		}
		return [
			cursor,
			results,
			highWater,
			lowestOrder
		];
	}
	function diff(earlier, later, units, opts) {
		let [cursor, results, highWater, lowestOrder] = highOrderDiffs(earlier, later, units);
		const remainingMillis = later - cursor;
		const lowerOrderUnits = units.filter((u) => [
			"hours",
			"minutes",
			"seconds",
			"milliseconds"
		].indexOf(u) >= 0);
		if (lowerOrderUnits.length === 0) {
			if (highWater < later) highWater = cursor.plus({ [lowestOrder]: 1 });
			if (highWater !== cursor) results[lowestOrder] = (results[lowestOrder] || 0) + remainingMillis / (highWater - cursor);
		}
		const duration = Duration.fromObject(results, opts);
		if (lowerOrderUnits.length > 0) return Duration.fromMillis(remainingMillis, opts).shiftTo(...lowerOrderUnits).plus(duration);
		else return duration;
	}
	const MISSING_FTP = "missing Intl.DateTimeFormat.formatToParts support";
	function intUnit(regex, post = (i) => i) {
		return {
			regex,
			deser: ([s]) => post(parseDigits(s))
		};
	}
	const spaceOrNBSP = `[ ${String.fromCharCode(160)}]`;
	const spaceOrNBSPRegExp = new RegExp(spaceOrNBSP, "g");
	function fixListRegex(s) {
		return s.replace(/\./g, "\\.?").replace(spaceOrNBSPRegExp, spaceOrNBSP);
	}
	function stripInsensitivities(s) {
		return s.replace(/\./g, "").replace(spaceOrNBSPRegExp, " ").toLowerCase();
	}
	function oneOf(strings, startIndex) {
		if (strings === null) return null;
		else return {
			regex: RegExp(strings.map(fixListRegex).join("|")),
			deser: ([s]) => strings.findIndex((i) => stripInsensitivities(s) === stripInsensitivities(i)) + startIndex
		};
	}
	function offset(regex, groups) {
		return {
			regex,
			deser: ([, h, m]) => signedOffset(h, m),
			groups
		};
	}
	function simple(regex) {
		return {
			regex,
			deser: ([s]) => s
		};
	}
	function escapeToken(value) {
		return value.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, "\\$&");
	}
	/**
	* @param token
	* @param {Locale} loc
	*/
	function unitForToken(token, loc) {
		const one = digitRegex(loc), two = digitRegex(loc, "{2}"), three = digitRegex(loc, "{3}"), four = digitRegex(loc, "{4}"), six = digitRegex(loc, "{6}"), oneOrTwo = digitRegex(loc, "{1,2}"), oneToThree = digitRegex(loc, "{1,3}"), oneToSix = digitRegex(loc, "{1,6}"), oneToNine = digitRegex(loc, "{1,9}"), twoToFour = digitRegex(loc, "{2,4}"), fourToSix = digitRegex(loc, "{4,6}"), literal = (t) => ({
			regex: RegExp(escapeToken(t.val)),
			deser: ([s]) => s,
			literal: true
		}), unitate = (t) => {
			if (token.literal) return literal(t);
			switch (t.val) {
				case "G": return oneOf(loc.eras("short"), 0);
				case "GG": return oneOf(loc.eras("long"), 0);
				case "y": return intUnit(oneToSix);
				case "yy": return intUnit(twoToFour, untruncateYear);
				case "yyyy": return intUnit(four);
				case "yyyyy": return intUnit(fourToSix);
				case "yyyyyy": return intUnit(six);
				case "M": return intUnit(oneOrTwo);
				case "MM": return intUnit(two);
				case "MMM": return oneOf(loc.months("short", true), 1);
				case "MMMM": return oneOf(loc.months("long", true), 1);
				case "L": return intUnit(oneOrTwo);
				case "LL": return intUnit(two);
				case "LLL": return oneOf(loc.months("short", false), 1);
				case "LLLL": return oneOf(loc.months("long", false), 1);
				case "d": return intUnit(oneOrTwo);
				case "dd": return intUnit(two);
				case "o": return intUnit(oneToThree);
				case "ooo": return intUnit(three);
				case "HH": return intUnit(two);
				case "H": return intUnit(oneOrTwo);
				case "hh": return intUnit(two);
				case "h": return intUnit(oneOrTwo);
				case "mm": return intUnit(two);
				case "m": return intUnit(oneOrTwo);
				case "q": return intUnit(oneOrTwo);
				case "qq": return intUnit(two);
				case "s": return intUnit(oneOrTwo);
				case "ss": return intUnit(two);
				case "S": return intUnit(oneToThree);
				case "SSS": return intUnit(three);
				case "u": return simple(oneToNine);
				case "uu": return simple(oneOrTwo);
				case "uuu": return intUnit(one);
				case "a": return oneOf(loc.meridiems(), 0);
				case "kkkk": return intUnit(four);
				case "kk": return intUnit(twoToFour, untruncateYear);
				case "W": return intUnit(oneOrTwo);
				case "WW": return intUnit(two);
				case "E":
				case "c": return intUnit(one);
				case "EEE": return oneOf(loc.weekdays("short", false), 1);
				case "EEEE": return oneOf(loc.weekdays("long", false), 1);
				case "ccc": return oneOf(loc.weekdays("short", true), 1);
				case "cccc": return oneOf(loc.weekdays("long", true), 1);
				case "Z":
				case "ZZ": return offset(new RegExp(`([+-]${oneOrTwo.source})(?::(${two.source}))?`), 2);
				case "ZZZ": return offset(new RegExp(`([+-]${oneOrTwo.source})(${two.source})?`), 2);
				case "z": return simple(/[a-z_+-/]{1,256}?/i);
				case " ": return simple(/[^\S\n\r]/);
				default: return literal(t);
			}
		};
		const unit = unitate(token) || { invalidReason: MISSING_FTP };
		unit.token = token;
		return unit;
	}
	const partTypeStyleToTokenVal = {
		year: {
			"2-digit": "yy",
			numeric: "yyyyy"
		},
		month: {
			numeric: "M",
			"2-digit": "MM",
			short: "MMM",
			long: "MMMM"
		},
		day: {
			numeric: "d",
			"2-digit": "dd"
		},
		weekday: {
			short: "EEE",
			long: "EEEE"
		},
		dayperiod: "a",
		dayPeriod: "a",
		hour12: {
			numeric: "h",
			"2-digit": "hh"
		},
		hour24: {
			numeric: "H",
			"2-digit": "HH"
		},
		minute: {
			numeric: "m",
			"2-digit": "mm"
		},
		second: {
			numeric: "s",
			"2-digit": "ss"
		},
		timeZoneName: {
			long: "ZZZZZ",
			short: "ZZZ"
		}
	};
	function tokenForPart(part, formatOpts, resolvedOpts) {
		const { type, value } = part;
		if (type === "literal") {
			const isSpace = /^\s+$/.test(value);
			return {
				literal: !isSpace,
				val: isSpace ? " " : value
			};
		}
		const style = formatOpts[type];
		let actualType = type;
		if (type === "hour") if (formatOpts.hour12 != null) actualType = formatOpts.hour12 ? "hour12" : "hour24";
		else if (formatOpts.hourCycle != null) if (formatOpts.hourCycle === "h11" || formatOpts.hourCycle === "h12") actualType = "hour12";
		else actualType = "hour24";
		else actualType = resolvedOpts.hour12 ? "hour12" : "hour24";
		let val = partTypeStyleToTokenVal[actualType];
		if (typeof val === "object") val = val[style];
		if (val) return {
			literal: false,
			val
		};
	}
	function buildRegex(units) {
		return [`^${units.map((u) => u.regex).reduce((f, r) => `${f}(${r.source})`, "")}$`, units];
	}
	function match(input, regex, handlers) {
		const matches = input.match(regex);
		if (matches) {
			const all = {};
			let matchIndex = 1;
			for (const i in handlers) if (hasOwnProperty(handlers, i)) {
				const h = handlers[i], groups = h.groups ? h.groups + 1 : 1;
				if (!h.literal && h.token) all[h.token.val[0]] = h.deser(matches.slice(matchIndex, matchIndex + groups));
				matchIndex += groups;
			}
			return [matches, all];
		} else return [matches, {}];
	}
	function dateTimeFromMatches(matches) {
		const toField = (token) => {
			switch (token) {
				case "S": return "millisecond";
				case "s": return "second";
				case "m": return "minute";
				case "h":
				case "H": return "hour";
				case "d": return "day";
				case "o": return "ordinal";
				case "L":
				case "M": return "month";
				case "y": return "year";
				case "E":
				case "c": return "weekday";
				case "W": return "weekNumber";
				case "k": return "weekYear";
				case "q": return "quarter";
				default: return null;
			}
		};
		let zone = null;
		let specificOffset;
		if (!isUndefined(matches.z)) zone = IANAZone.create(matches.z);
		if (!isUndefined(matches.Z)) {
			if (!zone) zone = new FixedOffsetZone(matches.Z);
			specificOffset = matches.Z;
		}
		if (!isUndefined(matches.q)) matches.M = (matches.q - 1) * 3 + 1;
		if (!isUndefined(matches.h)) {
			if (matches.h < 12 && matches.a === 1) matches.h += 12;
			else if (matches.h === 12 && matches.a === 0) matches.h = 0;
		}
		if (matches.G === 0 && matches.y) matches.y = -matches.y;
		if (!isUndefined(matches.u)) matches.S = parseMillis(matches.u);
		return [
			Object.keys(matches).reduce((r, k) => {
				const f = toField(k);
				if (f) r[f] = matches[k];
				return r;
			}, {}),
			zone,
			specificOffset
		];
	}
	let dummyDateTimeCache = null;
	function getDummyDateTime() {
		if (!dummyDateTimeCache) dummyDateTimeCache = DateTime.fromMillis(1555555555555);
		return dummyDateTimeCache;
	}
	function maybeExpandMacroToken(token, locale) {
		if (token.literal) return token;
		const tokens = formatOptsToTokens(Formatter.macroTokenToFormatOpts(token.val), locale);
		if (tokens == null || tokens.includes(void 0)) return token;
		return tokens;
	}
	function expandMacroTokens(tokens, locale) {
		return Array.prototype.concat(...tokens.map((t) => maybeExpandMacroToken(t, locale)));
	}
	/**
	* @private
	*/
	var TokenParser = class {
		constructor(locale, format) {
			this.locale = locale;
			this.format = format;
			this.tokens = expandMacroTokens(Formatter.parseFormat(format), locale);
			this.units = this.tokens.map((t) => unitForToken(t, locale));
			this.disqualifyingUnit = this.units.find((t) => t.invalidReason);
			if (!this.disqualifyingUnit) {
				const [regexString, handlers] = buildRegex(this.units);
				this.regex = RegExp(regexString, "i");
				this.handlers = handlers;
			}
		}
		explainFromTokens(input) {
			if (!this.isValid) return {
				input,
				tokens: this.tokens,
				invalidReason: this.invalidReason
			};
			else {
				const [rawMatches, matches] = match(input, this.regex, this.handlers), [result, zone, specificOffset] = matches ? dateTimeFromMatches(matches) : [
					null,
					null,
					void 0
				];
				if (hasOwnProperty(matches, "a") && hasOwnProperty(matches, "H")) throw new ConflictingSpecificationError("Can't include meridiem when specifying 24-hour format");
				return {
					input,
					tokens: this.tokens,
					regex: this.regex,
					rawMatches,
					matches,
					result,
					zone,
					specificOffset
				};
			}
		}
		get isValid() {
			return !this.disqualifyingUnit;
		}
		get invalidReason() {
			return this.disqualifyingUnit ? this.disqualifyingUnit.invalidReason : null;
		}
	};
	function explainFromTokens(locale, input, format) {
		return new TokenParser(locale, format).explainFromTokens(input);
	}
	function parseFromTokens(locale, input, format) {
		const { result, zone, specificOffset, invalidReason } = explainFromTokens(locale, input, format);
		return [
			result,
			zone,
			specificOffset,
			invalidReason
		];
	}
	function formatOptsToTokens(formatOpts, locale) {
		if (!formatOpts) return null;
		const df = Formatter.create(locale, formatOpts).dtFormatter(getDummyDateTime());
		const parts = df.formatToParts();
		const resolvedOpts = df.resolvedOptions();
		return parts.map((p) => tokenForPart(p, formatOpts, resolvedOpts));
	}
	const INVALID = "Invalid DateTime";
	const MAX_DATE = 864e13;
	function unsupportedZone(zone) {
		return new Invalid("unsupported zone", `the zone "${zone.name}" is not supported`);
	}
	/**
	* @param {DateTime} dt
	*/
	function possiblyCachedWeekData(dt) {
		if (dt.weekData === null) dt.weekData = gregorianToWeek(dt.c);
		return dt.weekData;
	}
	/**
	* @param {DateTime} dt
	*/
	function possiblyCachedLocalWeekData(dt) {
		if (dt.localWeekData === null) dt.localWeekData = gregorianToWeek(dt.c, dt.loc.getMinDaysInFirstWeek(), dt.loc.getStartOfWeek());
		return dt.localWeekData;
	}
	function clone(inst, alts) {
		const current = {
			ts: inst.ts,
			zone: inst.zone,
			c: inst.c,
			o: inst.o,
			loc: inst.loc,
			invalid: inst.invalid
		};
		return new DateTime({
			...current,
			...alts,
			old: current
		});
	}
	function fixOffset(localTS, o, tz) {
		let utcGuess = localTS - o * 60 * 1e3;
		const o2 = tz.offset(utcGuess);
		if (o === o2) return [utcGuess, o];
		utcGuess -= (o2 - o) * 60 * 1e3;
		const o3 = tz.offset(utcGuess);
		if (o2 === o3) return [utcGuess, o2];
		return [localTS - Math.min(o2, o3) * 60 * 1e3, Math.max(o2, o3)];
	}
	function tsToObj(ts, offset) {
		ts += offset * 60 * 1e3;
		const d = new Date(ts);
		return {
			year: d.getUTCFullYear(),
			month: d.getUTCMonth() + 1,
			day: d.getUTCDate(),
			hour: d.getUTCHours(),
			minute: d.getUTCMinutes(),
			second: d.getUTCSeconds(),
			millisecond: d.getUTCMilliseconds()
		};
	}
	function objToTS(obj, offset, zone) {
		return fixOffset(objToLocalTS(obj), offset, zone);
	}
	function adjustTime(inst, dur) {
		const oPre = inst.o, year = inst.c.year + Math.trunc(dur.years), month = inst.c.month + Math.trunc(dur.months) + Math.trunc(dur.quarters) * 3, c = {
			...inst.c,
			year,
			month,
			day: Math.min(inst.c.day, daysInMonth(year, month)) + Math.trunc(dur.days) + Math.trunc(dur.weeks) * 7
		}, millisToAdd = Duration.fromObject({
			years: dur.years - Math.trunc(dur.years),
			quarters: dur.quarters - Math.trunc(dur.quarters),
			months: dur.months - Math.trunc(dur.months),
			weeks: dur.weeks - Math.trunc(dur.weeks),
			days: dur.days - Math.trunc(dur.days),
			hours: dur.hours,
			minutes: dur.minutes,
			seconds: dur.seconds,
			milliseconds: dur.milliseconds
		}).as("milliseconds");
		let [ts, o] = fixOffset(objToLocalTS(c), oPre, inst.zone);
		if (millisToAdd !== 0) {
			ts += millisToAdd;
			o = inst.zone.offset(ts);
		}
		return {
			ts,
			o
		};
	}
	function parseDataToDateTime(parsed, parsedZone, opts, format, text, specificOffset) {
		const { setZone, zone } = opts;
		if (parsed && Object.keys(parsed).length !== 0 || parsedZone) {
			const interpretationZone = parsedZone || zone, inst = DateTime.fromObject(parsed, {
				...opts,
				zone: interpretationZone,
				specificOffset
			});
			return setZone ? inst : inst.setZone(zone);
		} else return DateTime.invalid(new Invalid("unparsable", `the input "${text}" can't be parsed as ${format}`));
	}
	function toTechFormat(dt, format, allowZ = true) {
		return dt.isValid ? Formatter.create(Locale.create("en-US"), {
			allowZ,
			forceSimple: true
		}).formatDateTimeFromString(dt, format) : null;
	}
	function toISODate(o, extended, precision) {
		const longFormat = o.c.year > 9999 || o.c.year < 0;
		let c = "";
		if (longFormat && o.c.year >= 0) c += "+";
		c += padStart(o.c.year, longFormat ? 6 : 4);
		if (precision === "year") return c;
		if (extended) {
			c += "-";
			c += padStart(o.c.month);
			if (precision === "month") return c;
			c += "-";
		} else {
			c += padStart(o.c.month);
			if (precision === "month") return c;
		}
		c += padStart(o.c.day);
		return c;
	}
	function toISOTime(o, extended, suppressSeconds, suppressMilliseconds, includeOffset, extendedZone, precision) {
		let showSeconds = !suppressSeconds || o.c.millisecond !== 0 || o.c.second !== 0, c = "";
		switch (precision) {
			case "day":
			case "month":
			case "year": break;
			default:
				c += padStart(o.c.hour);
				if (precision === "hour") break;
				if (extended) {
					c += ":";
					c += padStart(o.c.minute);
					if (precision === "minute") break;
					if (showSeconds) {
						c += ":";
						c += padStart(o.c.second);
					}
				} else {
					c += padStart(o.c.minute);
					if (precision === "minute") break;
					if (showSeconds) c += padStart(o.c.second);
				}
				if (precision === "second") break;
				if (showSeconds && (!suppressMilliseconds || o.c.millisecond !== 0)) {
					c += ".";
					c += padStart(o.c.millisecond, 3);
				}
		}
		if (includeOffset) if (o.isOffsetFixed && o.offset === 0 && !extendedZone) c += "Z";
		else if (o.o < 0) {
			c += "-";
			c += padStart(Math.trunc(-o.o / 60));
			c += ":";
			c += padStart(Math.trunc(-o.o % 60));
		} else {
			c += "+";
			c += padStart(Math.trunc(o.o / 60));
			c += ":";
			c += padStart(Math.trunc(o.o % 60));
		}
		if (extendedZone) c += "[" + o.zone.ianaName + "]";
		return c;
	}
	const defaultUnitValues = {
		month: 1,
		day: 1,
		hour: 0,
		minute: 0,
		second: 0,
		millisecond: 0
	}, defaultWeekUnitValues = {
		weekNumber: 1,
		weekday: 1,
		hour: 0,
		minute: 0,
		second: 0,
		millisecond: 0
	}, defaultOrdinalUnitValues = {
		ordinal: 1,
		hour: 0,
		minute: 0,
		second: 0,
		millisecond: 0
	};
	const orderedUnits = [
		"year",
		"month",
		"day",
		"hour",
		"minute",
		"second",
		"millisecond"
	], orderedWeekUnits = [
		"weekYear",
		"weekNumber",
		"weekday",
		"hour",
		"minute",
		"second",
		"millisecond"
	], orderedOrdinalUnits = [
		"year",
		"ordinal",
		"hour",
		"minute",
		"second",
		"millisecond"
	];
	function normalizeUnit(unit) {
		const normalized = {
			year: "year",
			years: "year",
			month: "month",
			months: "month",
			day: "day",
			days: "day",
			hour: "hour",
			hours: "hour",
			minute: "minute",
			minutes: "minute",
			quarter: "quarter",
			quarters: "quarter",
			second: "second",
			seconds: "second",
			millisecond: "millisecond",
			milliseconds: "millisecond",
			weekday: "weekday",
			weekdays: "weekday",
			weeknumber: "weekNumber",
			weeksnumber: "weekNumber",
			weeknumbers: "weekNumber",
			weekyear: "weekYear",
			weekyears: "weekYear",
			ordinal: "ordinal"
		}[unit.toLowerCase()];
		if (!normalized) throw new InvalidUnitError(unit);
		return normalized;
	}
	function normalizeUnitWithLocalWeeks(unit) {
		switch (unit.toLowerCase()) {
			case "localweekday":
			case "localweekdays": return "localWeekday";
			case "localweeknumber":
			case "localweeknumbers": return "localWeekNumber";
			case "localweekyear":
			case "localweekyears": return "localWeekYear";
			default: return normalizeUnit(unit);
		}
	}
	/**
	* @param {Zone} zone
	* @return {number}
	*/
	function guessOffsetForZone(zone) {
		if (zoneOffsetTs === void 0) zoneOffsetTs = Settings.now();
		if (zone.type !== "iana") return zone.offset(zoneOffsetTs);
		const zoneName = zone.name;
		let offsetGuess = zoneOffsetGuessCache.get(zoneName);
		if (offsetGuess === void 0) {
			offsetGuess = zone.offset(zoneOffsetTs);
			zoneOffsetGuessCache.set(zoneName, offsetGuess);
		}
		return offsetGuess;
	}
	function quickDT(obj, opts) {
		const zone = normalizeZone(opts.zone, Settings.defaultZone);
		if (!zone.isValid) return DateTime.invalid(unsupportedZone(zone));
		const loc = Locale.fromObject(opts);
		let ts, o;
		if (!isUndefined(obj.year)) {
			for (const u of orderedUnits) if (isUndefined(obj[u])) obj[u] = defaultUnitValues[u];
			const invalid = hasInvalidGregorianData(obj) || hasInvalidTimeData(obj);
			if (invalid) return DateTime.invalid(invalid);
			const offsetProvis = guessOffsetForZone(zone);
			[ts, o] = objToTS(obj, offsetProvis, zone);
		} else ts = Settings.now();
		return new DateTime({
			ts,
			zone,
			loc,
			o
		});
	}
	function diffRelative(start, end, opts) {
		const round = isUndefined(opts.round) ? true : opts.round, rounding = isUndefined(opts.rounding) ? "trunc" : opts.rounding, format = (c, unit) => {
			c = roundTo(c, round || opts.calendary ? 0 : 2, opts.calendary ? "round" : rounding);
			return end.loc.clone(opts).relFormatter(opts).format(c, unit);
		}, differ = (unit) => {
			if (opts.calendary) if (!end.hasSame(start, unit)) return end.startOf(unit).diff(start.startOf(unit), unit).get(unit);
			else return 0;
			else return end.diff(start, unit).get(unit);
		};
		if (opts.unit) return format(differ(opts.unit), opts.unit);
		for (const unit of opts.units) {
			const count = differ(unit);
			if (Math.abs(count) >= 1) return format(count, unit);
		}
		return format(start > end ? -0 : 0, opts.units[opts.units.length - 1]);
	}
	function lastOpts(argList) {
		let opts = {}, args;
		if (argList.length > 0 && typeof argList[argList.length - 1] === "object") {
			opts = argList[argList.length - 1];
			args = Array.from(argList).slice(0, argList.length - 1);
		} else args = Array.from(argList);
		return [opts, args];
	}
	/**
	* Timestamp to use for cached zone offset guesses (exposed for test)
	*/
	let zoneOffsetTs;
	/**
	* Cache for zone offset guesses (exposed for test).
	*
	* This optimizes quickDT via guessOffsetForZone to avoid repeated calls of
	* zone.offset().
	*/
	const zoneOffsetGuessCache = /* @__PURE__ */ new Map();
	/**
	* A DateTime is an immutable data structure representing a specific date and time and accompanying methods. It contains class and instance methods for creating, parsing, interrogating, transforming, and formatting them.
	*
	* A DateTime comprises of:
	* * A timestamp. Each DateTime instance refers to a specific millisecond of the Unix epoch.
	* * A time zone. Each instance is considered in the context of a specific zone (by default the local system's zone).
	* * Configuration properties that effect how output strings are formatted, such as `locale`, `numberingSystem`, and `outputCalendar`.
	*
	* Here is a brief overview of the most commonly used functionality it provides:
	*
	* * **Creation**: To create a DateTime from its components, use one of its factory class methods: {@link DateTime.local}, {@link DateTime.utc}, and (most flexibly) {@link DateTime.fromObject}. To create one from a standard string format, use {@link DateTime.fromISO}, {@link DateTime.fromHTTP}, and {@link DateTime.fromRFC2822}. To create one from a custom string format, use {@link DateTime.fromFormat}. To create one from a native JS date, use {@link DateTime.fromJSDate}.
	* * **Gregorian calendar and time**: To examine the Gregorian properties of a DateTime individually (i.e as opposed to collectively through {@link DateTime#toObject}), use the {@link DateTime#year}, {@link DateTime#month},
	* {@link DateTime#day}, {@link DateTime#hour}, {@link DateTime#minute}, {@link DateTime#second}, {@link DateTime#millisecond} accessors.
	* * **Week calendar**: For ISO week calendar attributes, see the {@link DateTime#weekYear}, {@link DateTime#weekNumber}, and {@link DateTime#weekday} accessors.
	* * **Configuration** See the {@link DateTime#locale} and {@link DateTime#numberingSystem} accessors.
	* * **Transformation**: To transform the DateTime into other DateTimes, use {@link DateTime#set}, {@link DateTime#reconfigure}, {@link DateTime#setZone}, {@link DateTime#setLocale}, {@link DateTime.plus}, {@link DateTime#minus}, {@link DateTime#endOf}, {@link DateTime#startOf}, {@link DateTime#toUTC}, and {@link DateTime#toLocal}.
	* * **Output**: To convert the DateTime to other representations, use the {@link DateTime#toRelative}, {@link DateTime#toRelativeCalendar}, {@link DateTime#toJSON}, {@link DateTime#toISO}, {@link DateTime#toHTTP}, {@link DateTime#toObject}, {@link DateTime#toRFC2822}, {@link DateTime#toString}, {@link DateTime#toLocaleString}, {@link DateTime#toFormat}, {@link DateTime#toMillis} and {@link DateTime#toJSDate}.
	*
	* There's plenty others documented below. In addition, for more information on subtler topics like internationalization, time zones, alternative calendars, validity, and so on, see the external documentation.
	*/
	var DateTime = class DateTime {
		/**
		* @access private
		*/
		constructor(config) {
			const zone = config.zone || Settings.defaultZone;
			let invalid = config.invalid || (Number.isNaN(config.ts) ? new Invalid("invalid input") : null) || (!zone.isValid ? unsupportedZone(zone) : null);
			/**
			* @access private
			*/
			this.ts = isUndefined(config.ts) ? Settings.now() : config.ts;
			let c = null, o = null;
			if (!invalid) if (config.old && config.old.ts === this.ts && config.old.zone.equals(zone)) [c, o] = [config.old.c, config.old.o];
			else {
				const ot = isNumber(config.o) && !config.old ? config.o : zone.offset(this.ts);
				c = tsToObj(this.ts, ot);
				invalid = Number.isNaN(c.year) ? new Invalid("invalid input") : null;
				c = invalid ? null : c;
				o = invalid ? null : ot;
			}
			/**
			* @access private
			*/
			this._zone = zone;
			/**
			* @access private
			*/
			this.loc = config.loc || Locale.create();
			/**
			* @access private
			*/
			this.invalid = invalid;
			/**
			* @access private
			*/
			this.weekData = null;
			/**
			* @access private
			*/
			this.localWeekData = null;
			/**
			* @access private
			*/
			this.c = c;
			/**
			* @access private
			*/
			this.o = o;
			/**
			* @access private
			*/
			this.isLuxonDateTime = true;
		}
		/**
		* Create a DateTime for the current instant, in the system's time zone.
		*
		* Use Settings to override these default values if needed.
		* @example DateTime.now().toISO() //~> now in the ISO format
		* @return {DateTime}
		*/
		static now() {
			return new DateTime({});
		}
		/**
		* Create a local DateTime
		* @param {number} [year] - The calendar year. If omitted (as in, call `local()` with no arguments), the current time will be used
		* @param {number} [month=1] - The month, 1-indexed
		* @param {number} [day=1] - The day of the month, 1-indexed
		* @param {number} [hour=0] - The hour of the day, in 24-hour time
		* @param {number} [minute=0] - The minute of the hour, meaning a number between 0 and 59
		* @param {number} [second=0] - The second of the minute, meaning a number between 0 and 59
		* @param {number} [millisecond=0] - The millisecond of the second, meaning a number between 0 and 999
		* @example DateTime.local()                                  //~> now
		* @example DateTime.local({ zone: "America/New_York" })      //~> now, in US east coast time
		* @example DateTime.local(2017)                              //~> 2017-01-01T00:00:00
		* @example DateTime.local(2017, 3)                           //~> 2017-03-01T00:00:00
		* @example DateTime.local(2017, 3, 12, { locale: "fr" })     //~> 2017-03-12T00:00:00, with a French locale
		* @example DateTime.local(2017, 3, 12, 5)                    //~> 2017-03-12T05:00:00
		* @example DateTime.local(2017, 3, 12, 5, { zone: "utc" })   //~> 2017-03-12T05:00:00, in UTC
		* @example DateTime.local(2017, 3, 12, 5, 45)                //~> 2017-03-12T05:45:00
		* @example DateTime.local(2017, 3, 12, 5, 45, 10)            //~> 2017-03-12T05:45:10
		* @example DateTime.local(2017, 3, 12, 5, 45, 10, 765)       //~> 2017-03-12T05:45:10.765
		* @return {DateTime}
		*/
		static local() {
			const [opts, args] = lastOpts(arguments), [year, month, day, hour, minute, second, millisecond] = args;
			return quickDT({
				year,
				month,
				day,
				hour,
				minute,
				second,
				millisecond
			}, opts);
		}
		/**
		* Create a DateTime in UTC
		* @param {number} [year] - The calendar year. If omitted (as in, call `utc()` with no arguments), the current time will be used
		* @param {number} [month=1] - The month, 1-indexed
		* @param {number} [day=1] - The day of the month
		* @param {number} [hour=0] - The hour of the day, in 24-hour time
		* @param {number} [minute=0] - The minute of the hour, meaning a number between 0 and 59
		* @param {number} [second=0] - The second of the minute, meaning a number between 0 and 59
		* @param {number} [millisecond=0] - The millisecond of the second, meaning a number between 0 and 999
		* @param {Object} options - configuration options for the DateTime
		* @param {string} [options.locale] - a locale to set on the resulting DateTime instance
		* @param {string} [options.outputCalendar] - the output calendar to set on the resulting DateTime instance
		* @param {string} [options.numberingSystem] - the numbering system to set on the resulting DateTime instance
		* @param {string} [options.weekSettings] - the week settings to set on the resulting DateTime instance
		* @example DateTime.utc()                                              //~> now
		* @example DateTime.utc(2017)                                          //~> 2017-01-01T00:00:00Z
		* @example DateTime.utc(2017, 3)                                       //~> 2017-03-01T00:00:00Z
		* @example DateTime.utc(2017, 3, 12)                                   //~> 2017-03-12T00:00:00Z
		* @example DateTime.utc(2017, 3, 12, 5)                                //~> 2017-03-12T05:00:00Z
		* @example DateTime.utc(2017, 3, 12, 5, 45)                            //~> 2017-03-12T05:45:00Z
		* @example DateTime.utc(2017, 3, 12, 5, 45, { locale: "fr" })          //~> 2017-03-12T05:45:00Z with a French locale
		* @example DateTime.utc(2017, 3, 12, 5, 45, 10)                        //~> 2017-03-12T05:45:10Z
		* @example DateTime.utc(2017, 3, 12, 5, 45, 10, 765, { locale: "fr" }) //~> 2017-03-12T05:45:10.765Z with a French locale
		* @return {DateTime}
		*/
		static utc() {
			const [opts, args] = lastOpts(arguments), [year, month, day, hour, minute, second, millisecond] = args;
			opts.zone = FixedOffsetZone.utcInstance;
			return quickDT({
				year,
				month,
				day,
				hour,
				minute,
				second,
				millisecond
			}, opts);
		}
		/**
		* Create a DateTime from a JavaScript Date object. Uses the default zone.
		* @param {Date} date - a JavaScript Date object
		* @param {Object} options - configuration options for the DateTime
		* @param {string|Zone} [options.zone='local'] - the zone to place the DateTime into
		* @return {DateTime}
		*/
		static fromJSDate(date, options = {}) {
			const ts = isDate(date) ? date.valueOf() : NaN;
			if (Number.isNaN(ts)) return DateTime.invalid("invalid input");
			const zoneToUse = normalizeZone(options.zone, Settings.defaultZone);
			if (!zoneToUse.isValid) return DateTime.invalid(unsupportedZone(zoneToUse));
			return new DateTime({
				ts,
				zone: zoneToUse,
				loc: Locale.fromObject(options)
			});
		}
		/**
		* Create a DateTime from a number of milliseconds since the epoch (meaning since 1 January 1970 00:00:00 UTC). Uses the default zone.
		* @param {number} milliseconds - a number of milliseconds since 1970 UTC
		* @param {Object} options - configuration options for the DateTime
		* @param {string|Zone} [options.zone='local'] - the zone to place the DateTime into
		* @param {string} [options.locale] - a locale to set on the resulting DateTime instance
		* @param {string} options.outputCalendar - the output calendar to set on the resulting DateTime instance
		* @param {string} options.numberingSystem - the numbering system to set on the resulting DateTime instance
		* @param {string} options.weekSettings - the week settings to set on the resulting DateTime instance
		* @return {DateTime}
		*/
		static fromMillis(milliseconds, options = {}) {
			if (!isNumber(milliseconds)) throw new InvalidArgumentError(`fromMillis requires a numerical input, but received a ${typeof milliseconds} with value ${milliseconds}`);
			else if (milliseconds < -MAX_DATE || milliseconds > MAX_DATE) return DateTime.invalid("Timestamp out of range");
			else return new DateTime({
				ts: milliseconds,
				zone: normalizeZone(options.zone, Settings.defaultZone),
				loc: Locale.fromObject(options)
			});
		}
		/**
		* Create a DateTime from a number of seconds since the epoch (meaning since 1 January 1970 00:00:00 UTC). Uses the default zone.
		* @param {number} seconds - a number of seconds since 1970 UTC
		* @param {Object} options - configuration options for the DateTime
		* @param {string|Zone} [options.zone='local'] - the zone to place the DateTime into
		* @param {string} [options.locale] - a locale to set on the resulting DateTime instance
		* @param {string} options.outputCalendar - the output calendar to set on the resulting DateTime instance
		* @param {string} options.numberingSystem - the numbering system to set on the resulting DateTime instance
		* @param {string} options.weekSettings - the week settings to set on the resulting DateTime instance
		* @return {DateTime}
		*/
		static fromSeconds(seconds, options = {}) {
			if (!isNumber(seconds)) throw new InvalidArgumentError("fromSeconds requires a numerical input");
			else return new DateTime({
				ts: seconds * 1e3,
				zone: normalizeZone(options.zone, Settings.defaultZone),
				loc: Locale.fromObject(options)
			});
		}
		/**
		* Create a DateTime from a JavaScript object with keys like 'year' and 'hour' with reasonable defaults.
		* @param {Object} obj - the object to create the DateTime from
		* @param {number} obj.year - a year, such as 1987
		* @param {number} obj.month - a month, 1-12
		* @param {number} obj.day - a day of the month, 1-31, depending on the month
		* @param {number} obj.ordinal - day of the year, 1-365 or 366
		* @param {number} obj.weekYear - an ISO week year
		* @param {number} obj.weekNumber - an ISO week number, between 1 and 52 or 53, depending on the year
		* @param {number} obj.weekday - an ISO weekday, 1-7, where 1 is Monday and 7 is Sunday
		* @param {number} obj.localWeekYear - a week year, according to the locale
		* @param {number} obj.localWeekNumber - a week number, between 1 and 52 or 53, depending on the year, according to the locale
		* @param {number} obj.localWeekday - a weekday, 1-7, where 1 is the first and 7 is the last day of the week, according to the locale
		* @param {number} obj.hour - hour of the day, 0-23
		* @param {number} obj.minute - minute of the hour, 0-59
		* @param {number} obj.second - second of the minute, 0-59
		* @param {number} obj.millisecond - millisecond of the second, 0-999
		* @param {Object} opts - options for creating this DateTime
		* @param {string|Zone} [opts.zone='local'] - interpret the numbers in the context of a particular zone. Can take any value taken as the first argument to setZone()
		* @param {string} [opts.locale='system\'s locale'] - a locale to set on the resulting DateTime instance
		* @param {string} opts.outputCalendar - the output calendar to set on the resulting DateTime instance
		* @param {string} opts.numberingSystem - the numbering system to set on the resulting DateTime instance
		* @param {string} opts.weekSettings - the week settings to set on the resulting DateTime instance
		* @example DateTime.fromObject({ year: 1982, month: 5, day: 25}).toISODate() //=> '1982-05-25'
		* @example DateTime.fromObject({ year: 1982 }).toISODate() //=> '1982-01-01'
		* @example DateTime.fromObject({ hour: 10, minute: 26, second: 6 }) //~> today at 10:26:06
		* @example DateTime.fromObject({ hour: 10, minute: 26, second: 6 }, { zone: 'utc' }),
		* @example DateTime.fromObject({ hour: 10, minute: 26, second: 6 }, { zone: 'local' })
		* @example DateTime.fromObject({ hour: 10, minute: 26, second: 6 }, { zone: 'America/New_York' })
		* @example DateTime.fromObject({ weekYear: 2016, weekNumber: 2, weekday: 3 }).toISODate() //=> '2016-01-13'
		* @example DateTime.fromObject({ localWeekYear: 2022, localWeekNumber: 1, localWeekday: 1 }, { locale: "en-US" }).toISODate() //=> '2021-12-26'
		* @return {DateTime}
		*/
		static fromObject(obj, opts = {}) {
			obj = obj || {};
			const zoneToUse = normalizeZone(opts.zone, Settings.defaultZone);
			if (!zoneToUse.isValid) return DateTime.invalid(unsupportedZone(zoneToUse));
			const loc = Locale.fromObject(opts);
			const normalized = normalizeObject(obj, normalizeUnitWithLocalWeeks);
			const { minDaysInFirstWeek, startOfWeek } = usesLocalWeekValues(normalized, loc);
			const tsNow = Settings.now(), offsetProvis = !isUndefined(opts.specificOffset) ? opts.specificOffset : zoneToUse.offset(tsNow), containsOrdinal = !isUndefined(normalized.ordinal), containsGregorYear = !isUndefined(normalized.year), containsGregorMD = !isUndefined(normalized.month) || !isUndefined(normalized.day), containsGregor = containsGregorYear || containsGregorMD, definiteWeekDef = normalized.weekYear || normalized.weekNumber;
			if ((containsGregor || containsOrdinal) && definiteWeekDef) throw new ConflictingSpecificationError("Can't mix weekYear/weekNumber units with year/month/day or ordinals");
			if (containsGregorMD && containsOrdinal) throw new ConflictingSpecificationError("Can't mix ordinal dates with month/day");
			const useWeekData = definiteWeekDef || normalized.weekday && !containsGregor;
			let units, defaultValues, objNow = tsToObj(tsNow, offsetProvis);
			if (useWeekData) {
				units = orderedWeekUnits;
				defaultValues = defaultWeekUnitValues;
				objNow = gregorianToWeek(objNow, minDaysInFirstWeek, startOfWeek);
			} else if (containsOrdinal) {
				units = orderedOrdinalUnits;
				defaultValues = defaultOrdinalUnitValues;
				objNow = gregorianToOrdinal(objNow);
			} else {
				units = orderedUnits;
				defaultValues = defaultUnitValues;
			}
			let foundFirst = false;
			for (const u of units) {
				const v = normalized[u];
				if (!isUndefined(v)) foundFirst = true;
				else if (foundFirst) normalized[u] = defaultValues[u];
				else normalized[u] = objNow[u];
			}
			const invalid = (useWeekData ? hasInvalidWeekData(normalized, minDaysInFirstWeek, startOfWeek) : containsOrdinal ? hasInvalidOrdinalData(normalized) : hasInvalidGregorianData(normalized)) || hasInvalidTimeData(normalized);
			if (invalid) return DateTime.invalid(invalid);
			const [tsFinal, offsetFinal] = objToTS(useWeekData ? weekToGregorian(normalized, minDaysInFirstWeek, startOfWeek) : containsOrdinal ? ordinalToGregorian(normalized) : normalized, offsetProvis, zoneToUse), inst = new DateTime({
				ts: tsFinal,
				zone: zoneToUse,
				o: offsetFinal,
				loc
			});
			if (normalized.weekday && containsGregor && obj.weekday !== inst.weekday) return DateTime.invalid("mismatched weekday", `you can't specify both a weekday of ${normalized.weekday} and a date of ${inst.toISO()}`);
			if (!inst.isValid) return DateTime.invalid(inst.invalid);
			return inst;
		}
		/**
		* Create a DateTime from an ISO 8601 string
		* @param {string} text - the ISO string
		* @param {Object} opts - options to affect the creation
		* @param {string|Zone} [opts.zone='local'] - use this zone if no offset is specified in the input string itself. Will also convert the time to this zone
		* @param {boolean} [opts.setZone=false] - override the zone with a fixed-offset zone specified in the string itself, if it specifies one
		* @param {string} [opts.locale='system's locale'] - a locale to set on the resulting DateTime instance
		* @param {string} [opts.outputCalendar] - the output calendar to set on the resulting DateTime instance
		* @param {string} [opts.numberingSystem] - the numbering system to set on the resulting DateTime instance
		* @param {string} [opts.weekSettings] - the week settings to set on the resulting DateTime instance
		* @example DateTime.fromISO('2016-05-25T09:08:34.123')
		* @example DateTime.fromISO('2016-05-25T09:08:34.123+06:00')
		* @example DateTime.fromISO('2016-05-25T09:08:34.123+06:00', {setZone: true})
		* @example DateTime.fromISO('2016-05-25T09:08:34.123', {zone: 'utc'})
		* @example DateTime.fromISO('2016-W05-4')
		* @return {DateTime}
		*/
		static fromISO(text, opts = {}) {
			const [vals, parsedZone] = parseISODate(text);
			return parseDataToDateTime(vals, parsedZone, opts, "ISO 8601", text);
		}
		/**
		* Create a DateTime from an RFC 2822 string
		* @param {string} text - the RFC 2822 string
		* @param {Object} opts - options to affect the creation
		* @param {string|Zone} [opts.zone='local'] - convert the time to this zone. Since the offset is always specified in the string itself, this has no effect on the interpretation of string, merely the zone the resulting DateTime is expressed in.
		* @param {boolean} [opts.setZone=false] - override the zone with a fixed-offset zone specified in the string itself, if it specifies one
		* @param {string} [opts.locale='system's locale'] - a locale to set on the resulting DateTime instance
		* @param {string} opts.outputCalendar - the output calendar to set on the resulting DateTime instance
		* @param {string} opts.numberingSystem - the numbering system to set on the resulting DateTime instance
		* @param {string} opts.weekSettings - the week settings to set on the resulting DateTime instance
		* @example DateTime.fromRFC2822('25 Nov 2016 13:23:12 GMT')
		* @example DateTime.fromRFC2822('Fri, 25 Nov 2016 13:23:12 +0600')
		* @example DateTime.fromRFC2822('25 Nov 2016 13:23 Z')
		* @return {DateTime}
		*/
		static fromRFC2822(text, opts = {}) {
			const [vals, parsedZone] = parseRFC2822Date(text);
			return parseDataToDateTime(vals, parsedZone, opts, "RFC 2822", text);
		}
		/**
		* Create a DateTime from an HTTP header date
		* @see https://www.w3.org/Protocols/rfc2616/rfc2616-sec3.html#sec3.3.1
		* @param {string} text - the HTTP header date
		* @param {Object} opts - options to affect the creation
		* @param {string|Zone} [opts.zone='local'] - convert the time to this zone. Since HTTP dates are always in UTC, this has no effect on the interpretation of string, merely the zone the resulting DateTime is expressed in.
		* @param {boolean} [opts.setZone=false] - override the zone with the fixed-offset zone specified in the string. For HTTP dates, this is always UTC, so this option is equivalent to setting the `zone` option to 'utc', but this option is included for consistency with similar methods.
		* @param {string} [opts.locale='system's locale'] - a locale to set on the resulting DateTime instance
		* @param {string} opts.outputCalendar - the output calendar to set on the resulting DateTime instance
		* @param {string} opts.numberingSystem - the numbering system to set on the resulting DateTime instance
		* @param {string} opts.weekSettings - the week settings to set on the resulting DateTime instance
		* @example DateTime.fromHTTP('Sun, 06 Nov 1994 08:49:37 GMT')
		* @example DateTime.fromHTTP('Sunday, 06-Nov-94 08:49:37 GMT')
		* @example DateTime.fromHTTP('Sun Nov  6 08:49:37 1994')
		* @return {DateTime}
		*/
		static fromHTTP(text, opts = {}) {
			const [vals, parsedZone] = parseHTTPDate(text);
			return parseDataToDateTime(vals, parsedZone, opts, "HTTP", opts);
		}
		/**
		* Create a DateTime from an input string and format string.
		* Defaults to en-US if no locale has been specified, regardless of the system's locale. For a table of tokens and their interpretations, see [here](https://moment.github.io/luxon/#/parsing?id=table-of-tokens).
		* @param {string} text - the string to parse
		* @param {string} fmt - the format the string is expected to be in (see the link below for the formats)
		* @param {Object} opts - options to affect the creation
		* @param {string|Zone} [opts.zone='local'] - use this zone if no offset is specified in the input string itself. Will also convert the DateTime to this zone
		* @param {boolean} [opts.setZone=false] - override the zone with a zone specified in the string itself, if it specifies one
		* @param {string} [opts.locale='en-US'] - a locale string to use when parsing. Will also set the DateTime to this locale
		* @param {string} opts.numberingSystem - the numbering system to use when parsing. Will also set the resulting DateTime to this numbering system
		* @param {string} opts.weekSettings - the week settings to set on the resulting DateTime instance
		* @param {string} opts.outputCalendar - the output calendar to set on the resulting DateTime instance
		* @return {DateTime}
		*/
		static fromFormat(text, fmt, opts = {}) {
			if (isUndefined(text) || isUndefined(fmt)) throw new InvalidArgumentError("fromFormat requires an input string and a format");
			const { locale = null, numberingSystem = null } = opts, [vals, parsedZone, specificOffset, invalid] = parseFromTokens(Locale.fromOpts({
				locale,
				numberingSystem,
				defaultToEN: true
			}), text, fmt);
			if (invalid) return DateTime.invalid(invalid);
			else return parseDataToDateTime(vals, parsedZone, opts, `format ${fmt}`, text, specificOffset);
		}
		/**
		* @deprecated use fromFormat instead
		*/
		static fromString(text, fmt, opts = {}) {
			return DateTime.fromFormat(text, fmt, opts);
		}
		/**
		* Create a DateTime from a SQL date, time, or datetime
		* Defaults to en-US if no locale has been specified, regardless of the system's locale
		* @param {string} text - the string to parse
		* @param {Object} opts - options to affect the creation
		* @param {string|Zone} [opts.zone='local'] - use this zone if no offset is specified in the input string itself. Will also convert the DateTime to this zone
		* @param {boolean} [opts.setZone=false] - override the zone with a zone specified in the string itself, if it specifies one
		* @param {string} [opts.locale='en-US'] - a locale string to use when parsing. Will also set the DateTime to this locale
		* @param {string} opts.numberingSystem - the numbering system to use when parsing. Will also set the resulting DateTime to this numbering system
		* @param {string} opts.weekSettings - the week settings to set on the resulting DateTime instance
		* @param {string} opts.outputCalendar - the output calendar to set on the resulting DateTime instance
		* @example DateTime.fromSQL('2017-05-15')
		* @example DateTime.fromSQL('2017-05-15 09:12:34')
		* @example DateTime.fromSQL('2017-05-15 09:12:34.342')
		* @example DateTime.fromSQL('2017-05-15 09:12:34.342+06:00')
		* @example DateTime.fromSQL('2017-05-15 09:12:34.342 America/Los_Angeles')
		* @example DateTime.fromSQL('2017-05-15 09:12:34.342 America/Los_Angeles', { setZone: true })
		* @example DateTime.fromSQL('2017-05-15 09:12:34.342', { zone: 'America/Los_Angeles' })
		* @example DateTime.fromSQL('09:12:34.342')
		* @return {DateTime}
		*/
		static fromSQL(text, opts = {}) {
			const [vals, parsedZone] = parseSQL(text);
			return parseDataToDateTime(vals, parsedZone, opts, "SQL", text);
		}
		/**
		* Create an invalid DateTime.
		* @param {string} reason - simple string of why this DateTime is invalid. Should not contain parameters or anything else data-dependent.
		* @param {string} [explanation=null] - longer explanation, may include parameters and other useful debugging information
		* @return {DateTime}
		*/
		static invalid(reason, explanation = null) {
			if (!reason) throw new InvalidArgumentError("need to specify a reason the DateTime is invalid");
			const invalid = reason instanceof Invalid ? reason : new Invalid(reason, explanation);
			if (Settings.throwOnInvalid) throw new InvalidDateTimeError(invalid);
			else return new DateTime({ invalid });
		}
		/**
		* Check if an object is an instance of DateTime. Works across context boundaries
		* @param {object} o
		* @return {boolean}
		*/
		static isDateTime(o) {
			return o && o.isLuxonDateTime || false;
		}
		/**
		* Produce the format string for a set of options
		* @param formatOpts
		* @param localeOpts
		* @returns {string}
		*/
		static parseFormatForOpts(formatOpts, localeOpts = {}) {
			const tokenList = formatOptsToTokens(formatOpts, Locale.fromObject(localeOpts));
			return !tokenList ? null : tokenList.map((t) => t ? t.val : null).join("");
		}
		/**
		* Produce the the fully expanded format token for the locale
		* Does NOT quote characters, so quoted tokens will not round trip correctly
		* @param fmt
		* @param localeOpts
		* @returns {string}
		*/
		static expandFormat(fmt, localeOpts = {}) {
			return expandMacroTokens(Formatter.parseFormat(fmt), Locale.fromObject(localeOpts)).map((t) => t.val).join("");
		}
		static resetCache() {
			zoneOffsetTs = void 0;
			zoneOffsetGuessCache.clear();
		}
		/**
		* Get the value of unit.
		* @param {string} unit - a unit such as 'minute' or 'day'
		* @example DateTime.local(2017, 7, 4).get('month'); //=> 7
		* @example DateTime.local(2017, 7, 4).get('day'); //=> 4
		* @return {number}
		*/
		get(unit) {
			return this[unit];
		}
		/**
		* Returns whether the DateTime is valid. Invalid DateTimes occur when:
		* * The DateTime was created from invalid calendar information, such as the 13th month or February 30
		* * The DateTime was created by an operation on another invalid date
		* @type {boolean}
		*/
		get isValid() {
			return this.invalid === null;
		}
		/**
		* Returns an error code if this DateTime is invalid, or null if the DateTime is valid
		* @type {string}
		*/
		get invalidReason() {
			return this.invalid ? this.invalid.reason : null;
		}
		/**
		* Returns an explanation of why this DateTime became invalid, or null if the DateTime is valid
		* @type {string}
		*/
		get invalidExplanation() {
			return this.invalid ? this.invalid.explanation : null;
		}
		/**
		* Get the locale of a DateTime, such 'en-GB'. The locale is used when formatting the DateTime
		*
		* @type {string}
		*/
		get locale() {
			return this.isValid ? this.loc.locale : null;
		}
		/**
		* Get the numbering system of a DateTime, such 'beng'. The numbering system is used when formatting the DateTime
		*
		* @type {string}
		*/
		get numberingSystem() {
			return this.isValid ? this.loc.numberingSystem : null;
		}
		/**
		* Get the output calendar of a DateTime, such 'islamic'. The output calendar is used when formatting the DateTime
		*
		* @type {string}
		*/
		get outputCalendar() {
			return this.isValid ? this.loc.outputCalendar : null;
		}
		/**
		* Get the time zone associated with this DateTime.
		* @type {Zone}
		*/
		get zone() {
			return this._zone;
		}
		/**
		* Get the name of the time zone.
		* @type {string}
		*/
		get zoneName() {
			return this.isValid ? this.zone.name : null;
		}
		/**
		* Get the year
		* @example DateTime.local(2017, 5, 25).year //=> 2017
		* @type {number}
		*/
		get year() {
			return this.isValid ? this.c.year : NaN;
		}
		/**
		* Get the quarter
		* @example DateTime.local(2017, 5, 25).quarter //=> 2
		* @type {number}
		*/
		get quarter() {
			return this.isValid ? Math.ceil(this.c.month / 3) : NaN;
		}
		/**
		* Get the month (1-12).
		* @example DateTime.local(2017, 5, 25).month //=> 5
		* @type {number}
		*/
		get month() {
			return this.isValid ? this.c.month : NaN;
		}
		/**
		* Get the day of the month (1-30ish).
		* @example DateTime.local(2017, 5, 25).day //=> 25
		* @type {number}
		*/
		get day() {
			return this.isValid ? this.c.day : NaN;
		}
		/**
		* Get the hour of the day (0-23).
		* @example DateTime.local(2017, 5, 25, 9).hour //=> 9
		* @type {number}
		*/
		get hour() {
			return this.isValid ? this.c.hour : NaN;
		}
		/**
		* Get the minute of the hour (0-59).
		* @example DateTime.local(2017, 5, 25, 9, 30).minute //=> 30
		* @type {number}
		*/
		get minute() {
			return this.isValid ? this.c.minute : NaN;
		}
		/**
		* Get the second of the minute (0-59).
		* @example DateTime.local(2017, 5, 25, 9, 30, 52).second //=> 52
		* @type {number}
		*/
		get second() {
			return this.isValid ? this.c.second : NaN;
		}
		/**
		* Get the millisecond of the second (0-999).
		* @example DateTime.local(2017, 5, 25, 9, 30, 52, 654).millisecond //=> 654
		* @type {number}
		*/
		get millisecond() {
			return this.isValid ? this.c.millisecond : NaN;
		}
		/**
		* Get the week year
		* @see https://en.wikipedia.org/wiki/ISO_week_date
		* @example DateTime.local(2014, 12, 31).weekYear //=> 2015
		* @type {number}
		*/
		get weekYear() {
			return this.isValid ? possiblyCachedWeekData(this).weekYear : NaN;
		}
		/**
		* Get the week number of the week year (1-52ish).
		* @see https://en.wikipedia.org/wiki/ISO_week_date
		* @example DateTime.local(2017, 5, 25).weekNumber //=> 21
		* @type {number}
		*/
		get weekNumber() {
			return this.isValid ? possiblyCachedWeekData(this).weekNumber : NaN;
		}
		/**
		* Get the day of the week.
		* 1 is Monday and 7 is Sunday
		* @see https://en.wikipedia.org/wiki/ISO_week_date
		* @example DateTime.local(2014, 11, 31).weekday //=> 4
		* @type {number}
		*/
		get weekday() {
			return this.isValid ? possiblyCachedWeekData(this).weekday : NaN;
		}
		/**
		* Returns true if this date is on a weekend according to the locale, false otherwise
		* @returns {boolean}
		*/
		get isWeekend() {
			return this.isValid && this.loc.getWeekendDays().includes(this.weekday);
		}
		/**
		* Get the day of the week according to the locale.
		* 1 is the first day of the week and 7 is the last day of the week.
		* If the locale assigns Sunday as the first day of the week, then a date which is a Sunday will return 1,
		* @returns {number}
		*/
		get localWeekday() {
			return this.isValid ? possiblyCachedLocalWeekData(this).weekday : NaN;
		}
		/**
		* Get the week number of the week year according to the locale. Different locales assign week numbers differently,
		* because the week can start on different days of the week (see localWeekday) and because a different number of days
		* is required for a week to count as the first week of a year.
		* @returns {number}
		*/
		get localWeekNumber() {
			return this.isValid ? possiblyCachedLocalWeekData(this).weekNumber : NaN;
		}
		/**
		* Get the week year according to the locale. Different locales assign week numbers (and therefor week years)
		* differently, see localWeekNumber.
		* @returns {number}
		*/
		get localWeekYear() {
			return this.isValid ? possiblyCachedLocalWeekData(this).weekYear : NaN;
		}
		/**
		* Get the ordinal (meaning the day of the year)
		* @example DateTime.local(2017, 5, 25).ordinal //=> 145
		* @type {number|DateTime}
		*/
		get ordinal() {
			return this.isValid ? gregorianToOrdinal(this.c).ordinal : NaN;
		}
		/**
		* Get the human readable short month name, such as 'Oct'.
		* Defaults to the system's locale if no locale has been specified
		* @example DateTime.local(2017, 10, 30).monthShort //=> Oct
		* @type {string}
		*/
		get monthShort() {
			return this.isValid ? Info.months("short", { locObj: this.loc })[this.month - 1] : null;
		}
		/**
		* Get the human readable long month name, such as 'October'.
		* Defaults to the system's locale if no locale has been specified
		* @example DateTime.local(2017, 10, 30).monthLong //=> October
		* @type {string}
		*/
		get monthLong() {
			return this.isValid ? Info.months("long", { locObj: this.loc })[this.month - 1] : null;
		}
		/**
		* Get the human readable short weekday, such as 'Mon'.
		* Defaults to the system's locale if no locale has been specified
		* @example DateTime.local(2017, 10, 30).weekdayShort //=> Mon
		* @type {string}
		*/
		get weekdayShort() {
			return this.isValid ? Info.weekdays("short", { locObj: this.loc })[this.weekday - 1] : null;
		}
		/**
		* Get the human readable long weekday, such as 'Monday'.
		* Defaults to the system's locale if no locale has been specified
		* @example DateTime.local(2017, 10, 30).weekdayLong //=> Monday
		* @type {string}
		*/
		get weekdayLong() {
			return this.isValid ? Info.weekdays("long", { locObj: this.loc })[this.weekday - 1] : null;
		}
		/**
		* Get the UTC offset of this DateTime in minutes
		* @example DateTime.now().offset //=> -240
		* @example DateTime.utc().offset //=> 0
		* @type {number}
		*/
		get offset() {
			return this.isValid ? +this.o : NaN;
		}
		/**
		* Get the short human name for the zone's current offset, for example "EST" or "EDT".
		* Defaults to the system's locale if no locale has been specified
		* @type {string}
		*/
		get offsetNameShort() {
			if (this.isValid) return this.zone.offsetName(this.ts, {
				format: "short",
				locale: this.locale
			});
			else return null;
		}
		/**
		* Get the long human name for the zone's current offset, for example "Eastern Standard Time" or "Eastern Daylight Time".
		* Defaults to the system's locale if no locale has been specified
		* @type {string}
		*/
		get offsetNameLong() {
			if (this.isValid) return this.zone.offsetName(this.ts, {
				format: "long",
				locale: this.locale
			});
			else return null;
		}
		/**
		* Get whether this zone's offset ever changes, as in a DST.
		* @type {boolean}
		*/
		get isOffsetFixed() {
			return this.isValid ? this.zone.isUniversal : null;
		}
		/**
		* Get whether the DateTime is in a DST.
		* @type {boolean}
		*/
		get isInDST() {
			if (this.isOffsetFixed) return false;
			else return this.offset > this.set({
				month: 1,
				day: 1
			}).offset || this.offset > this.set({ month: 5 }).offset;
		}
		/**
		* Get those DateTimes which have the same local time as this DateTime, but a different offset from UTC
		* in this DateTime's zone. During DST changes local time can be ambiguous, for example
		* `2023-10-29T02:30:00` in `Europe/Berlin` can have offset `+01:00` or `+02:00`.
		* This method will return both possible DateTimes if this DateTime's local time is ambiguous.
		* @returns {DateTime[]}
		*/
		getPossibleOffsets() {
			if (!this.isValid || this.isOffsetFixed) return [this];
			const dayMs = 864e5;
			const minuteMs = 6e4;
			const localTS = objToLocalTS(this.c);
			const oEarlier = this.zone.offset(localTS - dayMs);
			const oLater = this.zone.offset(localTS + dayMs);
			const o1 = this.zone.offset(localTS - oEarlier * minuteMs);
			const o2 = this.zone.offset(localTS - oLater * minuteMs);
			if (o1 === o2) return [this];
			const ts1 = localTS - o1 * minuteMs;
			const ts2 = localTS - o2 * minuteMs;
			const c1 = tsToObj(ts1, o1);
			const c2 = tsToObj(ts2, o2);
			if (c1.hour === c2.hour && c1.minute === c2.minute && c1.second === c2.second && c1.millisecond === c2.millisecond) return [clone(this, { ts: ts1 }), clone(this, { ts: ts2 })];
			return [this];
		}
		/**
		* Returns true if this DateTime is in a leap year, false otherwise
		* @example DateTime.local(2016).isInLeapYear //=> true
		* @example DateTime.local(2013).isInLeapYear //=> false
		* @type {boolean}
		*/
		get isInLeapYear() {
			return isLeapYear(this.year);
		}
		/**
		* Returns the number of days in this DateTime's month
		* @example DateTime.local(2016, 2).daysInMonth //=> 29
		* @example DateTime.local(2016, 3).daysInMonth //=> 31
		* @type {number}
		*/
		get daysInMonth() {
			return daysInMonth(this.year, this.month);
		}
		/**
		* Returns the number of days in this DateTime's year
		* @example DateTime.local(2016).daysInYear //=> 366
		* @example DateTime.local(2013).daysInYear //=> 365
		* @type {number}
		*/
		get daysInYear() {
			return this.isValid ? daysInYear(this.year) : NaN;
		}
		/**
		* Returns the number of weeks in this DateTime's year
		* @see https://en.wikipedia.org/wiki/ISO_week_date
		* @example DateTime.local(2004).weeksInWeekYear //=> 53
		* @example DateTime.local(2013).weeksInWeekYear //=> 52
		* @type {number}
		*/
		get weeksInWeekYear() {
			return this.isValid ? weeksInWeekYear(this.weekYear) : NaN;
		}
		/**
		* Returns the number of weeks in this DateTime's local week year
		* @example DateTime.local(2020, 6, {locale: 'en-US'}).weeksInLocalWeekYear //=> 52
		* @example DateTime.local(2020, 6, {locale: 'de-DE'}).weeksInLocalWeekYear //=> 53
		* @type {number}
		*/
		get weeksInLocalWeekYear() {
			return this.isValid ? weeksInWeekYear(this.localWeekYear, this.loc.getMinDaysInFirstWeek(), this.loc.getStartOfWeek()) : NaN;
		}
		/**
		* Returns the resolved Intl options for this DateTime.
		* This is useful in understanding the behavior of formatting methods
		* @param {Object} opts - the same options as toLocaleString
		* @return {Object}
		*/
		resolvedLocaleOptions(opts = {}) {
			const { locale, numberingSystem, calendar } = Formatter.create(this.loc.clone(opts), opts).resolvedOptions(this);
			return {
				locale,
				numberingSystem,
				outputCalendar: calendar
			};
		}
		/**
		* "Set" the DateTime's zone to UTC. Returns a newly-constructed DateTime.
		*
		* Equivalent to {@link DateTime#setZone}('utc')
		* @param {number} [offset=0] - optionally, an offset from UTC in minutes
		* @param {Object} [opts={}] - options to pass to `setZone()`
		* @return {DateTime}
		*/
		toUTC(offset = 0, opts = {}) {
			return this.setZone(FixedOffsetZone.instance(offset), opts);
		}
		/**
		* "Set" the DateTime's zone to the host's local zone. Returns a newly-constructed DateTime.
		*
		* Equivalent to `setZone('local')`
		* @return {DateTime}
		*/
		toLocal() {
			return this.setZone(Settings.defaultZone);
		}
		/**
		* "Set" the DateTime's zone to specified zone. Returns a newly-constructed DateTime.
		*
		* By default, the setter keeps the underlying time the same (as in, the same timestamp), but the new instance will report different local times and consider DSTs when making computations, as with {@link DateTime#plus}. You may wish to use {@link DateTime#toLocal} and {@link DateTime#toUTC} which provide simple convenience wrappers for commonly used zones.
		* @param {string|Zone} [zone='local'] - a zone identifier. As a string, that can be any IANA zone supported by the host environment, or a fixed-offset name of the form 'UTC+3', or the strings 'local' or 'utc'. You may also supply an instance of a {@link DateTime#Zone} class.
		* @param {Object} opts - options
		* @param {boolean} [opts.keepLocalTime=false] - If true, adjust the underlying time so that the local time stays the same, but in the target zone. You should rarely need this.
		* @return {DateTime}
		*/
		setZone(zone, { keepLocalTime = false, keepCalendarTime = false } = {}) {
			zone = normalizeZone(zone, Settings.defaultZone);
			if (zone.equals(this.zone)) return this;
			else if (!zone.isValid) return DateTime.invalid(unsupportedZone(zone));
			else {
				let newTS = this.ts;
				if (keepLocalTime || keepCalendarTime) {
					const offsetGuess = zone.offset(this.ts);
					const asObj = this.toObject();
					[newTS] = objToTS(asObj, offsetGuess, zone);
				}
				return clone(this, {
					ts: newTS,
					zone
				});
			}
		}
		/**
		* "Set" the locale, numberingSystem, or outputCalendar. Returns a newly-constructed DateTime.
		* @param {Object} properties - the properties to set
		* @example DateTime.local(2017, 5, 25).reconfigure({ locale: 'en-GB' })
		* @return {DateTime}
		*/
		reconfigure({ locale, numberingSystem, outputCalendar } = {}) {
			const loc = this.loc.clone({
				locale,
				numberingSystem,
				outputCalendar
			});
			return clone(this, { loc });
		}
		/**
		* "Set" the locale. Returns a newly-constructed DateTime.
		* Just a convenient alias for reconfigure({ locale })
		* @example DateTime.local(2017, 5, 25).setLocale('en-GB')
		* @return {DateTime}
		*/
		setLocale(locale) {
			return this.reconfigure({ locale });
		}
		/**
		* "Set" the values of specified units. Returns a newly-constructed DateTime.
		* You can only set units with this method; for "setting" metadata, see {@link DateTime#reconfigure} and {@link DateTime#setZone}.
		*
		* This method also supports setting locale-based week units, i.e. `localWeekday`, `localWeekNumber` and `localWeekYear`.
		* They cannot be mixed with ISO-week units like `weekday`.
		* @param {Object} values - a mapping of units to numbers
		* @example dt.set({ year: 2017 })
		* @example dt.set({ hour: 8, minute: 30 })
		* @example dt.set({ weekday: 5 })
		* @example dt.set({ year: 2005, ordinal: 234 })
		* @return {DateTime}
		*/
		set(values) {
			if (!this.isValid) return this;
			const normalized = normalizeObject(values, normalizeUnitWithLocalWeeks);
			const { minDaysInFirstWeek, startOfWeek } = usesLocalWeekValues(normalized, this.loc);
			const settingWeekStuff = !isUndefined(normalized.weekYear) || !isUndefined(normalized.weekNumber) || !isUndefined(normalized.weekday), containsOrdinal = !isUndefined(normalized.ordinal), containsGregorYear = !isUndefined(normalized.year), containsGregorMD = !isUndefined(normalized.month) || !isUndefined(normalized.day), containsGregor = containsGregorYear || containsGregorMD, definiteWeekDef = normalized.weekYear || normalized.weekNumber;
			if ((containsGregor || containsOrdinal) && definiteWeekDef) throw new ConflictingSpecificationError("Can't mix weekYear/weekNumber units with year/month/day or ordinals");
			if (containsGregorMD && containsOrdinal) throw new ConflictingSpecificationError("Can't mix ordinal dates with month/day");
			let mixed;
			if (settingWeekStuff) mixed = weekToGregorian({
				...gregorianToWeek(this.c, minDaysInFirstWeek, startOfWeek),
				...normalized
			}, minDaysInFirstWeek, startOfWeek);
			else if (!isUndefined(normalized.ordinal)) mixed = ordinalToGregorian({
				...gregorianToOrdinal(this.c),
				...normalized
			});
			else {
				mixed = {
					...this.toObject(),
					...normalized
				};
				if (isUndefined(normalized.day)) mixed.day = Math.min(daysInMonth(mixed.year, mixed.month), mixed.day);
			}
			const [ts, o] = objToTS(mixed, this.o, this.zone);
			return clone(this, {
				ts,
				o
			});
		}
		/**
		* Add a period of time to this DateTime and return the resulting DateTime
		*
		* Adding hours, minutes, seconds, or milliseconds increases the timestamp by the right number of milliseconds. Adding days, months, or years shifts the calendar, accounting for DSTs and leap years along the way. Thus, `dt.plus({ hours: 24 })` may result in a different time than `dt.plus({ days: 1 })` if there's a DST shift in between.
		* @param {Duration|Object|number} duration - The amount to add. Either a Luxon Duration, a number of milliseconds, the object argument to Duration.fromObject()
		* @example DateTime.now().plus(123) //~> in 123 milliseconds
		* @example DateTime.now().plus({ minutes: 15 }) //~> in 15 minutes
		* @example DateTime.now().plus({ days: 1 }) //~> this time tomorrow
		* @example DateTime.now().plus({ days: -1 }) //~> this time yesterday
		* @example DateTime.now().plus({ hours: 3, minutes: 13 }) //~> in 3 hr, 13 min
		* @example DateTime.now().plus(Duration.fromObject({ hours: 3, minutes: 13 })) //~> in 3 hr, 13 min
		* @return {DateTime}
		*/
		plus(duration) {
			if (!this.isValid) return this;
			const dur = Duration.fromDurationLike(duration);
			return clone(this, adjustTime(this, dur));
		}
		/**
		* Subtract a period of time to this DateTime and return the resulting DateTime
		* See {@link DateTime#plus}
		* @param {Duration|Object|number} duration - The amount to subtract. Either a Luxon Duration, a number of milliseconds, the object argument to Duration.fromObject()
		@return {DateTime}
		*/
		minus(duration) {
			if (!this.isValid) return this;
			const dur = Duration.fromDurationLike(duration).negate();
			return clone(this, adjustTime(this, dur));
		}
		/**
		* "Set" this DateTime to the beginning of a unit of time.
		* @param {string} unit - The unit to go to the beginning of. Can be 'year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', or 'millisecond'.
		* @param {Object} opts - options
		* @param {boolean} [opts.useLocaleWeeks=false] - If true, use weeks based on the locale, i.e. use the locale-dependent start of the week
		* @example DateTime.local(2014, 3, 3).startOf('month').toISODate(); //=> '2014-03-01'
		* @example DateTime.local(2014, 3, 3).startOf('year').toISODate(); //=> '2014-01-01'
		* @example DateTime.local(2014, 3, 3).startOf('week').toISODate(); //=> '2014-03-03', weeks always start on Mondays
		* @example DateTime.local(2014, 3, 3, 5, 30).startOf('day').toISOTime(); //=> '00:00.000-05:00'
		* @example DateTime.local(2014, 3, 3, 5, 30).startOf('hour').toISOTime(); //=> '05:00:00.000-05:00'
		* @return {DateTime}
		*/
		startOf(unit, { useLocaleWeeks = false } = {}) {
			if (!this.isValid) return this;
			const o = {}, normalizedUnit = Duration.normalizeUnit(unit);
			switch (normalizedUnit) {
				case "years": o.month = 1;
				case "quarters":
				case "months": o.day = 1;
				case "weeks":
				case "days": o.hour = 0;
				case "hours": o.minute = 0;
				case "minutes": o.second = 0;
				case "seconds":
					o.millisecond = 0;
					break;
			}
			if (normalizedUnit === "weeks") if (useLocaleWeeks) {
				const startOfWeek = this.loc.getStartOfWeek();
				const { weekday } = this;
				if (weekday < startOfWeek) o.weekNumber = this.weekNumber - 1;
				o.weekday = startOfWeek;
			} else o.weekday = 1;
			if (normalizedUnit === "quarters") o.month = (Math.ceil(this.month / 3) - 1) * 3 + 1;
			return this.set(o);
		}
		/**
		* "Set" this DateTime to the end (meaning the last millisecond) of a unit of time
		* @param {string} unit - The unit to go to the end of. Can be 'year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', or 'millisecond'.
		* @param {Object} opts - options
		* @param {boolean} [opts.useLocaleWeeks=false] - If true, use weeks based on the locale, i.e. use the locale-dependent start of the week
		* @example DateTime.local(2014, 3, 3).endOf('month').toISO(); //=> '2014-03-31T23:59:59.999-05:00'
		* @example DateTime.local(2014, 3, 3).endOf('year').toISO(); //=> '2014-12-31T23:59:59.999-05:00'
		* @example DateTime.local(2014, 3, 3).endOf('week').toISO(); // => '2014-03-09T23:59:59.999-05:00', weeks start on Mondays
		* @example DateTime.local(2014, 3, 3, 5, 30).endOf('day').toISO(); //=> '2014-03-03T23:59:59.999-05:00'
		* @example DateTime.local(2014, 3, 3, 5, 30).endOf('hour').toISO(); //=> '2014-03-03T05:59:59.999-05:00'
		* @return {DateTime}
		*/
		endOf(unit, opts) {
			return this.isValid ? this.plus({ [unit]: 1 }).startOf(unit, opts).minus(1) : this;
		}
		/**
		* Returns a string representation of this DateTime formatted according to the specified format string.
		* **You may not want this.** See {@link DateTime#toLocaleString} for a more flexible formatting tool. For a table of tokens and their interpretations, see [here](https://moment.github.io/luxon/#/formatting?id=table-of-tokens).
		* Defaults to en-US if no locale has been specified, regardless of the system's locale.
		* @param {string} fmt - the format string
		* @param {Object} opts - opts to override the configuration options on this DateTime
		* @example DateTime.now().toFormat('yyyy LLL dd') //=> '2017 Apr 22'
		* @example DateTime.now().setLocale('fr').toFormat('yyyy LLL dd') //=> '2017 avr. 22'
		* @example DateTime.now().toFormat('yyyy LLL dd', { locale: "fr" }) //=> '2017 avr. 22'
		* @example DateTime.now().toFormat("HH 'hours and' mm 'minutes'") //=> '20 hours and 55 minutes'
		* @return {string}
		*/
		toFormat(fmt, opts = {}) {
			return this.isValid ? Formatter.create(this.loc.redefaultToEN(opts)).formatDateTimeFromString(this, fmt) : INVALID;
		}
		/**
		* Returns a localized string representing this date. Accepts the same options as the Intl.DateTimeFormat constructor and any presets defined by Luxon, such as `DateTime.DATE_FULL` or `DateTime.TIME_SIMPLE`.
		* The exact behavior of this method is browser-specific, but in general it will return an appropriate representation
		* of the DateTime in the assigned locale.
		* Defaults to the system's locale if no locale has been specified
		* @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat
		* @param formatOpts {Object} - Intl.DateTimeFormat constructor options and configuration options
		* @param {Object} opts - opts to override the configuration options on this DateTime
		* @example DateTime.now().toLocaleString(); //=> 4/20/2017
		* @example DateTime.now().setLocale('en-gb').toLocaleString(); //=> '20/04/2017'
		* @example DateTime.now().toLocaleString(DateTime.DATE_FULL); //=> 'April 20, 2017'
		* @example DateTime.now().toLocaleString(DateTime.DATE_FULL, { locale: 'fr' }); //=> '28 août 2022'
		* @example DateTime.now().toLocaleString(DateTime.TIME_SIMPLE); //=> '11:32 AM'
		* @example DateTime.now().toLocaleString(DateTime.DATETIME_SHORT); //=> '4/20/2017, 11:32 AM'
		* @example DateTime.now().toLocaleString({ weekday: 'long', month: 'long', day: '2-digit' }); //=> 'Thursday, April 20'
		* @example DateTime.now().toLocaleString({ weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); //=> 'Thu, Apr 20, 11:27 AM'
		* @example DateTime.now().toLocaleString({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); //=> '11:32'
		* @return {string}
		*/
		toLocaleString(formatOpts = DATE_SHORT, opts = {}) {
			return this.isValid ? Formatter.create(this.loc.clone(opts), formatOpts).formatDateTime(this) : INVALID;
		}
		/**
		* Returns an array of format "parts", meaning individual tokens along with metadata. This is allows callers to post-process individual sections of the formatted output.
		* Defaults to the system's locale if no locale has been specified
		* @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat/formatToParts
		* @param opts {Object} - Intl.DateTimeFormat constructor options, same as `toLocaleString`.
		* @example DateTime.now().toLocaleParts(); //=> [
		*                                   //=>   { type: 'day', value: '25' },
		*                                   //=>   { type: 'literal', value: '/' },
		*                                   //=>   { type: 'month', value: '05' },
		*                                   //=>   { type: 'literal', value: '/' },
		*                                   //=>   { type: 'year', value: '1982' }
		*                                   //=> ]
		*/
		toLocaleParts(opts = {}) {
			return this.isValid ? Formatter.create(this.loc.clone(opts), opts).formatDateTimeParts(this) : [];
		}
		/**
		* Returns an ISO 8601-compliant string representation of this DateTime
		* @param {Object} opts - options
		* @param {boolean} [opts.suppressMilliseconds=false] - exclude milliseconds from the format if they're 0
		* @param {boolean} [opts.suppressSeconds=false] - exclude seconds from the format if they're 0
		* @param {boolean} [opts.includeOffset=true] - include the offset, such as 'Z' or '-04:00'
		* @param {boolean} [opts.extendedZone=false] - add the time zone format extension
		* @param {string} [opts.format='extended'] - choose between the basic and extended format
		* @param {string} [opts.precision='milliseconds'] - truncate output to desired presicion: 'years', 'months', 'days', 'hours', 'minutes', 'seconds' or 'milliseconds'. When precision and suppressSeconds or suppressMilliseconds are used together, precision sets the maximum unit shown in the output, however seconds or milliseconds will still be suppressed if they are 0.
		* @example DateTime.utc(1983, 5, 25).toISO() //=> '1982-05-25T00:00:00.000Z'
		* @example DateTime.now().toISO() //=> '2017-04-22T20:47:05.335-04:00'
		* @example DateTime.now().toISO({ includeOffset: false }) //=> '2017-04-22T20:47:05.335'
		* @example DateTime.now().toISO({ format: 'basic' }) //=> '20170422T204705.335-0400'
		* @example DateTime.now().toISO({ precision: 'day' }) //=> '2017-04-22Z'
		* @example DateTime.now().toISO({ precision: 'minute' }) //=> '2017-04-22T20:47Z'
		* @return {string|null}
		*/
		toISO({ format = "extended", suppressSeconds = false, suppressMilliseconds = false, includeOffset = true, extendedZone = false, precision = "milliseconds" } = {}) {
			if (!this.isValid) return null;
			precision = normalizeUnit(precision);
			const ext = format === "extended";
			let c = toISODate(this, ext, precision);
			if (orderedUnits.indexOf(precision) >= 3) c += "T";
			c += toISOTime(this, ext, suppressSeconds, suppressMilliseconds, includeOffset, extendedZone, precision);
			return c;
		}
		/**
		* Returns an ISO 8601-compliant string representation of this DateTime's date component
		* @param {Object} opts - options
		* @param {string} [opts.format='extended'] - choose between the basic and extended format
		* @param {string} [opts.precision='day'] - truncate output to desired precision: 'years', 'months', or 'days'.
		* @example DateTime.utc(1982, 5, 25).toISODate() //=> '1982-05-25'
		* @example DateTime.utc(1982, 5, 25).toISODate({ format: 'basic' }) //=> '19820525'
		* @example DateTime.utc(1982, 5, 25).toISODate({ precision: 'month' }) //=> '1982-05'
		* @return {string|null}
		*/
		toISODate({ format = "extended", precision = "day" } = {}) {
			if (!this.isValid) return null;
			return toISODate(this, format === "extended", normalizeUnit(precision));
		}
		/**
		* Returns an ISO 8601-compliant string representation of this DateTime's week date
		* @example DateTime.utc(1982, 5, 25).toISOWeekDate() //=> '1982-W21-2'
		* @return {string}
		*/
		toISOWeekDate() {
			return toTechFormat(this, "kkkk-'W'WW-c");
		}
		/**
		* Returns an ISO 8601-compliant string representation of this DateTime's time component
		* @param {Object} opts - options
		* @param {boolean} [opts.suppressMilliseconds=false] - exclude milliseconds from the format if they're 0
		* @param {boolean} [opts.suppressSeconds=false] - exclude seconds from the format if they're 0
		* @param {boolean} [opts.includeOffset=true] - include the offset, such as 'Z' or '-04:00'
		* @param {boolean} [opts.extendedZone=true] - add the time zone format extension
		* @param {boolean} [opts.includePrefix=false] - include the `T` prefix
		* @param {string} [opts.format='extended'] - choose between the basic and extended format
		* @param {string} [opts.precision='milliseconds'] - truncate output to desired presicion: 'hours', 'minutes', 'seconds' or 'milliseconds'. When precision and suppressSeconds or suppressMilliseconds are used together, precision sets the maximum unit shown in the output, however seconds or milliseconds will still be suppressed if they are 0.
		* @example DateTime.utc().set({ hour: 7, minute: 34 }).toISOTime() //=> '07:34:19.361Z'
		* @example DateTime.utc().set({ hour: 7, minute: 34, seconds: 0, milliseconds: 0 }).toISOTime({ suppressSeconds: true }) //=> '07:34Z'
		* @example DateTime.utc().set({ hour: 7, minute: 34 }).toISOTime({ format: 'basic' }) //=> '073419.361Z'
		* @example DateTime.utc().set({ hour: 7, minute: 34 }).toISOTime({ includePrefix: true }) //=> 'T07:34:19.361Z'
		* @example DateTime.utc().set({ hour: 7, minute: 34, second: 56 }).toISOTime({ precision: 'minute' }) //=> '07:34Z'
		* @return {string}
		*/
		toISOTime({ suppressMilliseconds = false, suppressSeconds = false, includeOffset = true, includePrefix = false, extendedZone = false, format = "extended", precision = "milliseconds" } = {}) {
			if (!this.isValid) return null;
			precision = normalizeUnit(precision);
			return (includePrefix && orderedUnits.indexOf(precision) >= 3 ? "T" : "") + toISOTime(this, format === "extended", suppressSeconds, suppressMilliseconds, includeOffset, extendedZone, precision);
		}
		/**
		* Returns an RFC 2822-compatible string representation of this DateTime
		* @example DateTime.utc(2014, 7, 13).toRFC2822() //=> 'Sun, 13 Jul 2014 00:00:00 +0000'
		* @example DateTime.local(2014, 7, 13).toRFC2822() //=> 'Sun, 13 Jul 2014 00:00:00 -0400'
		* @return {string}
		*/
		toRFC2822() {
			return toTechFormat(this, "EEE, dd LLL yyyy HH:mm:ss ZZZ", false);
		}
		/**
		* Returns a string representation of this DateTime appropriate for use in HTTP headers. The output is always expressed in GMT.
		* Specifically, the string conforms to RFC 1123.
		* @see https://www.w3.org/Protocols/rfc2616/rfc2616-sec3.html#sec3.3.1
		* @example DateTime.utc(2014, 7, 13).toHTTP() //=> 'Sun, 13 Jul 2014 00:00:00 GMT'
		* @example DateTime.utc(2014, 7, 13, 19).toHTTP() //=> 'Sun, 13 Jul 2014 19:00:00 GMT'
		* @return {string}
		*/
		toHTTP() {
			return toTechFormat(this.toUTC(), "EEE, dd LLL yyyy HH:mm:ss 'GMT'");
		}
		/**
		* Returns a string representation of this DateTime appropriate for use in SQL Date
		* @example DateTime.utc(2014, 7, 13).toSQLDate() //=> '2014-07-13'
		* @return {string|null}
		*/
		toSQLDate() {
			if (!this.isValid) return null;
			return toISODate(this, true);
		}
		/**
		* Returns a string representation of this DateTime appropriate for use in SQL Time
		* @param {Object} opts - options
		* @param {boolean} [opts.includeZone=false] - include the zone, such as 'America/New_York'. Overrides includeOffset.
		* @param {boolean} [opts.includeOffset=true] - include the offset, such as 'Z' or '-04:00'
		* @param {boolean} [opts.includeOffsetSpace=true] - include the space between the time and the offset, such as '05:15:16.345 -04:00'
		* @example DateTime.utc().toSQL() //=> '05:15:16.345'
		* @example DateTime.now().toSQL() //=> '05:15:16.345 -04:00'
		* @example DateTime.now().toSQL({ includeOffset: false }) //=> '05:15:16.345'
		* @example DateTime.now().toSQL({ includeZone: false }) //=> '05:15:16.345 America/New_York'
		* @return {string}
		*/
		toSQLTime({ includeOffset = true, includeZone = false, includeOffsetSpace = true } = {}) {
			let fmt = "HH:mm:ss.SSS";
			if (includeZone || includeOffset) {
				if (includeOffsetSpace) fmt += " ";
				if (includeZone) fmt += "z";
				else if (includeOffset) fmt += "ZZ";
			}
			return toTechFormat(this, fmt, true);
		}
		/**
		* Returns a string representation of this DateTime appropriate for use in SQL DateTime
		* @param {Object} opts - options
		* @param {boolean} [opts.includeZone=false] - include the zone, such as 'America/New_York'. Overrides includeOffset.
		* @param {boolean} [opts.includeOffset=true] - include the offset, such as 'Z' or '-04:00'
		* @param {boolean} [opts.includeOffsetSpace=true] - include the space between the time and the offset, such as '05:15:16.345 -04:00'
		* @example DateTime.utc(2014, 7, 13).toSQL() //=> '2014-07-13 00:00:00.000 Z'
		* @example DateTime.local(2014, 7, 13).toSQL() //=> '2014-07-13 00:00:00.000 -04:00'
		* @example DateTime.local(2014, 7, 13).toSQL({ includeOffset: false }) //=> '2014-07-13 00:00:00.000'
		* @example DateTime.local(2014, 7, 13).toSQL({ includeZone: true }) //=> '2014-07-13 00:00:00.000 America/New_York'
		* @return {string}
		*/
		toSQL(opts = {}) {
			if (!this.isValid) return null;
			return `${this.toSQLDate()} ${this.toSQLTime(opts)}`;
		}
		/**
		* Returns a string representation of this DateTime appropriate for debugging
		* @return {string}
		*/
		toString() {
			return this.isValid ? this.toISO() : INVALID;
		}
		/**
		* Returns a string representation of this DateTime appropriate for the REPL.
		* @return {string}
		*/
		[Symbol.for("nodejs.util.inspect.custom")]() {
			if (this.isValid) return `DateTime { ts: ${this.toISO()}, zone: ${this.zone.name}, locale: ${this.locale} }`;
			else return `DateTime { Invalid, reason: ${this.invalidReason} }`;
		}
		/**
		* Returns the epoch milliseconds of this DateTime. Alias of {@link DateTime#toMillis}
		* @return {number}
		*/
		valueOf() {
			return this.toMillis();
		}
		/**
		* Returns the epoch milliseconds of this DateTime.
		* @return {number}
		*/
		toMillis() {
			return this.isValid ? this.ts : NaN;
		}
		/**
		* Returns the epoch seconds (including milliseconds in the fractional part) of this DateTime.
		* @return {number}
		*/
		toSeconds() {
			return this.isValid ? this.ts / 1e3 : NaN;
		}
		/**
		* Returns the epoch seconds (as a whole number) of this DateTime.
		* @return {number}
		*/
		toUnixInteger() {
			return this.isValid ? Math.floor(this.ts / 1e3) : NaN;
		}
		/**
		* Returns an ISO 8601 representation of this DateTime appropriate for use in JSON.
		* @return {string}
		*/
		toJSON() {
			return this.toISO();
		}
		/**
		* Returns a BSON serializable equivalent to this DateTime.
		* @return {Date}
		*/
		toBSON() {
			return this.toJSDate();
		}
		/**
		* Returns a JavaScript object with this DateTime's year, month, day, and so on.
		* @param opts - options for generating the object
		* @param {boolean} [opts.includeConfig=false] - include configuration attributes in the output
		* @example DateTime.now().toObject() //=> { year: 2017, month: 4, day: 22, hour: 20, minute: 49, second: 42, millisecond: 268 }
		* @return {Object}
		*/
		toObject(opts = {}) {
			if (!this.isValid) return {};
			const base = { ...this.c };
			if (opts.includeConfig) {
				base.outputCalendar = this.outputCalendar;
				base.numberingSystem = this.loc.numberingSystem;
				base.locale = this.loc.locale;
			}
			return base;
		}
		/**
		* Returns a JavaScript Date equivalent to this DateTime.
		* @return {Date}
		*/
		toJSDate() {
			return new Date(this.isValid ? this.ts : NaN);
		}
		/**
		* Return the difference between two DateTimes as a Duration.
		* @param {DateTime} otherDateTime - the DateTime to compare this one to
		* @param {string|string[]} [unit=['milliseconds']] - the unit or array of units (such as 'hours' or 'days') to include in the duration.
		* @param {Object} opts - options that affect the creation of the Duration
		* @param {string} [opts.conversionAccuracy='casual'] - the conversion system to use
		* @example
		* var i1 = DateTime.fromISO('1982-05-25T09:45'),
		*     i2 = DateTime.fromISO('1983-10-14T10:30');
		* i2.diff(i1).toObject() //=> { milliseconds: 43807500000 }
		* i2.diff(i1, 'hours').toObject() //=> { hours: 12168.75 }
		* i2.diff(i1, ['months', 'days']).toObject() //=> { months: 16, days: 19.03125 }
		* i2.diff(i1, ['months', 'days', 'hours']).toObject() //=> { months: 16, days: 19, hours: 0.75 }
		* @return {Duration}
		*/
		diff(otherDateTime, unit = "milliseconds", opts = {}) {
			if (!this.isValid || !otherDateTime.isValid) return Duration.invalid("created by diffing an invalid DateTime");
			const durOpts = {
				locale: this.locale,
				numberingSystem: this.numberingSystem,
				...opts
			};
			const units = maybeArray(unit).map(Duration.normalizeUnit), otherIsLater = otherDateTime.valueOf() > this.valueOf(), diffed = diff(otherIsLater ? this : otherDateTime, otherIsLater ? otherDateTime : this, units, durOpts);
			return otherIsLater ? diffed.negate() : diffed;
		}
		/**
		* Return the difference between this DateTime and right now.
		* See {@link DateTime#diff}
		* @param {string|string[]} [unit=['milliseconds']] - the unit or units units (such as 'hours' or 'days') to include in the duration
		* @param {Object} opts - options that affect the creation of the Duration
		* @param {string} [opts.conversionAccuracy='casual'] - the conversion system to use
		* @return {Duration}
		*/
		diffNow(unit = "milliseconds", opts = {}) {
			return this.diff(DateTime.now(), unit, opts);
		}
		/**
		* Return an Interval spanning between this DateTime and another DateTime
		* @param {DateTime} otherDateTime - the other end point of the Interval
		* @return {Interval|DateTime}
		*/
		until(otherDateTime) {
			return this.isValid ? Interval.fromDateTimes(this, otherDateTime) : this;
		}
		/**
		* Return whether this DateTime is in the same unit of time as another DateTime.
		* Higher-order units must also be identical for this function to return `true`.
		* Note that time zones are **ignored** in this comparison, which compares the **local** calendar time. Use {@link DateTime#setZone} to convert one of the dates if needed.
		* @param {DateTime} otherDateTime - the other DateTime
		* @param {string} unit - the unit of time to check sameness on
		* @param {Object} opts - options
		* @param {boolean} [opts.useLocaleWeeks=false] - If true, use weeks based on the locale, i.e. use the locale-dependent start of the week; only the locale of this DateTime is used
		* @example DateTime.now().hasSame(otherDT, 'day'); //~> true if otherDT is in the same current calendar day
		* @return {boolean}
		*/
		hasSame(otherDateTime, unit, opts) {
			if (!this.isValid) return false;
			const inputMs = otherDateTime.valueOf();
			const adjustedToZone = this.setZone(otherDateTime.zone, { keepLocalTime: true });
			return adjustedToZone.startOf(unit, opts) <= inputMs && inputMs <= adjustedToZone.endOf(unit, opts);
		}
		/**
		* Equality check
		* Two DateTimes are equal if and only if they represent the same millisecond, have the same zone and location, and are both valid.
		* To compare just the millisecond values, use `+dt1 === +dt2`.
		* @param {DateTime} other - the other DateTime
		* @return {boolean}
		*/
		equals(other) {
			return this.isValid && other.isValid && this.valueOf() === other.valueOf() && this.zone.equals(other.zone) && this.loc.equals(other.loc);
		}
		/**
		* Returns a string representation of a this time relative to now, such as "in two days". Can only internationalize if your
		* platform supports Intl.RelativeTimeFormat. Rounds towards zero by default.
		* @param {Object} options - options that affect the output
		* @param {DateTime} [options.base=DateTime.now()] - the DateTime to use as the basis to which this time is compared. Defaults to now.
		* @param {string} [options.style="long"] - the style of units, must be "long", "short", or "narrow"
		* @param {string|string[]} options.unit - use a specific unit or array of units; if omitted, or an array, the method will pick the best unit. Use an array or one of "years", "quarters", "months", "weeks", "days", "hours", "minutes", or "seconds"
		* @param {boolean} [options.round=true] - whether to round the numbers in the output.
		* @param {string} [options.rounding="trunc"] - rounding method to use when rounding the numbers in the output. Can be "trunc" (toward zero), "expand" (away from zero), "round", "floor", or "ceil".
		* @param {number} [options.padding=0] - padding in milliseconds. This allows you to round up the result if it fits inside the threshold. Don't use in combination with {round: false} because the decimal output will include the padding.
		* @param {string} options.locale - override the locale of this DateTime
		* @param {string} options.numberingSystem - override the numberingSystem of this DateTime. The Intl system may choose not to honor this
		* @example DateTime.now().plus({ days: 1 }).toRelative() //=> "in 1 day"
		* @example DateTime.now().setLocale("es").toRelative({ days: 1 }) //=> "dentro de 1 día"
		* @example DateTime.now().plus({ days: 1 }).toRelative({ locale: "fr" }) //=> "dans 23 heures"
		* @example DateTime.now().minus({ days: 2 }).toRelative() //=> "2 days ago"
		* @example DateTime.now().minus({ days: 2 }).toRelative({ unit: "hours" }) //=> "48 hours ago"
		* @example DateTime.now().minus({ hours: 36 }).toRelative({ round: false }) //=> "1.5 days ago"
		*/
		toRelative(options = {}) {
			if (!this.isValid) return null;
			const base = options.base || DateTime.fromObject({}, { zone: this.zone }), padding = options.padding ? this < base ? -options.padding : options.padding : 0;
			let units = [
				"years",
				"months",
				"days",
				"hours",
				"minutes",
				"seconds"
			];
			let unit = options.unit;
			if (Array.isArray(options.unit)) {
				units = options.unit;
				unit = void 0;
			}
			return diffRelative(base, this.plus(padding), {
				...options,
				numeric: "always",
				units,
				unit
			});
		}
		/**
		* Returns a string representation of this date relative to today, such as "yesterday" or "next month".
		* Only internationalizes on platforms that supports Intl.RelativeTimeFormat.
		* @param {Object} options - options that affect the output
		* @param {DateTime} [options.base=DateTime.now()] - the DateTime to use as the basis to which this time is compared. Defaults to now.
		* @param {string} options.locale - override the locale of this DateTime
		* @param {string} options.unit - use a specific unit; if omitted, the method will pick the unit. Use one of "years", "quarters", "months", "weeks", or "days"
		* @param {string} options.numberingSystem - override the numberingSystem of this DateTime. The Intl system may choose not to honor this
		* @example DateTime.now().plus({ days: 1 }).toRelativeCalendar() //=> "tomorrow"
		* @example DateTime.now().setLocale("es").plus({ days: 1 }).toRelative() //=> ""mañana"
		* @example DateTime.now().plus({ days: 1 }).toRelativeCalendar({ locale: "fr" }) //=> "demain"
		* @example DateTime.now().minus({ days: 2 }).toRelativeCalendar() //=> "2 days ago"
		*/
		toRelativeCalendar(options = {}) {
			if (!this.isValid) return null;
			return diffRelative(options.base || DateTime.fromObject({}, { zone: this.zone }), this, {
				...options,
				numeric: "auto",
				units: [
					"years",
					"months",
					"days"
				],
				calendary: true
			});
		}
		/**
		* Return the min of several date times
		* @param {...DateTime} dateTimes - the DateTimes from which to choose the minimum
		* @return {DateTime} the min DateTime, or undefined if called with no argument
		*/
		static min(...dateTimes) {
			if (!dateTimes.every(DateTime.isDateTime)) throw new InvalidArgumentError("min requires all arguments be DateTimes");
			return bestBy(dateTimes, (i) => i.valueOf(), Math.min);
		}
		/**
		* Return the max of several date times
		* @param {...DateTime} dateTimes - the DateTimes from which to choose the maximum
		* @return {DateTime} the max DateTime, or undefined if called with no argument
		*/
		static max(...dateTimes) {
			if (!dateTimes.every(DateTime.isDateTime)) throw new InvalidArgumentError("max requires all arguments be DateTimes");
			return bestBy(dateTimes, (i) => i.valueOf(), Math.max);
		}
		/**
		* Explain how a string would be parsed by fromFormat()
		* @param {string} text - the string to parse
		* @param {string} fmt - the format the string is expected to be in (see description)
		* @param {Object} options - options taken by fromFormat()
		* @return {Object}
		*/
		static fromFormatExplain(text, fmt, options = {}) {
			const { locale = null, numberingSystem = null } = options;
			return explainFromTokens(Locale.fromOpts({
				locale,
				numberingSystem,
				defaultToEN: true
			}), text, fmt);
		}
		/**
		* @deprecated use fromFormatExplain instead
		*/
		static fromStringExplain(text, fmt, options = {}) {
			return DateTime.fromFormatExplain(text, fmt, options);
		}
		/**
		* Build a parser for `fmt` using the given locale. This parser can be passed
		* to {@link DateTime.fromFormatParser} to a parse a date in this format. This
		* can be used to optimize cases where many dates need to be parsed in a
		* specific format.
		*
		* @param {String} fmt - the format the string is expected to be in (see
		* description)
		* @param {Object} options - options used to set locale and numberingSystem
		* for parser
		* @returns {TokenParser} - opaque object to be used
		*/
		static buildFormatParser(fmt, options = {}) {
			const { locale = null, numberingSystem = null } = options;
			return new TokenParser(Locale.fromOpts({
				locale,
				numberingSystem,
				defaultToEN: true
			}), fmt);
		}
		/**
		* Create a DateTime from an input string and format parser.
		*
		* The format parser must have been created with the same locale as this call.
		*
		* @param {String} text - the string to parse
		* @param {TokenParser} formatParser - parser from {@link DateTime.buildFormatParser}
		* @param {Object} opts - options taken by fromFormat()
		* @returns {DateTime}
		*/
		static fromFormatParser(text, formatParser, opts = {}) {
			if (isUndefined(text) || isUndefined(formatParser)) throw new InvalidArgumentError("fromFormatParser requires an input string and a format parser");
			const { locale = null, numberingSystem = null } = opts, localeToUse = Locale.fromOpts({
				locale,
				numberingSystem,
				defaultToEN: true
			});
			if (!localeToUse.equals(formatParser.locale)) throw new InvalidArgumentError(`fromFormatParser called with a locale of ${localeToUse}, but the format parser was created for ${formatParser.locale}`);
			const { result, zone, specificOffset, invalidReason } = formatParser.explainFromTokens(text);
			if (invalidReason) return DateTime.invalid(invalidReason);
			else return parseDataToDateTime(result, zone, opts, `format ${formatParser.format}`, text, specificOffset);
		}
		/**
		* {@link DateTime#toLocaleString} format like 10/14/1983
		* @type {Object}
		*/
		static get DATE_SHORT() {
			return DATE_SHORT;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'Oct 14, 1983'
		* @type {Object}
		*/
		static get DATE_MED() {
			return DATE_MED;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'Fri, Oct 14, 1983'
		* @type {Object}
		*/
		static get DATE_MED_WITH_WEEKDAY() {
			return DATE_MED_WITH_WEEKDAY;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'October 14, 1983'
		* @type {Object}
		*/
		static get DATE_FULL() {
			return DATE_FULL;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'Tuesday, October 14, 1983'
		* @type {Object}
		*/
		static get DATE_HUGE() {
			return DATE_HUGE;
		}
		/**
		* {@link DateTime#toLocaleString} format like '09:30 AM'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get TIME_SIMPLE() {
			return TIME_SIMPLE;
		}
		/**
		* {@link DateTime#toLocaleString} format like '09:30:23 AM'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get TIME_WITH_SECONDS() {
			return TIME_WITH_SECONDS;
		}
		/**
		* {@link DateTime#toLocaleString} format like '09:30:23 AM EDT'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get TIME_WITH_SHORT_OFFSET() {
			return TIME_WITH_SHORT_OFFSET;
		}
		/**
		* {@link DateTime#toLocaleString} format like '09:30:23 AM Eastern Daylight Time'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get TIME_WITH_LONG_OFFSET() {
			return TIME_WITH_LONG_OFFSET;
		}
		/**
		* {@link DateTime#toLocaleString} format like '09:30', always 24-hour.
		* @type {Object}
		*/
		static get TIME_24_SIMPLE() {
			return TIME_24_SIMPLE;
		}
		/**
		* {@link DateTime#toLocaleString} format like '09:30:23', always 24-hour.
		* @type {Object}
		*/
		static get TIME_24_WITH_SECONDS() {
			return TIME_24_WITH_SECONDS;
		}
		/**
		* {@link DateTime#toLocaleString} format like '09:30:23 EDT', always 24-hour.
		* @type {Object}
		*/
		static get TIME_24_WITH_SHORT_OFFSET() {
			return TIME_24_WITH_SHORT_OFFSET;
		}
		/**
		* {@link DateTime#toLocaleString} format like '09:30:23 Eastern Daylight Time', always 24-hour.
		* @type {Object}
		*/
		static get TIME_24_WITH_LONG_OFFSET() {
			return TIME_24_WITH_LONG_OFFSET;
		}
		/**
		* {@link DateTime#toLocaleString} format like '10/14/1983, 9:30 AM'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get DATETIME_SHORT() {
			return DATETIME_SHORT;
		}
		/**
		* {@link DateTime#toLocaleString} format like '10/14/1983, 9:30:33 AM'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get DATETIME_SHORT_WITH_SECONDS() {
			return DATETIME_SHORT_WITH_SECONDS;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'Oct 14, 1983, 9:30 AM'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get DATETIME_MED() {
			return DATETIME_MED;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'Oct 14, 1983, 9:30:33 AM'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get DATETIME_MED_WITH_SECONDS() {
			return DATETIME_MED_WITH_SECONDS;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'Fri, 14 Oct 1983, 9:30 AM'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get DATETIME_MED_WITH_WEEKDAY() {
			return DATETIME_MED_WITH_WEEKDAY;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'October 14, 1983, 9:30 AM EDT'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get DATETIME_FULL() {
			return DATETIME_FULL;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'October 14, 1983, 9:30:33 AM EDT'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get DATETIME_FULL_WITH_SECONDS() {
			return DATETIME_FULL_WITH_SECONDS;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'Friday, October 14, 1983, 9:30 AM Eastern Daylight Time'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get DATETIME_HUGE() {
			return DATETIME_HUGE;
		}
		/**
		* {@link DateTime#toLocaleString} format like 'Friday, October 14, 1983, 9:30:33 AM Eastern Daylight Time'. Only 12-hour if the locale is.
		* @type {Object}
		*/
		static get DATETIME_HUGE_WITH_SECONDS() {
			return DATETIME_HUGE_WITH_SECONDS;
		}
	};
	/**
	* @private
	*/
	function friendlyDateTime(dateTimeish) {
		if (DateTime.isDateTime(dateTimeish)) return dateTimeish;
		else if (dateTimeish && dateTimeish.valueOf && isNumber(dateTimeish.valueOf())) return DateTime.fromJSDate(dateTimeish);
		else if (dateTimeish && typeof dateTimeish === "object") return DateTime.fromObject(dateTimeish);
		else throw new InvalidArgumentError(`Unknown datetime argument: ${dateTimeish}, of type ${typeof dateTimeish}`);
	}
	const VERSION = "3.7.2";
	exports.DateTime = DateTime;
	exports.Duration = Duration;
	exports.FixedOffsetZone = FixedOffsetZone;
	exports.IANAZone = IANAZone;
	exports.Info = Info;
	exports.Interval = Interval;
	exports.InvalidZone = InvalidZone;
	exports.Settings = Settings;
	exports.SystemZone = SystemZone;
	exports.VERSION = VERSION;
	exports.Zone = Zone;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/CronDate.js
var require_CronDate = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronDate = exports.DAYS_IN_MONTH = exports.DateMathOp = exports.TimeUnit = void 0;
	const luxon_1 = require_luxon();
	var TimeUnit;
	(function(TimeUnit) {
		TimeUnit["Second"] = "Second";
		TimeUnit["Minute"] = "Minute";
		TimeUnit["Hour"] = "Hour";
		TimeUnit["Day"] = "Day";
		TimeUnit["Month"] = "Month";
		TimeUnit["Year"] = "Year";
	})(TimeUnit || (exports.TimeUnit = TimeUnit = {}));
	var DateMathOp;
	(function(DateMathOp) {
		DateMathOp["Add"] = "Add";
		DateMathOp["Subtract"] = "Subtract";
	})(DateMathOp || (exports.DateMathOp = DateMathOp = {}));
	exports.DAYS_IN_MONTH = Object.freeze([
		31,
		29,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31
	]);
	/**
	* CronDate class that wraps the Luxon DateTime object to provide
	* a consistent API for working with dates and times in the context of cron.
	*/
	var CronDate = class CronDate {
		#date;
		#dstStart = null;
		#dstEnd = null;
		/**
		* Maps the verb to the appropriate method
		*/
		#verbMap = {
			add: {
				[TimeUnit.Year]: this.addYear.bind(this),
				[TimeUnit.Month]: this.addMonth.bind(this),
				[TimeUnit.Day]: this.addDay.bind(this),
				[TimeUnit.Hour]: this.addHour.bind(this),
				[TimeUnit.Minute]: this.addMinute.bind(this),
				[TimeUnit.Second]: this.addSecond.bind(this)
			},
			subtract: {
				[TimeUnit.Year]: this.subtractYear.bind(this),
				[TimeUnit.Month]: this.subtractMonth.bind(this),
				[TimeUnit.Day]: this.subtractDay.bind(this),
				[TimeUnit.Hour]: this.subtractHour.bind(this),
				[TimeUnit.Minute]: this.subtractMinute.bind(this),
				[TimeUnit.Second]: this.subtractSecond.bind(this)
			}
		};
		/**
		* Constructs a new CronDate instance.
		* @param {CronDate | Date | number | string} [timestamp] - The timestamp to initialize the CronDate with.
		* @param {string} [tz] - The timezone to use for the CronDate.
		*/
		constructor(timestamp, tz) {
			const dateOpts = { zone: tz };
			if (!timestamp) this.#date = luxon_1.DateTime.local();
			else if (timestamp instanceof CronDate) {
				this.#date = timestamp.#date;
				this.#dstStart = timestamp.#dstStart;
				this.#dstEnd = timestamp.#dstEnd;
			} else if (timestamp instanceof Date) this.#date = luxon_1.DateTime.fromJSDate(timestamp, dateOpts);
			else if (typeof timestamp === "number") this.#date = luxon_1.DateTime.fromMillis(timestamp, dateOpts);
			else {
				this.#date = luxon_1.DateTime.fromISO(timestamp, dateOpts);
				this.#date.isValid || (this.#date = luxon_1.DateTime.fromRFC2822(timestamp, dateOpts));
				this.#date.isValid || (this.#date = luxon_1.DateTime.fromSQL(timestamp, dateOpts));
				this.#date.isValid || (this.#date = luxon_1.DateTime.fromFormat(timestamp, "EEE, d MMM yyyy HH:mm:ss", dateOpts));
			}
			if (!this.#date.isValid) throw new Error(`CronDate: unhandled timestamp: ${timestamp}`);
			if (tz && tz !== this.#date.zoneName) this.#date = this.#date.setZone(tz);
		}
		/**
		* Determines if the given year is a leap year.
		* @param {number} year - The year to check
		* @returns {boolean} - True if the year is a leap year, false otherwise
		* @private
		*/
		static #isLeapYear(year) {
			return year % 4 === 0 && year % 100 !== 0 || year % 400 === 0;
		}
		/**
		* Returns daylight savings start time.
		* @returns {number | null}
		*/
		get dstStart() {
			return this.#dstStart;
		}
		/**
		* Sets daylight savings start time.
		* @param {number | null} value
		*/
		set dstStart(value) {
			this.#dstStart = value;
		}
		/**
		* Returns daylight savings end time.
		* @returns {number | null}
		*/
		get dstEnd() {
			return this.#dstEnd;
		}
		/**
		* Sets daylight savings end time.
		* @param {number | null} value
		*/
		set dstEnd(value) {
			this.#dstEnd = value;
		}
		/**
		* Adds one year to the current CronDate.
		*/
		addYear() {
			this.#date = this.#date.plus({ years: 1 });
		}
		/**
		* Adds one month to the current CronDate.
		*/
		addMonth() {
			this.#date = this.#date.plus({ months: 1 }).startOf("month");
		}
		/**
		* Adds one day to the current CronDate.
		*/
		addDay() {
			this.#date = this.#date.plus({ days: 1 }).startOf("day");
		}
		/**
		* Adds one hour to the current CronDate.
		*/
		addHour() {
			this.#date = this.#date.plus({ hours: 1 }).startOf("hour");
		}
		/**
		* Adds one minute to the current CronDate.
		*/
		addMinute() {
			this.#date = this.#date.plus({ minutes: 1 }).startOf("minute");
		}
		/**
		* Adds one second to the current CronDate.
		*/
		addSecond() {
			this.#date = this.#date.plus({ seconds: 1 });
		}
		/**
		* Subtracts one year from the current CronDate.
		*/
		subtractYear() {
			this.#date = this.#date.minus({ years: 1 });
		}
		/**
		* Subtracts one month from the current CronDate.
		* If the month is 1, it will subtract one year instead.
		*/
		subtractMonth() {
			this.#date = this.#date.minus({ months: 1 }).endOf("month").startOf("second");
		}
		/**
		* Subtracts one day from the current CronDate.
		* If the day is 1, it will subtract one month instead.
		*/
		subtractDay() {
			this.#date = this.#date.minus({ days: 1 }).endOf("day").startOf("second");
		}
		/**
		* Subtracts one hour from the current CronDate.
		* If the hour is 0, it will subtract one day instead.
		*/
		subtractHour() {
			this.#date = this.#date.minus({ hours: 1 }).endOf("hour").startOf("second");
		}
		/**
		* Subtracts one minute from the current CronDate.
		* If the minute is 0, it will subtract one hour instead.
		*/
		subtractMinute() {
			this.#date = this.#date.minus({ minutes: 1 }).endOf("minute").startOf("second");
		}
		/**
		* Subtracts one second from the current CronDate.
		* If the second is 0, it will subtract one minute instead.
		*/
		subtractSecond() {
			this.#date = this.#date.minus({ seconds: 1 });
		}
		/**
		* Adds a unit of time to the current CronDate.
		* @param {TimeUnit} unit
		*/
		addUnit(unit) {
			this.#verbMap.add[unit]();
		}
		/**
		* Subtracts a unit of time from the current CronDate.
		* @param {TimeUnit} unit
		*/
		subtractUnit(unit) {
			this.#verbMap.subtract[unit]();
		}
		/**
		* Handles a math operation.
		* @param {DateMathOp} verb - {'add' | 'subtract'}
		* @param {TimeUnit} unit - {'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'}
		*/
		invokeDateOperation(verb, unit) {
			if (verb === DateMathOp.Add) {
				this.addUnit(unit);
				return;
			}
			if (verb === DateMathOp.Subtract) {
				this.subtractUnit(unit);
				return;
			}
			/* istanbul ignore next - this would only happen if an end user call the handleMathOp with an invalid verb */
			throw new Error(`Invalid verb: ${verb}`);
		}
		/**
		* Returns the day.
		* @returns {number}
		*/
		getDate() {
			return this.#date.day;
		}
		/**
		* Returns the year.
		* @returns {number}
		*/
		getFullYear() {
			return this.#date.year;
		}
		/**
		* Returns the day of the week.
		* @returns {number}
		*/
		getDay() {
			const weekday = this.#date.weekday;
			return weekday === 7 ? 0 : weekday;
		}
		/**
		* Returns the month.
		* @returns {number}
		*/
		getMonth() {
			return this.#date.month - 1;
		}
		/**
		* Returns the hour.
		* @returns {number}
		*/
		getHours() {
			return this.#date.hour;
		}
		/**
		* Returns the minutes.
		* @returns {number}
		*/
		getMinutes() {
			return this.#date.minute;
		}
		/**
		* Returns the seconds.
		* @returns {number}
		*/
		getSeconds() {
			return this.#date.second;
		}
		/**
		* Returns the milliseconds.
		* @returns {number}
		*/
		getMilliseconds() {
			return this.#date.millisecond;
		}
		/**
		* Returns the timezone offset from UTC in minutes (e.g. UTC+2 => 120).
		* Useful for detecting DST transition days.
		*
		* @returns {number} UTC offset in minutes
		*/
		getUTCOffset() {
			return this.#date.offset;
		}
		/**
		* Sets the time to the start of the day (00:00:00.000) in the current timezone.
		*/
		setStartOfDay() {
			this.#date = this.#date.startOf("day");
		}
		/**
		* Sets the time to the end of the day (23:59:59.999) in the current timezone.
		*/
		setEndOfDay() {
			this.#date = this.#date.endOf("day");
		}
		/**
		* Returns the time.
		* @returns {number}
		*/
		getTime() {
			return this.#date.valueOf();
		}
		/**
		* Returns the UTC day.
		* @returns {number}
		*/
		getUTCDate() {
			return this.#getUTC().day;
		}
		/**
		* Returns the UTC year.
		* @returns {number}
		*/
		getUTCFullYear() {
			return this.#getUTC().year;
		}
		/**
		* Returns the UTC day of the week.
		* @returns {number}
		*/
		getUTCDay() {
			const weekday = this.#getUTC().weekday;
			return weekday === 7 ? 0 : weekday;
		}
		/**
		* Returns the UTC month.
		* @returns {number}
		*/
		getUTCMonth() {
			return this.#getUTC().month - 1;
		}
		/**
		* Returns the UTC hour.
		* @returns {number}
		*/
		getUTCHours() {
			return this.#getUTC().hour;
		}
		/**
		* Returns the UTC minutes.
		* @returns {number}
		*/
		getUTCMinutes() {
			return this.#getUTC().minute;
		}
		/**
		* Returns the UTC seconds.
		* @returns {number}
		*/
		getUTCSeconds() {
			return this.#getUTC().second;
		}
		/**
		* Returns the UTC milliseconds.
		* @returns {string | null}
		*/
		toISOString() {
			return this.#date.toUTC().toISO();
		}
		/**
		* Returns the date as a JSON string.
		* @returns {string | null}
		*/
		toJSON() {
			return this.#date.toJSON();
		}
		/**
		* Sets the day.
		* @param d
		*/
		setDate(d) {
			this.#date = this.#date.set({ day: d });
		}
		/**
		* Sets the year.
		* @param y
		*/
		setFullYear(y) {
			this.#date = this.#date.set({ year: y });
		}
		/**
		* Sets the day of the week.
		* @param d
		*/
		setDay(d) {
			this.#date = this.#date.set({ weekday: d });
		}
		/**
		* Sets the month.
		* @param m
		*/
		setMonth(m) {
			this.#date = this.#date.set({ month: m + 1 });
		}
		/**
		* Sets the hour.
		* @param h
		*/
		setHours(h) {
			this.#date = this.#date.set({ hour: h });
		}
		/**
		* Sets the minutes.
		* @param m
		*/
		setMinutes(m) {
			this.#date = this.#date.set({ minute: m });
		}
		/**
		* Sets the seconds.
		* @param s
		*/
		setSeconds(s) {
			this.#date = this.#date.set({ second: s });
		}
		/**
		* Sets the milliseconds.
		* @param s
		*/
		setMilliseconds(s) {
			this.#date = this.#date.set({ millisecond: s });
		}
		/**
		* Returns the date as a string.
		* @returns {string}
		*/
		toString() {
			return this.toDate().toString();
		}
		/**
		* Returns the date as a Date object.
		* @returns {Date}
		*/
		toDate() {
			return this.#date.toJSDate();
		}
		/**
		* Returns true if the day is the last day of the month.
		* @returns {boolean}
		*/
		isLastDayOfMonth() {
			const { day, month } = this.#date;
			if (month === 2) {
				const isLeap = CronDate.#isLeapYear(this.#date.year);
				return day === exports.DAYS_IN_MONTH[month - 1] - (isLeap ? 0 : 1);
			}
			return day === exports.DAYS_IN_MONTH[month - 1];
		}
		/**
		* Returns true if the day is the last weekday of the month.
		* @returns {boolean}
		*/
		isLastWeekdayOfMonth() {
			const { day, month } = this.#date;
			let lastDay;
			if (month === 2) lastDay = exports.DAYS_IN_MONTH[month - 1] - (CronDate.#isLeapYear(this.#date.year) ? 0 : 1);
			else lastDay = exports.DAYS_IN_MONTH[month - 1];
			return day > lastDay - 7;
		}
		/**
		* Primarily for internal use.
		* @param {DateMathOp} op - The operation to perform.
		* @param {TimeUnit} unit - The unit of time to use.
		* @param {number} [hoursLength] - The length of the hours. Required when unit is not month or day.
		*/
		applyDateOperation(op, unit, hoursLength) {
			if (unit === TimeUnit.Month || unit === TimeUnit.Day) {
				this.invokeDateOperation(op, unit);
				return;
			}
			const previousHour = this.getHours();
			this.invokeDateOperation(op, unit);
			const currentHour = this.getHours();
			const diff = currentHour - previousHour;
			if (diff === 2) {
				if (hoursLength !== 24) this.dstStart = currentHour;
			} else if (diff === 0 && this.getMinutes() === 0 && this.getSeconds() === 0) {
				if (hoursLength !== 24) this.dstEnd = currentHour;
			}
		}
		/**
		* Returns the UTC date.
		* @private
		* @returns {DateTime}
		*/
		#getUTC() {
			return this.#date.toUTC();
		}
	};
	exports.CronDate = CronDate;
	exports.default = CronDate;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/fields/CronMonth.js
var require_CronMonth = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronMonth = void 0;
	const CronDate_1 = require_CronDate();
	const CronField_1 = require_CronField();
	const MIN_MONTH = 1;
	const MAX_MONTH = 12;
	const MONTH_CHARS = Object.freeze([]);
	/**
	* Represents the "day of the month" field within a cron expression.
	* @class CronDayOfMonth
	* @extends CronField
	*/
	var CronMonth = class extends CronField_1.CronField {
		static get min() {
			return MIN_MONTH;
		}
		static get max() {
			return MAX_MONTH;
		}
		static get chars() {
			return MONTH_CHARS;
		}
		static get daysInMonth() {
			return CronDate_1.DAYS_IN_MONTH;
		}
		/**
		* CronDayOfMonth constructor. Initializes the "day of the month" field with the provided values.
		* @param {MonthRange[]} values - Values for the "day of the month" field
		* @param {CronFieldOptions} [options] - Options provided by the parser
		*/
		constructor(values, options) {
			super(values, options);
			this.validate();
		}
		/**
		* Returns an array of allowed values for the "day of the month" field.
		* @returns {MonthRange[]}
		*/
		get values() {
			return super.values;
		}
	};
	exports.CronMonth = CronMonth;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/fields/CronSecond.js
var require_CronSecond = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronSecond = void 0;
	const CronField_1 = require_CronField();
	const MIN_SECOND = 0;
	const MAX_SECOND = 59;
	const SECOND_CHARS = Object.freeze([]);
	/**
	* Represents the "second" field within a cron expression.
	* @class CronSecond
	* @extends CronField
	*/
	var CronSecond = class extends CronField_1.CronField {
		static get min() {
			return MIN_SECOND;
		}
		static get max() {
			return MAX_SECOND;
		}
		static get chars() {
			return SECOND_CHARS;
		}
		/**
		* CronSecond constructor. Initializes the "second" field with the provided values.
		* @param {SixtyRange[]} values - Values for the "second" field
		* @param {CronFieldOptions} [options] - Options provided by the parser
		*/
		constructor(values, options) {
			super(values, options);
			this.validate();
		}
		/**
		* Returns an array of allowed values for the "second" field.
		* @returns {SixtyRange[]}
		*/
		get values() {
			return super.values;
		}
	};
	exports.CronSecond = CronSecond;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/fields/index.js
var require_fields = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$2) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$2, p)) __createBinding(exports$2, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_types(), exports);
	__exportStar(require_CronDayOfMonth(), exports);
	__exportStar(require_CronDayOfWeek(), exports);
	__exportStar(require_CronField(), exports);
	__exportStar(require_CronHour(), exports);
	__exportStar(require_CronMinute(), exports);
	__exportStar(require_CronMonth(), exports);
	__exportStar(require_CronSecond(), exports);
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/CronFieldCollection.js
var require_CronFieldCollection = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronFieldCollection = void 0;
	const fields_1 = require_fields();
	/**
	* Represents a complete set of cron fields.
	* @class CronFieldCollection
	*/
	var CronFieldCollection = class CronFieldCollection {
		#second;
		#minute;
		#hour;
		#dayOfMonth;
		#month;
		#dayOfWeek;
		/**
		* Creates a new CronFieldCollection instance by partially overriding fields from an existing one.
		* @param {CronFieldCollection} base - The base CronFieldCollection to copy fields from
		* @param {CronFieldOverride} fields - The fields to override, can be CronField instances or raw values
		* @returns {CronFieldCollection} A new CronFieldCollection instance
		* @example
		* const base = new CronFieldCollection({
		*   second: new CronSecond([0]),
		*   minute: new CronMinute([0]),
		*   hour: new CronHour([12]),
		*   dayOfMonth: new CronDayOfMonth([1]),
		*   month: new CronMonth([1]),
		*   dayOfWeek: new CronDayOfWeek([1])
		* });
		*
		* // Using CronField instances
		* const modified1 = CronFieldCollection.from(base, {
		*   hour: new CronHour([15]),
		*   minute: new CronMinute([30])
		* });
		*
		* // Using raw values
		* const modified2 = CronFieldCollection.from(base, {
		*   hour: [15],        // Will create new CronHour
		*   minute: [30]       // Will create new CronMinute
		* });
		*/
		static from(base, fields) {
			return new CronFieldCollection({
				second: this.resolveField(fields_1.CronSecond, base.second, fields.second),
				minute: this.resolveField(fields_1.CronMinute, base.minute, fields.minute),
				hour: this.resolveField(fields_1.CronHour, base.hour, fields.hour),
				dayOfMonth: this.resolveField(fields_1.CronDayOfMonth, base.dayOfMonth, fields.dayOfMonth),
				month: this.resolveField(fields_1.CronMonth, base.month, fields.month),
				dayOfWeek: this.resolveField(fields_1.CronDayOfWeek, base.dayOfWeek, fields.dayOfWeek)
			});
		}
		/**
		* Resolves a field value, either using the provided CronField instance or creating a new one from raw values.
		* @param constructor - The constructor for creating new field instances
		* @param baseField - The base field to use if no override is provided
		* @param fieldValue - The override value, either a CronField instance or raw values
		* @returns The resolved CronField instance
		* @private
		*/
		static resolveField(constructor, baseField, fieldValue) {
			if (!fieldValue) return baseField;
			if (fieldValue instanceof fields_1.CronField) return fieldValue;
			return new constructor(fieldValue);
		}
		/**
		* CronFieldCollection constructor. Initializes the cron fields with the provided values.
		* @param {CronFields} param0 - The cron fields values
		* @throws {Error} if validation fails
		* @example
		* const cronFields = new CronFieldCollection({
		*   second: new CronSecond([0]),
		*   minute: new CronMinute([0, 30]),
		*   hour: new CronHour([9]),
		*   dayOfMonth: new CronDayOfMonth([15]),
		*   month: new CronMonth([1]),
		*   dayOfWeek: new CronDayOfTheWeek([1, 2, 3, 4, 5]),
		* })
		*
		* console.log(cronFields.second.values); // [0]
		* console.log(cronFields.minute.values); // [0, 30]
		* console.log(cronFields.hour.values); // [9]
		* console.log(cronFields.dayOfMonth.values); // [15]
		* console.log(cronFields.month.values); // [1]
		* console.log(cronFields.dayOfWeek.values); // [1, 2, 3, 4, 5]
		*/
		constructor({ second, minute, hour, dayOfMonth, month, dayOfWeek }) {
			if (!second) throw new Error("Validation error, Field second is missing");
			if (!minute) throw new Error("Validation error, Field minute is missing");
			if (!hour) throw new Error("Validation error, Field hour is missing");
			if (!dayOfMonth) throw new Error("Validation error, Field dayOfMonth is missing");
			if (!month) throw new Error("Validation error, Field month is missing");
			if (!dayOfWeek) throw new Error("Validation error, Field dayOfWeek is missing");
			if (month.values.length === 1 && !dayOfMonth.hasLastChar) {
				if (!(parseInt(dayOfMonth.values[0], 10) <= fields_1.CronMonth.daysInMonth[month.values[0] - 1])) throw new Error("Invalid explicit day of month definition");
			}
			this.#second = second;
			this.#minute = minute;
			this.#hour = hour;
			this.#month = month;
			this.#dayOfWeek = dayOfWeek;
			this.#dayOfMonth = dayOfMonth;
		}
		/**
		* Returns the second field.
		* @returns {CronSecond}
		*/
		get second() {
			return this.#second;
		}
		/**
		* Returns the minute field.
		* @returns {CronMinute}
		*/
		get minute() {
			return this.#minute;
		}
		/**
		* Returns the hour field.
		* @returns {CronHour}
		*/
		get hour() {
			return this.#hour;
		}
		/**
		* Returns the day of the month field.
		* @returns {CronDayOfMonth}
		*/
		get dayOfMonth() {
			return this.#dayOfMonth;
		}
		/**
		* Returns the month field.
		* @returns {CronMonth}
		*/
		get month() {
			return this.#month;
		}
		/**
		* Returns the day of the week field.
		* @returns {CronDayOfWeek}
		*/
		get dayOfWeek() {
			return this.#dayOfWeek;
		}
		/**
		* Returns a string representation of the cron fields.
		* @param {(number | CronChars)[]} input - The cron fields values
		* @static
		* @returns {FieldRange[]} - The compacted cron fields
		*/
		static compactField(input) {
			if (input.length === 0) return [];
			const output = [];
			let current = void 0;
			input.forEach((item, i, arr) => {
				if (current === void 0) {
					current = {
						start: item,
						count: 1
					};
					return;
				}
				const prevItem = arr[i - 1] || current.start;
				const nextItem = arr[i + 1];
				if (item === "L" || item === "W") {
					output.push(current);
					output.push({
						start: item,
						count: 1
					});
					current = void 0;
					return;
				}
				if (current.step === void 0 && nextItem !== void 0) {
					const step = item - prevItem;
					if (step <= nextItem - item) {
						current = {
							...current,
							count: 2,
							end: item,
							step
						};
						return;
					}
					current.step = 1;
				}
				if (item - (current.end ?? 0) === current.step) {
					current.count++;
					current.end = item;
				} else {
					if (current.count === 1) output.push({
						start: current.start,
						count: 1
					});
					else if (current.count === 2) {
						output.push({
							start: current.start,
							count: 1
						});
						output.push({
							start: current.end ?? prevItem,
							count: 1
						});
					} else output.push(current);
					current = {
						start: item,
						count: 1
					};
				}
			});
			if (current) output.push(current);
			return output;
		}
		/**
		* Handles a single range.
		* @param {CronField} field - The cron field to stringify
		* @param {FieldRange} range {start: number, end: number, step: number, count: number} The range to handle.
		* @param {number} max The maximum value for the field.
		* @returns {string | null} The stringified range or null if it cannot be stringified.
		* @private
		*/
		static #handleSingleRange(field, range, max) {
			const step = range.step;
			if (!step) return null;
			if (step === 1 && range.start === field.min && range.end && range.end >= max) return field.hasQuestionMarkChar ? "?" : "*";
			if (step !== 1 && range.start === field.min && range.end && range.end >= max - step + 1) return `*/${step}`;
			return null;
		}
		/**
		* Handles multiple ranges.
		* @param {FieldRange} range {start: number, end: number, step: number, count: number} The range to handle.
		* @param {number} max The maximum value for the field.
		* @returns {string} The stringified range.
		* @private
		*/
		static #handleMultipleRanges(range, max) {
			const step = range.step;
			if (step === 1) return `${range.start}-${range.end}`;
			const multiplier = range.start === 0 ? range.count - 1 : range.count;
			/* istanbul ignore if */
			if (!step) throw new Error("Unexpected range step");
			/* istanbul ignore if */
			if (!range.end) throw new Error("Unexpected range end");
			if (step * multiplier > range.end) {
				const mapFn = (_, index) => {
					/* istanbul ignore if */
					if (typeof range.start !== "number") throw new Error("Unexpected range start");
					return index % step === 0 ? range.start + index : null;
				};
				/* istanbul ignore if */
				if (typeof range.start !== "number") throw new Error("Unexpected range start");
				const seed = { length: range.end - range.start + 1 };
				return Array.from(seed, mapFn).filter((value) => value !== null).join(",");
			}
			return range.end === max - step + 1 ? `${range.start}/${step}` : `${range.start}-${range.end}/${step}`;
		}
		/**
		* Returns a string representation of the cron fields.
		* @param {CronField} field - The cron field to stringify
		* @static
		* @returns {string} - The stringified cron field
		*/
		stringifyField(field) {
			let max = field.max;
			let values = field.values;
			if (field instanceof fields_1.CronDayOfWeek) {
				max = 6;
				const dayOfWeek = this.#dayOfWeek.values;
				values = dayOfWeek[dayOfWeek.length - 1] === 7 ? dayOfWeek.slice(0, -1) : dayOfWeek;
			}
			if (field instanceof fields_1.CronDayOfMonth) max = this.#month.values.length === 1 ? fields_1.CronMonth.daysInMonth[this.#month.values[0] - 1] : field.max;
			const ranges = CronFieldCollection.compactField(values);
			if (ranges.length === 1) {
				const singleRangeResult = CronFieldCollection.#handleSingleRange(field, ranges[0], max);
				if (singleRangeResult) return singleRangeResult;
			}
			return ranges.map((range) => {
				const value = range.count === 1 ? range.start.toString() : CronFieldCollection.#handleMultipleRanges(range, max);
				if (field instanceof fields_1.CronDayOfWeek && field.nthDay > 0) return `${value}#${field.nthDay}`;
				return value;
			}).join(",");
		}
		/**
		* Returns a string representation of the cron field values.
		* @param {boolean} includeSeconds - Whether to include seconds in the output
		* @returns {string} The formatted cron string
		*/
		stringify(includeSeconds = false) {
			const arr = [];
			if (includeSeconds) arr.push(this.stringifyField(this.#second));
			arr.push(this.stringifyField(this.#minute), this.stringifyField(this.#hour), this.stringifyField(this.#dayOfMonth), this.stringifyField(this.#month), this.stringifyField(this.#dayOfWeek));
			return arr.join(" ");
		}
		/**
		* Returns a serialized representation of the cron fields values.
		* @returns {SerializedCronFields} An object containing the cron field values
		*/
		serialize() {
			return {
				second: this.#second.serialize(),
				minute: this.#minute.serialize(),
				hour: this.#hour.serialize(),
				dayOfMonth: this.#dayOfMonth.serialize(),
				month: this.#month.serialize(),
				dayOfWeek: this.#dayOfWeek.serialize()
			};
		}
	};
	exports.CronFieldCollection = CronFieldCollection;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/CronExpression.js
var require_CronExpression = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronExpression = exports.LOOPS_LIMIT_EXCEEDED_ERROR_MESSAGE = exports.TIME_SPAN_OUT_OF_BOUNDS_ERROR_MESSAGE = void 0;
	const CronDate_1 = require_CronDate();
	/**
	* Error message for when the current date is outside the specified time span.
	*/
	exports.TIME_SPAN_OUT_OF_BOUNDS_ERROR_MESSAGE = "Out of the time span range";
	/**
	* Error message for when the loop limit is exceeded during iteration.
	*/
	exports.LOOPS_LIMIT_EXCEEDED_ERROR_MESSAGE = "Invalid expression, loop limit exceeded";
	/**
	* Cron iteration loop safety limit
	*/
	const LOOP_LIMIT = 1e4;
	/**
	* Class representing a Cron expression.
	*/
	var CronExpression = class CronExpression {
		#options;
		#tz;
		#currentDate;
		#startDate;
		#endDate;
		#fields;
		#dstTransitionDayKey = null;
		#isDstTransitionDay = false;
		/**
		* Creates a new CronExpression instance.
		*
		* @param {CronFieldCollection} fields - Cron fields.
		* @param {CronExpressionOptions} options - Parser options.
		*/
		constructor(fields, options) {
			this.#options = options;
			this.#tz = options.tz;
			this.#startDate = options.startDate ? new CronDate_1.CronDate(options.startDate, this.#tz) : null;
			this.#endDate = options.endDate ? new CronDate_1.CronDate(options.endDate, this.#tz) : null;
			let currentDateValue = options.currentDate ?? options.startDate;
			if (currentDateValue) {
				const tempCurrentDate = new CronDate_1.CronDate(currentDateValue, this.#tz);
				if (this.#startDate && tempCurrentDate.getTime() < this.#startDate.getTime()) currentDateValue = this.#startDate;
				else if (this.#endDate && tempCurrentDate.getTime() > this.#endDate.getTime()) currentDateValue = this.#endDate;
			}
			this.#currentDate = new CronDate_1.CronDate(currentDateValue, this.#tz);
			this.#fields = fields;
		}
		/**
		* Getter for the cron fields.
		*
		* @returns {CronFieldCollection} Cron fields.
		*/
		get fields() {
			return this.#fields;
		}
		/**
		* Converts cron fields back to a CronExpression instance.
		*
		* @public
		* @param {Record<string, number[]>} fields - The input cron fields object.
		* @param {CronExpressionOptions} [options] - Optional parsing options.
		* @returns {CronExpression} - A new CronExpression instance.
		*/
		static fieldsToExpression(fields, options) {
			return new CronExpression(fields, options || {});
		}
		/**
		* Checks if the given value matches any element in the sequence.
		*
		* @param {number} value - The value to be matched.
		* @param {number[]} sequence - The sequence to be checked against.
		* @returns {boolean} - True if the value matches an element in the sequence; otherwise, false.
		* @memberof CronExpression
		* @private
		*/
		static #matchSchedule(value, sequence) {
			return sequence.some((element) => element === value);
		}
		/**
		* Returns the minimum or maximum value from the given array of numbers.
		*
		* @param {number[]} values - An array of numbers.
		* @param {boolean} reverse - If true, returns the maximum value; otherwise, returns the minimum value.
		* @returns {number} - The minimum or maximum value.
		*/
		#getMinOrMax(values, reverse) {
			return values[reverse ? values.length - 1 : 0];
		}
		/**
		* Checks whether the given date falls on a DST transition day in its timezone.
		*
		* This is used to disable certain “direct set” fast paths on DST days, because setting the hour
		* directly may land on a non-existent or repeated local time. We cache the result per calendar day
		* to keep iteration overhead low.
		*
		* @param {CronDate} currentDate - Date to check (in the cron timezone)
		* @returns {boolean} True when the day has a DST transition
		* @private
		*/
		#checkDstTransition(currentDate) {
			const key = `${currentDate.getFullYear()}-${currentDate.getMonth() + 1}-${currentDate.getDate()}`;
			if (this.#dstTransitionDayKey === key) return this.#isDstTransitionDay;
			const startOfDay = new CronDate_1.CronDate(currentDate);
			startOfDay.setStartOfDay();
			const endOfDay = new CronDate_1.CronDate(currentDate);
			endOfDay.setEndOfDay();
			this.#dstTransitionDayKey = key;
			this.#isDstTransitionDay = startOfDay.getUTCOffset() !== endOfDay.getUTCOffset();
			return this.#isDstTransitionDay;
		}
		/**
		* Moves the date to the next/previous allowed second value. If there is no remaining allowed second
		* within the current minute, rolls to the next/previous minute and resets seconds to the min/max allowed.
		*
		* @param {CronDate} currentDate - Mutable date being iterated
		* @param {DateMathOp} dateMathVerb - Add/Subtract depending on direction
		* @param {boolean} reverse - When true, iterating backwards
		* @private
		*/
		#moveToNextSecond(currentDate, dateMathVerb, reverse) {
			const seconds = this.#fields.second.values;
			const currentSecond = currentDate.getSeconds();
			const nextSecond = this.#fields.second.findNearestValue(currentSecond, reverse);
			if (nextSecond !== null) {
				currentDate.setSeconds(nextSecond);
				return;
			}
			currentDate.applyDateOperation(dateMathVerb, CronDate_1.TimeUnit.Minute, this.#fields.hour.values.length);
			currentDate.setSeconds(this.#getMinOrMax(seconds, reverse));
		}
		/**
		* Moves the date to the next/previous allowed minute value and resets seconds to the min/max allowed.
		* If there is no remaining allowed minute within the current hour, rolls to the next/previous hour and
		* resets minutes/seconds to their extrema.
		*
		* @param {CronDate} currentDate - Mutable date being iterated
		* @param {DateMathOp} dateMathVerb - Add/Subtract depending on direction
		* @param {boolean} reverse - When true, iterating backwards
		* @private
		*/
		#moveToNextMinute(currentDate, dateMathVerb, reverse) {
			const minutes = this.#fields.minute.values;
			const seconds = this.#fields.second.values;
			const currentMinute = currentDate.getMinutes();
			const nextMinute = this.#fields.minute.findNearestValue(currentMinute, reverse);
			if (nextMinute !== null) {
				currentDate.setMinutes(nextMinute);
				currentDate.setSeconds(this.#getMinOrMax(seconds, reverse));
				return;
			}
			currentDate.applyDateOperation(dateMathVerb, CronDate_1.TimeUnit.Hour, this.#fields.hour.values.length);
			currentDate.setMinutes(this.#getMinOrMax(minutes, reverse));
			currentDate.setSeconds(this.#getMinOrMax(seconds, reverse));
		}
		/**
		* Determines if the current date matches the last specified weekday of the month.
		*
		* @param {Array<(number|string)>} expressions - An array of expressions containing weekdays and "L" for the last weekday.
		* @param {CronDate} currentDate - The current date object.
		* @returns {boolean} - True if the current date matches the last specified weekday of the month; otherwise, false.
		* @memberof CronExpression
		* @private
		*/
		static #isLastWeekdayOfMonthMatch(expressions, currentDate) {
			const isLastWeekdayOfMonth = currentDate.isLastWeekdayOfMonth();
			return expressions.some((expression) => {
				const weekday = parseInt(expression.toString().charAt(0), 10) % 7;
				if (Number.isNaN(weekday)) throw new Error(`Invalid last weekday of the month expression: ${expression}`);
				return currentDate.getDay() === weekday && isLastWeekdayOfMonth;
			});
		}
		/**
		* Find the next scheduled date based on the cron expression.
		* @returns {CronDate} - The next scheduled date or an ES6 compatible iterator object.
		* @memberof CronExpression
		* @public
		*/
		next() {
			return this.#findSchedule();
		}
		/**
		* Find the previous scheduled date based on the cron expression.
		* @returns {CronDate} - The previous scheduled date or an ES6 compatible iterator object.
		* @memberof CronExpression
		* @public
		*/
		prev() {
			return this.#findSchedule(true);
		}
		/**
		* Check if there is a next scheduled date based on the current date and cron expression.
		* @returns {boolean} - Returns true if there is a next scheduled date, false otherwise.
		* @memberof CronExpression
		* @public
		*/
		hasNext() {
			const current = this.#currentDate;
			try {
				this.#findSchedule();
				return true;
			} catch {
				return false;
			} finally {
				this.#currentDate = current;
			}
		}
		/**
		* Check if there is a previous scheduled date based on the current date and cron expression.
		* @returns {boolean} - Returns true if there is a previous scheduled date, false otherwise.
		* @memberof CronExpression
		* @public
		*/
		hasPrev() {
			const current = this.#currentDate;
			try {
				this.#findSchedule(true);
				return true;
			} catch {
				return false;
			} finally {
				this.#currentDate = current;
			}
		}
		/**
		* Iterate over a specified number of steps and optionally execute a callback function for each step.
		* @param {number} steps - The number of steps to iterate. Positive value iterates forward, negative value iterates backward.
		* @returns {CronDate[]} - An array of iterator fields or CronDate objects.
		* @memberof CronExpression
		* @public
		*/
		take(limit) {
			const items = [];
			if (limit >= 0) for (let i = 0; i < limit; i++) try {
				items.push(this.next());
			} catch {
				return items;
			}
			else for (let i = 0; i > limit; i--) try {
				items.push(this.prev());
			} catch {
				return items;
			}
			return items;
		}
		/**
		* Reset the iterators current date to a new date or the initial date.
		* @param {Date | CronDate} [newDate] - Optional new date to reset to. If not provided, it will reset to the initial date.
		* @memberof CronExpression
		* @public
		*/
		reset(newDate) {
			this.#currentDate = new CronDate_1.CronDate(newDate || this.#options.currentDate);
		}
		/**
		* Generate a string representation of the cron expression.
		* @param {boolean} [includeSeconds=false] - Whether to include the seconds field in the string representation.
		* @returns {string} - The string representation of the cron expression.
		* @memberof CronExpression
		* @public
		*/
		stringify(includeSeconds = false) {
			return this.#fields.stringify(includeSeconds);
		}
		/**
		* Check if the cron expression includes the given date
		* @param {Date|CronDate} date
		* @returns {boolean}
		*/
		includesDate(date) {
			const { second, minute, hour, month } = this.#fields;
			const dt = new CronDate_1.CronDate(date, this.#tz);
			if (!second.values.includes(dt.getSeconds()) || !minute.values.includes(dt.getMinutes()) || !hour.values.includes(dt.getHours()) || !month.values.includes(dt.getMonth() + 1)) return false;
			if (!this.#matchDayOfMonth(dt)) return false;
			if (this.#fields.dayOfWeek.nthDay > 0) {
				if (Math.ceil(dt.getDate() / 7) !== this.#fields.dayOfWeek.nthDay) return false;
			}
			return true;
		}
		/**
		* Returns the string representation of the cron expression.
		* @returns {CronDate} - The next schedule date.
		*/
		toString() {
			/* istanbul ignore next - should be impossible under normal use to trigger the or branch */
			return this.#options.expression || this.stringify(true);
		}
		/**
		* Determines if the given date matches the cron expression's day of month and day of week fields.
		*
		* The function checks the following rules:
		* Rule 1: If both "day of month" and "day of week" are restricted (not wildcard), then one or both must match the current day.
		* Rule 2: If "day of month" is restricted and "day of week" is not restricted, then "day of month" must match the current day.
		* Rule 3: If "day of month" is a wildcard, "day of week" is not a wildcard, and "day of week" matches the current day, then the match is accepted.
		* If none of the rules match, the match is rejected.
		*
		* @param {CronDate} currentDate - The current date to be evaluated against the cron expression.
		* @returns {boolean} Returns true if the current date matches the cron expression's day of month and day of week fields, otherwise false.
		* @memberof CronExpression
		* @private
		*/
		#matchDayOfMonth(currentDate) {
			const isDayOfMonthWildcardMatch = this.#fields.dayOfMonth.isWildcard;
			const isRestrictedDayOfMonth = !isDayOfMonthWildcardMatch;
			const isDayOfWeekWildcardMatch = this.#fields.dayOfWeek.isWildcard;
			const isRestrictedDayOfWeek = !isDayOfWeekWildcardMatch;
			const matchedDOM = CronExpression.#matchSchedule(currentDate.getDate(), this.#fields.dayOfMonth.values) || this.#fields.dayOfMonth.hasLastChar && currentDate.isLastDayOfMonth();
			const matchedDOW = CronExpression.#matchSchedule(currentDate.getDay(), this.#fields.dayOfWeek.values) || this.#fields.dayOfWeek.hasLastChar && CronExpression.#isLastWeekdayOfMonthMatch(this.#fields.dayOfWeek.values, currentDate);
			if (isRestrictedDayOfMonth && isRestrictedDayOfWeek && (matchedDOM || matchedDOW)) return true;
			if (matchedDOM && !isRestrictedDayOfWeek) return true;
			if (isDayOfMonthWildcardMatch && !isDayOfWeekWildcardMatch && matchedDOW) return true;
			return false;
		}
		/**
		* Determines if the current hour matches the cron expression.
		*
		* @param {CronDate} currentDate - The current date object.
		* @param {DateMathOp} dateMathVerb - The date math operation enumeration value.
		* @param {boolean} reverse - A flag indicating whether the matching should be done in reverse order.
		* @returns {boolean} - True if the current hour matches the cron expression; otherwise, false.
		*/
		#matchHour(currentDate, dateMathVerb, reverse) {
			const hourValues = this.#fields.hour.values;
			const hours = hourValues;
			const currentHour = currentDate.getHours();
			const isMatch = CronExpression.#matchSchedule(currentHour, hourValues);
			const isDstStart = currentDate.dstStart === currentHour;
			const isDstEnd = currentDate.dstEnd === currentHour;
			if (isDstStart) {
				if (CronExpression.#matchSchedule(currentHour - 1, hourValues)) return true;
				currentDate.invokeDateOperation(dateMathVerb, CronDate_1.TimeUnit.Hour);
				return false;
			}
			if (isDstEnd && !reverse) {
				currentDate.dstEnd = null;
				currentDate.applyDateOperation(CronDate_1.DateMathOp.Add, CronDate_1.TimeUnit.Hour, hours.length);
				return false;
			}
			if (isMatch) return true;
			currentDate.dstStart = null;
			const nextHour = this.#fields.hour.findNearestValue(currentHour, reverse);
			if (nextHour === null) {
				currentDate.applyDateOperation(dateMathVerb, CronDate_1.TimeUnit.Day, hours.length);
				return false;
			}
			if (this.#checkDstTransition(currentDate)) {
				const steps = reverse ? currentHour - nextHour : nextHour - currentHour;
				for (let i = 0; i < steps; i++) currentDate.applyDateOperation(dateMathVerb, CronDate_1.TimeUnit.Hour, hours.length);
			} else currentDate.setHours(nextHour);
			currentDate.setMinutes(this.#getMinOrMax(this.#fields.minute.values, reverse));
			currentDate.setSeconds(this.#getMinOrMax(this.#fields.second.values, reverse));
			return false;
		}
		/**
		* Validates the current date against the start and end dates of the cron expression.
		* If the current date is outside the specified time span, an error is thrown.
		*
		* @param currentDate {CronDate} - The current date to validate.
		* @throws {Error} If the current date is outside the specified time span.
		* @private
		*/
		#validateTimeSpan(currentDate) {
			if (!this.#startDate && !this.#endDate) return;
			const currentTime = currentDate.getTime();
			if (this.#startDate && currentTime < this.#startDate.getTime()) throw new Error(exports.TIME_SPAN_OUT_OF_BOUNDS_ERROR_MESSAGE);
			if (this.#endDate && currentTime > this.#endDate.getTime()) throw new Error(exports.TIME_SPAN_OUT_OF_BOUNDS_ERROR_MESSAGE);
		}
		/**
		* Finds the next or previous schedule based on the cron expression.
		*
		* @param {boolean} [reverse=false] - If true, finds the previous schedule; otherwise, finds the next schedule.
		* @returns {CronDate} - The next or previous schedule date.
		* @private
		*/
		#findSchedule(reverse = false) {
			const dateMathVerb = reverse ? CronDate_1.DateMathOp.Subtract : CronDate_1.DateMathOp.Add;
			const currentDate = new CronDate_1.CronDate(this.#currentDate);
			const startTimestamp = currentDate.getTime();
			let stepCount = 0;
			while (++stepCount < LOOP_LIMIT) {
				this.#validateTimeSpan(currentDate);
				if (!this.#matchDayOfMonth(currentDate)) {
					currentDate.applyDateOperation(dateMathVerb, CronDate_1.TimeUnit.Day, this.#fields.hour.values.length);
					continue;
				}
				if (!(this.#fields.dayOfWeek.nthDay <= 0 || Math.ceil(currentDate.getDate() / 7) === this.#fields.dayOfWeek.nthDay)) {
					currentDate.applyDateOperation(dateMathVerb, CronDate_1.TimeUnit.Day, this.#fields.hour.values.length);
					continue;
				}
				if (!CronExpression.#matchSchedule(currentDate.getMonth() + 1, this.#fields.month.values)) {
					currentDate.applyDateOperation(dateMathVerb, CronDate_1.TimeUnit.Month, this.#fields.hour.values.length);
					continue;
				}
				if (!this.#matchHour(currentDate, dateMathVerb, reverse)) continue;
				if (!CronExpression.#matchSchedule(currentDate.getMinutes(), this.#fields.minute.values)) {
					this.#moveToNextMinute(currentDate, dateMathVerb, reverse);
					continue;
				}
				if (!CronExpression.#matchSchedule(currentDate.getSeconds(), this.#fields.second.values)) {
					this.#moveToNextSecond(currentDate, dateMathVerb, reverse);
					continue;
				}
				if (startTimestamp === currentDate.getTime()) {
					if (dateMathVerb === "Add" || currentDate.getMilliseconds() === 0) currentDate.applyDateOperation(dateMathVerb, CronDate_1.TimeUnit.Second, this.#fields.hour.values.length);
					continue;
				}
				break;
			}
			/* istanbul ignore next - should be impossible under normal use to trigger the branch */
			if (stepCount > LOOP_LIMIT) throw new Error(exports.LOOPS_LIMIT_EXCEEDED_ERROR_MESSAGE);
			if (currentDate.getMilliseconds() !== 0) currentDate.setMilliseconds(0);
			this.#currentDate = currentDate;
			return currentDate;
		}
		/**
		* Returns an iterator for iterating through future CronDate instances
		*
		* @name Symbol.iterator
		* @memberof CronExpression
		* @returns {Iterator<CronDate>} An iterator object for CronExpression that returns CronDate values.
		*/
		[Symbol.iterator]() {
			return { next: () => {
				return {
					value: this.#findSchedule(),
					done: !this.hasNext()
				};
			} };
		}
	};
	exports.CronExpression = CronExpression;
	exports.default = CronExpression;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/utils/random.js
var require_random = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.seededRandom = seededRandom;
	/**
	* Computes a numeric hash from a given string
	* @param {string} str A value to hash
	* @returns {number} A numeric hash computed from the given value
	*/
	function xfnv1a(str) {
		let h = 2166136261;
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return () => h >>> 0;
	}
	/**
	* Initialize a new PRNG using a given seed
	* @param {number} seed The seed used to initialize the PRNG
	* @returns {PRNG} A random number generator
	*/
	function mulberry32(seed) {
		return () => {
			let t = seed += 1831565813;
			t = Math.imul(t ^ t >>> 15, t | 1);
			t ^= t + Math.imul(t ^ t >>> 7, t | 61);
			return ((t ^ t >>> 14) >>> 0) / 4294967296;
		};
	}
	/**
	* Generates a PRNG using a given seed. When not provided, the seed is randomly generated
	* @param {string} str A string to derive the seed from
	* @returns {PRNG} A random number generator correctly seeded
	*/
	function seededRandom(str) {
		return mulberry32(str ? xfnv1a(str)() : Math.floor(Math.random() * 1e10));
	}
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/CronExpressionParser.js
var require_CronExpressionParser = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronExpressionParser = exports.DayOfWeek = exports.Months = exports.CronUnit = exports.PredefinedExpressions = void 0;
	const CronFieldCollection_1 = require_CronFieldCollection();
	const CronExpression_1 = require_CronExpression();
	const random_1 = require_random();
	const fields_1 = require_fields();
	var PredefinedExpressions;
	(function(PredefinedExpressions) {
		PredefinedExpressions["@yearly"] = "0 0 0 1 1 *";
		PredefinedExpressions["@annually"] = "0 0 0 1 1 *";
		PredefinedExpressions["@monthly"] = "0 0 0 1 * *";
		PredefinedExpressions["@weekly"] = "0 0 0 * * 0";
		PredefinedExpressions["@daily"] = "0 0 0 * * *";
		PredefinedExpressions["@hourly"] = "0 0 * * * *";
		PredefinedExpressions["@minutely"] = "0 * * * * *";
		PredefinedExpressions["@secondly"] = "* * * * * *";
		PredefinedExpressions["@weekdays"] = "0 0 0 * * 1-5";
		PredefinedExpressions["@weekends"] = "0 0 0 * * 0,6";
	})(PredefinedExpressions || (exports.PredefinedExpressions = PredefinedExpressions = {}));
	var CronUnit;
	(function(CronUnit) {
		CronUnit["Second"] = "Second";
		CronUnit["Minute"] = "Minute";
		CronUnit["Hour"] = "Hour";
		CronUnit["DayOfMonth"] = "DayOfMonth";
		CronUnit["Month"] = "Month";
		CronUnit["DayOfWeek"] = "DayOfWeek";
	})(CronUnit || (exports.CronUnit = CronUnit = {}));
	var Months;
	(function(Months) {
		Months[Months["jan"] = 1] = "jan";
		Months[Months["feb"] = 2] = "feb";
		Months[Months["mar"] = 3] = "mar";
		Months[Months["apr"] = 4] = "apr";
		Months[Months["may"] = 5] = "may";
		Months[Months["jun"] = 6] = "jun";
		Months[Months["jul"] = 7] = "jul";
		Months[Months["aug"] = 8] = "aug";
		Months[Months["sep"] = 9] = "sep";
		Months[Months["oct"] = 10] = "oct";
		Months[Months["nov"] = 11] = "nov";
		Months[Months["dec"] = 12] = "dec";
	})(Months || (exports.Months = Months = {}));
	var DayOfWeek;
	(function(DayOfWeek) {
		DayOfWeek[DayOfWeek["sun"] = 0] = "sun";
		DayOfWeek[DayOfWeek["mon"] = 1] = "mon";
		DayOfWeek[DayOfWeek["tue"] = 2] = "tue";
		DayOfWeek[DayOfWeek["wed"] = 3] = "wed";
		DayOfWeek[DayOfWeek["thu"] = 4] = "thu";
		DayOfWeek[DayOfWeek["fri"] = 5] = "fri";
		DayOfWeek[DayOfWeek["sat"] = 6] = "sat";
	})(DayOfWeek || (exports.DayOfWeek = DayOfWeek = {}));
	/**
	* Static class that parses a cron expression and returns a CronExpression object.
	* @static
	* @class CronExpressionParser
	*/
	var CronExpressionParser = class CronExpressionParser {
		/**
		* Parses a cron expression and returns a CronExpression object.
		* @param {string} expression - The cron expression to parse.
		* @param {CronExpressionOptions} [options={}] - The options to use when parsing the expression.
		* @param {boolean} [options.strict=false] - If true, will throw an error if the expression contains both dayOfMonth and dayOfWeek.
		* @param {CronDate} [options.currentDate=new CronDate(undefined, 'UTC')] - The date to use when calculating the next/previous occurrence.
		*
		* @returns {CronExpression} A CronExpression object.
		*/
		static parse(expression, options = {}) {
			const { strict = false, hashSeed } = options;
			const rand = (0, random_1.seededRandom)(hashSeed);
			expression = PredefinedExpressions[expression] || expression;
			const rawFields = CronExpressionParser.#getRawFields(expression, strict);
			if (!(rawFields.dayOfMonth === "*" || rawFields.dayOfWeek === "*" || !strict)) throw new Error("Cannot use both dayOfMonth and dayOfWeek together in strict mode!");
			const second = CronExpressionParser.#parseField(CronUnit.Second, rawFields.second, fields_1.CronSecond.constraints, rand);
			const minute = CronExpressionParser.#parseField(CronUnit.Minute, rawFields.minute, fields_1.CronMinute.constraints, rand);
			const hour = CronExpressionParser.#parseField(CronUnit.Hour, rawFields.hour, fields_1.CronHour.constraints, rand);
			const month = CronExpressionParser.#parseField(CronUnit.Month, rawFields.month, fields_1.CronMonth.constraints, rand);
			const dayOfMonth = CronExpressionParser.#parseField(CronUnit.DayOfMonth, rawFields.dayOfMonth, fields_1.CronDayOfMonth.constraints, rand);
			const { dayOfWeek: _dayOfWeek, nthDayOfWeek } = CronExpressionParser.#parseNthDay(rawFields.dayOfWeek);
			const dayOfWeek = CronExpressionParser.#parseField(CronUnit.DayOfWeek, _dayOfWeek, fields_1.CronDayOfWeek.constraints, rand);
			const fields = new CronFieldCollection_1.CronFieldCollection({
				second: new fields_1.CronSecond(second, { rawValue: rawFields.second }),
				minute: new fields_1.CronMinute(minute, { rawValue: rawFields.minute }),
				hour: new fields_1.CronHour(hour, { rawValue: rawFields.hour }),
				dayOfMonth: new fields_1.CronDayOfMonth(dayOfMonth, { rawValue: rawFields.dayOfMonth }),
				month: new fields_1.CronMonth(month, { rawValue: rawFields.month }),
				dayOfWeek: new fields_1.CronDayOfWeek(dayOfWeek, {
					rawValue: rawFields.dayOfWeek,
					nthDayOfWeek
				})
			});
			return new CronExpression_1.CronExpression(fields, {
				...options,
				expression
			});
		}
		/**
		* Get the raw fields from a cron expression.
		* @param {string} expression - The cron expression to parse.
		* @param {boolean} strict - If true, will throw an error if the expression contains both dayOfMonth and dayOfWeek.
		* @private
		* @returns {RawCronFields} The raw fields.
		*/
		static #getRawFields(expression, strict) {
			if (strict && !expression.length) throw new Error("Invalid cron expression");
			expression = expression || "0 * * * * *";
			const atoms = expression.trim().split(/\s+/);
			if (strict && atoms.length < 6) throw new Error("Invalid cron expression, expected 6 fields");
			if (atoms.length > 6) throw new Error("Invalid cron expression, too many fields");
			const defaults = [
				"*",
				"*",
				"*",
				"*",
				"*",
				"0"
			];
			if (atoms.length < defaults.length) atoms.unshift(...defaults.slice(atoms.length));
			const [second, minute, hour, dayOfMonth, month, dayOfWeek] = atoms;
			return {
				second,
				minute,
				hour,
				dayOfMonth,
				month,
				dayOfWeek
			};
		}
		/**
		* Parse a field from a cron expression.
		* @param {CronUnit} field - The field to parse.
		* @param {string} value - The value of the field.
		* @param {CronConstraints} constraints - The constraints for the field.
		* @private
		* @returns {(number | string)[]} The parsed field.
		*/
		static #parseField(field, value, constraints, rand) {
			if (field === CronUnit.Month || field === CronUnit.DayOfWeek) value = value.replace(/[a-z]{3}/gi, (match) => {
				match = match.toLowerCase();
				const replacer = Months[match] || DayOfWeek[match];
				if (replacer === void 0) throw new Error(`Validation error, cannot resolve alias "${match}"`);
				return replacer.toString();
			});
			if (!constraints.validChars.test(value)) throw new Error(`Invalid characters, got value: ${value}`);
			value = this.#parseWildcard(value, constraints);
			value = this.#parseHashed(value, constraints, rand);
			return this.#parseSequence(field, value, constraints);
		}
		/**
		* Parse a wildcard from a cron expression.
		* @param {string} value - The value to parse.
		* @param {CronConstraints} constraints - The constraints for the field.
		* @private
		*/
		static #parseWildcard(value, constraints) {
			return value.replace(/[*?]/g, constraints.min + "-" + constraints.max);
		}
		/**
		* Parse a hashed value from a cron expression.
		* @param {string} value - The value to parse.
		* @param {CronConstraints} constraints - The constraints for the field.
		* @param {PRNG} rand - The random number generator to use.
		* @private
		*/
		static #parseHashed(value, constraints, rand) {
			const randomValue = rand();
			return value.replace(/H(?:\((\d+)-(\d+)\))?(?:\/(\d+))?/g, (_, min, max, step) => {
				if (min && max && step) {
					const minNum = parseInt(min, 10);
					const maxNum = parseInt(max, 10);
					const stepNum = parseInt(step, 10);
					if (minNum > maxNum) throw new Error(`Invalid range: ${minNum}-${maxNum}, min > max`);
					if (stepNum <= 0) throw new Error(`Invalid step: ${stepNum}, must be positive`);
					const minStart = Math.max(minNum, constraints.min);
					const offset = Math.floor(randomValue * stepNum);
					const values = [];
					for (let i = Math.floor(minStart / stepNum) * stepNum + offset; i <= maxNum; i += stepNum) if (i >= minStart) values.push(i);
					return values.join(",");
				} else if (min && max) {
					const minNum = parseInt(min, 10);
					const maxNum = parseInt(max, 10);
					if (minNum > maxNum) throw new Error(`Invalid range: ${minNum}-${maxNum}, min > max`);
					return String(Math.floor(randomValue * (maxNum - minNum + 1)) + minNum);
				} else if (step) {
					const stepNum = parseInt(step, 10);
					if (stepNum <= 0) throw new Error(`Invalid step: ${stepNum}, must be positive`);
					const offset = Math.floor(randomValue * stepNum);
					const values = [];
					for (let i = Math.floor(constraints.min / stepNum) * stepNum + offset; i <= constraints.max; i += stepNum) if (i >= constraints.min) values.push(i);
					return values.join(",");
				} else return String(Math.floor(randomValue * (constraints.max - constraints.min + 1) + constraints.min));
			});
		}
		/**
		* Parse a sequence from a cron expression.
		* @param {CronUnit} field - The field to parse.
		* @param {string} val - The sequence to parse.
		* @param {CronConstraints} constraints - The constraints for the field.
		* @private
		*/
		static #parseSequence(field, val, constraints) {
			const stack = [];
			function handleResult(result, constraints) {
				if (Array.isArray(result)) stack.push(...result);
				else if (CronExpressionParser.#isValidConstraintChar(constraints, result)) stack.push(result);
				else {
					const v = parseInt(result.toString(), 10);
					if (!(v >= constraints.min && v <= constraints.max)) throw new Error(`Constraint error, got value ${result} expected range ${constraints.min}-${constraints.max}`);
					stack.push(field === CronUnit.DayOfWeek ? v % 7 : result);
				}
			}
			val.split(",").forEach((atom) => {
				if (!(atom.length > 0)) throw new Error("Invalid list value format");
				handleResult(CronExpressionParser.#parseRepeat(field, atom, constraints), constraints);
			});
			return stack;
		}
		/**
		* Parse repeat from a cron expression.
		* @param {CronUnit} field - The field to parse.
		* @param {string} val - The repeat to parse.
		* @param {CronConstraints} constraints - The constraints for the field.
		* @private
		* @returns {(number | string)[]} The parsed repeat.
		*/
		static #parseRepeat(field, val, constraints) {
			const atoms = val.split("/");
			if (atoms.length > 2) throw new Error(`Invalid repeat: ${val}`);
			if (atoms.length === 2) {
				if (!isNaN(parseInt(atoms[0], 10))) atoms[0] = `${atoms[0]}-${constraints.max}`;
				return CronExpressionParser.#parseRange(field, atoms[0], parseInt(atoms[1], 10), constraints);
			}
			return CronExpressionParser.#parseRange(field, val, 1, constraints);
		}
		/**
		* Validate a cron range.
		* @param {number} min - The minimum value of the range.
		* @param {number} max - The maximum value of the range.
		* @param {CronConstraints} constraints - The constraints for the field.
		* @private
		* @returns {void}
		* @throws {Error} Throws an error if the range is invalid.
		*/
		static #validateRange(min, max, constraints) {
			if (!(!isNaN(min) && !isNaN(max) && min >= constraints.min && max <= constraints.max)) throw new Error(`Constraint error, got range ${min}-${max} expected range ${constraints.min}-${constraints.max}`);
			if (min > max) throw new Error(`Invalid range: ${min}-${max}, min(${min}) > max(${max})`);
		}
		/**
		* Validate a cron repeat interval.
		* @param {number} repeatInterval - The repeat interval to validate.
		* @private
		* @returns {void}
		* @throws {Error} Throws an error if the repeat interval is invalid.
		*/
		static #validateRepeatInterval(repeatInterval) {
			if (!(!isNaN(repeatInterval) && repeatInterval > 0)) throw new Error(`Constraint error, cannot repeat at every ${repeatInterval} time.`);
		}
		/**
		* Create a range from a cron expression.
		* @param {CronUnit} field - The field to parse.
		* @param {number} min - The minimum value of the range.
		* @param {number} max - The maximum value of the range.
		* @param {number} repeatInterval - The repeat interval of the range.
		* @private
		* @returns {number[]} The created range.
		*/
		static #createRange(field, min, max, repeatInterval) {
			const stack = [];
			if (field === CronUnit.DayOfWeek && max % 7 === 0) stack.push(0);
			for (let index = min; index <= max; index += repeatInterval) if (stack.indexOf(index) === -1) stack.push(index);
			return stack;
		}
		/**
		* Parse a range from a cron expression.
		* @param {CronUnit} field - The field to parse.
		* @param {string} val - The range to parse.
		* @param {number} repeatInterval - The repeat interval of the range.
		* @param {CronConstraints} constraints - The constraints for the field.
		* @private
		* @returns {number[] | string[] | number | string} The parsed range.
		*/
		static #parseRange(field, val, repeatInterval, constraints) {
			const atoms = val.split("-");
			if (atoms.length <= 1) return isNaN(+val) ? val : +val;
			const [min, max] = atoms.map((num) => parseInt(num, 10));
			this.#validateRange(min, max, constraints);
			this.#validateRepeatInterval(repeatInterval);
			return this.#createRange(field, min, max, repeatInterval);
		}
		/**
		* Parse a cron expression.
		* @param {string} val - The cron expression to parse.
		* @private
		* @returns {string} The parsed cron expression.
		*/
		static #parseNthDay(val) {
			const atoms = val.split("#");
			if (atoms.length <= 1) return { dayOfWeek: atoms[0] };
			const nthValue = +atoms[atoms.length - 1];
			const matches = val.match(/([,-/])/);
			if (matches !== null) throw new Error(`Constraint error, invalid dayOfWeek \`#\` and \`${matches?.[0]}\` special characters are incompatible`);
			if (!(atoms.length <= 2 && !isNaN(nthValue) && nthValue >= 1 && nthValue <= 5)) throw new Error("Constraint error, invalid dayOfWeek occurrence number (#)");
			return {
				dayOfWeek: atoms[0],
				nthDayOfWeek: nthValue
			};
		}
		/**
		* Checks if a character is valid for a field.
		* @param {CronConstraints} constraints - The constraints for the field.
		* @param {string | number} value - The value to check.
		* @private
		* @returns {boolean} Whether the character is valid for the field.
		*/
		static #isValidConstraintChar(constraints, value) {
			return constraints.chars.some((char) => value.toString().includes(char));
		}
	};
	exports.CronExpressionParser = CronExpressionParser;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/CronFileParser.js
var require_CronFileParser = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronFileParser = void 0;
	const CronExpressionParser_1 = require_CronExpressionParser();
	/**
	* Parser for crontab files that handles both synchronous and asynchronous operations.
	*/
	var CronFileParser = class CronFileParser {
		/**
		* Parse a crontab file asynchronously
		* @param filePath Path to crontab file
		* @returns Promise resolving to parse results
		* @throws If file cannot be read
		*/
		static async parseFile(filePath) {
			const { readFile } = await Promise.resolve().then(() => __importStar(__require("fs/promises")));
			const data = await readFile(filePath, "utf8");
			return CronFileParser.#parseContent(data);
		}
		/**
		* Parse a crontab file synchronously
		* @param filePath Path to crontab file
		* @returns Parse results
		* @throws If file cannot be read
		*/
		static parseFileSync(filePath) {
			const { readFileSync } = __require("fs");
			const data = readFileSync(filePath, "utf8");
			return CronFileParser.#parseContent(data);
		}
		/**
		* Internal method to parse crontab file content
		* @private
		*/
		static #parseContent(data) {
			const blocks = data.split("\n");
			const result = {
				variables: {},
				expressions: [],
				errors: {}
			};
			for (const block of blocks) {
				const entry = block.trim();
				if (entry.length === 0 || entry.startsWith("#")) continue;
				const variableMatch = entry.match(/^(.*)=(.*)$/);
				if (variableMatch) {
					const [, key, value] = variableMatch;
					result.variables[key] = value.replace(/["']/g, "");
					continue;
				}
				try {
					const parsedEntry = CronFileParser.#parseEntry(entry);
					result.expressions.push(parsedEntry.interval);
				} catch (err) {
					result.errors[entry] = err;
				}
			}
			return result;
		}
		/**
		* Parse a single crontab entry
		* @private
		*/
		static #parseEntry(entry) {
			const atoms = entry.split(" ");
			return {
				interval: CronExpressionParser_1.CronExpressionParser.parse(atoms.slice(0, 5).join(" ")),
				command: atoms.slice(5, atoms.length)
			};
		}
	};
	exports.CronFileParser = CronFileParser;
}));

//#endregion
//#region node_modules/.bun/cron-parser@5.5.0/node_modules/cron-parser/dist/index.js
var require_dist = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$1) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$1, p)) __createBinding(exports$1, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CronFileParser = exports.CronExpressionParser = exports.CronExpression = exports.CronFieldCollection = exports.CronDate = void 0;
	/* istanbul ignore file */
	const CronExpressionParser_1 = require_CronExpressionParser();
	var CronDate_1 = require_CronDate();
	Object.defineProperty(exports, "CronDate", {
		enumerable: true,
		get: function() {
			return CronDate_1.CronDate;
		}
	});
	var CronFieldCollection_1 = require_CronFieldCollection();
	Object.defineProperty(exports, "CronFieldCollection", {
		enumerable: true,
		get: function() {
			return CronFieldCollection_1.CronFieldCollection;
		}
	});
	var CronExpression_1 = require_CronExpression();
	Object.defineProperty(exports, "CronExpression", {
		enumerable: true,
		get: function() {
			return CronExpression_1.CronExpression;
		}
	});
	var CronExpressionParser_2 = require_CronExpressionParser();
	Object.defineProperty(exports, "CronExpressionParser", {
		enumerable: true,
		get: function() {
			return CronExpressionParser_2.CronExpressionParser;
		}
	});
	var CronFileParser_1 = require_CronFileParser();
	Object.defineProperty(exports, "CronFileParser", {
		enumerable: true,
		get: function() {
			return CronFileParser_1.CronFileParser;
		}
	});
	__exportStar(require_fields(), exports);
	exports.default = CronExpressionParser_1.CronExpressionParser;
}));

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/heartbeat-utils.js
var import_dist = require_dist();
const DURATION_UNITS = [
	{
		unit: "seconds",
		ms: 1e3,
		labelKey: "heartbeatsview.durationUnitSeconds"
	},
	{
		unit: "minutes",
		ms: 6e4,
		labelKey: "heartbeatsview.durationUnitMinutes"
	},
	{
		unit: "hours",
		ms: 36e5,
		labelKey: "heartbeatsview.durationUnitHours"
	},
	{
		unit: "days",
		ms: 864e5,
		labelKey: "heartbeatsview.durationUnitDays"
	}
];
function bestFitUnit(ms) {
	for (let i = DURATION_UNITS.length - 1; i >= 0; i -= 1) {
		const unit = DURATION_UNITS[i];
		if (ms >= unit.ms && ms % unit.ms === 0) return {
			value: ms / unit.ms,
			unit: unit.unit
		};
	}
	return {
		value: ms / 1e3,
		unit: "seconds"
	};
}
function durationToMs(value, unit) {
	return value * (DURATION_UNITS.find((candidate) => candidate.unit === unit)?.ms ?? 1e3);
}
function durationUnitLabel(unit, t) {
	const found = DURATION_UNITS.find((candidate) => candidate.unit === unit);
	return found ? t(found.labelKey) : unit;
}
const emptyForm = {
	displayName: "",
	instructions: "",
	kind: "text",
	workflowId: "",
	workflowName: "",
	triggerType: "interval",
	eventKind: "message.received",
	wakeMode: "inject_now",
	scheduledAtIso: "",
	cronExpression: "0 * * * *",
	maxRuns: "",
	enabled: true,
	durationValue: "1",
	durationUnit: "hours"
};
const TEMPLATES_STORAGE_KEY = "elizaos:heartbeat-templates";
const BUILT_IN_TEMPLATES = [
	{
		id: "__builtin_crypto",
		name: "Check crypto prices",
		nameKey: "heartbeatsview.template.crypto.name",
		instructions: "Check the current prices of BTC, ETH, and SOL. Summarize any significant moves in the last hour.",
		instructionsKey: "heartbeatsview.template.crypto.instructions",
		interval: "30",
		unit: "minutes"
	},
	{
		id: "__builtin_journal",
		name: "Daily journal prompt",
		nameKey: "heartbeatsview.template.journal.name",
		instructions: "Write a brief, thoughtful journal prompt for the user based on current events or seasonal themes. Keep it under 2 sentences.",
		instructionsKey: "heartbeatsview.template.journal.instructions",
		interval: "24",
		unit: "hours"
	},
	{
		id: "__builtin_trending",
		name: "Trending topics digest",
		nameKey: "heartbeatsview.template.trending.name",
		instructions: "Scan for trending topics on crypto Twitter and tech news. Give a 3-bullet summary of what's worth paying attention to.",
		instructionsKey: "heartbeatsview.template.trending.instructions",
		interval: "4",
		unit: "hours"
	}
];
function isValidTemplate(v) {
	if (typeof v !== "object" || v == null) return false;
	const t = v;
	return typeof t.id === "string" && typeof t.name === "string" && typeof t.instructions === "string" && typeof t.interval === "string" && typeof t.unit === "string";
}
function loadUserTemplates() {
	try {
		const raw = localStorage.getItem(TEMPLATES_STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isValidTemplate);
	} catch {
		return [];
	}
}
function saveUserTemplates(templates) {
	try {
		localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
	} catch {}
}
function getTemplateName(template, t) {
	return template.nameKey ? t(template.nameKey, { defaultValue: template.name }) : template.name;
}
function getTemplateInstructions(template, t) {
	return template.instructionsKey ? t(template.instructionsKey, { defaultValue: template.instructions }) : template.instructions;
}
function railMonogram(label) {
	return (label.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("") || label.slice(0, 1).toUpperCase() || "?").slice(0, 2);
}
function parsePositiveInteger(value) {
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return void 0;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : void 0;
}
function scheduleLabel(trigger, t, locale) {
	if (trigger.triggerType === "interval") return `${t("heartbeatsview.every")} ${formatDurationMs(trigger.intervalMs, { t })}`;
	if (trigger.triggerType === "once") return trigger.scheduledAtIso ? t("heartbeatsview.onceAt", { time: formatDateTime(trigger.scheduledAtIso, { locale }) }) : t("heartbeatsview.once");
	if (trigger.triggerType === "cron") return `${t("heartbeatsview.cronPrefix")} ${trigger.cronExpression ?? "—"}`;
	if (trigger.triggerType === "event") return `On ${humanizeEventKind(trigger.eventKind ?? "event")}`;
	return trigger.triggerType;
}
function humanizeEventKind(value) {
	return value.trim().replace(/[_-]+/g, ".").split(".").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function formFromTrigger(trigger) {
	const { value, unit } = bestFitUnit(trigger.intervalMs ?? 36e5);
	return {
		displayName: trigger.displayName,
		instructions: trigger.instructions,
		kind: trigger.kind ?? "text",
		workflowId: trigger.workflowId ?? "",
		workflowName: trigger.workflowName ?? "",
		triggerType: trigger.triggerType,
		eventKind: trigger.eventKind ?? "message.received",
		wakeMode: trigger.wakeMode,
		scheduledAtIso: trigger.scheduledAtIso ?? "",
		cronExpression: trigger.cronExpression ?? "0 * * * *",
		maxRuns: trigger.maxRuns ? String(trigger.maxRuns) : "",
		enabled: trigger.enabled,
		durationValue: String(value),
		durationUnit: unit
	};
}
function buildCreateRequest(form) {
	const maxRuns = parsePositiveInteger(form.maxRuns);
	return {
		displayName: form.displayName.trim(),
		instructions: form.kind === "text" ? form.instructions.trim() : void 0,
		kind: form.kind,
		workflowId: form.kind === "workflow" ? form.workflowId : void 0,
		workflowName: form.kind === "workflow" ? form.workflowName || void 0 : void 0,
		triggerType: form.triggerType,
		wakeMode: form.wakeMode,
		enabled: form.enabled,
		intervalMs: form.triggerType === "interval" ? durationToMs(Number(form.durationValue) || 1, form.durationUnit) : void 0,
		scheduledAtIso: form.triggerType === "once" ? form.scheduledAtIso.trim() : void 0,
		cronExpression: form.triggerType === "cron" ? form.cronExpression.trim() : void 0,
		eventKind: form.triggerType === "event" ? form.eventKind.trim() : void 0,
		maxRuns
	};
}
function buildUpdateRequest(form) {
	return { ...buildCreateRequest(form) };
}
/**
* Validate a 5-field cron expression using cron-parser.
* Returns `{ ok: true, message: null }` on success or
* `{ ok: false, message: string }` with the parser error message on failure.
*/
function validateCronExpression(expr) {
	const trimmed = expr.trim();
	if (!trimmed) return {
		ok: false,
		message: "Expression is empty"
	};
	try {
		import_dist.CronExpressionParser.parse(trimmed);
		return {
			ok: true,
			message: null
		};
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err)
		};
	}
}
/**
* Compute the next N fire dates for an interval trigger (ms between fires).
* Returns an empty array when intervalMs is not positive.
*/
function nextRunsForInterval(intervalMs, count, from = /* @__PURE__ */ new Date()) {
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) return [];
	const results = [];
	for (let i = 1; i <= count; i++) results.push(new Date(from.getTime() + intervalMs * i));
	return results;
}
/**
* Compute the next N fire dates for a cron expression.
* Returns an empty array when parsing fails.
*/
function nextRunsForCron(expr, count, from = /* @__PURE__ */ new Date()) {
	const trimmed = expr.trim();
	if (!trimmed) return [];
	try {
		const schedule = import_dist.CronExpressionParser.parse(trimmed, { currentDate: from });
		const results = [];
		for (let i = 0; i < count; i++) results.push(schedule.next().toDate());
		return results;
	} catch {
		return [];
	}
}
/**
* Validates the kind-specific payload fields only (no schedule validation).
* Returns an error message when invalid, null when valid.
*/
function validateTriggerKind(form, t) {
	if (form.kind === "workflow") {
		if (!form.workflowId) return t("triggers.workflowPlaceholder");
		return null;
	}
	if (!form.instructions.trim()) return t("heartbeatsview.validationInstructionsRequired");
	return null;
}
function validateForm(form, t) {
	if (!form.displayName.trim()) return t("heartbeatsview.validationDisplayNameRequired");
	const kindError = validateTriggerKind(form, t);
	if (kindError) return kindError;
	if (form.triggerType === "interval") {
		const value = Number(form.durationValue);
		if (!Number.isFinite(value) || value <= 0) return t("heartbeatsview.validationIntervalPositive");
	}
	if (form.triggerType === "once") {
		const raw = form.scheduledAtIso.trim();
		if (!raw) return t("heartbeatsview.validationScheduledTimeRequired");
		if (!Number.isFinite(Date.parse(raw))) return t("heartbeatsview.validationScheduledTimeInvalid");
	}
	if (form.triggerType === "cron") {
		const cronTrimmed = form.cronExpression.trim();
		if (!cronTrimmed) return t("heartbeatsview.validationCronRequired");
		const cronResult = validateCronExpression(cronTrimmed);
		if (!cronResult.ok) return `${t("triggers.cronError")} ${cronResult.message}`;
	}
	if (form.triggerType === "event" && !form.eventKind.trim()) return "Event is required.";
	if (form.maxRuns.trim() && !parsePositiveInteger(form.maxRuns)) return t("heartbeatsview.validationMaxRunsPositive");
	return null;
}
function toneForLastStatus(status) {
	if (!status) return "muted";
	if (status === "success" || status === "completed") return "success";
	if (status === "skipped" || status === "queued") return "warning";
	if (status === "error" || status === "failed") return "danger";
	return "muted";
}
function localizedExecutionStatus(status, t) {
	switch (status) {
		case "success": return t("common.queued");
		case "completed": return t("common.completed");
		case "skipped": return t("heartbeatsview.statusSkipped");
		case "queued": return t("common.queued");
		case "error": return t("common.error");
		case "failed": return t("heartbeatsview.statusFailed");
		default: return status;
	}
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/HeartbeatForm.js
const EVENT_KIND_OPTIONS = [
	{
		value: "message.received",
		label: "Message received"
	},
	{
		value: "discord.message.received",
		label: "Discord message"
	},
	{
		value: "telegram.message.received",
		label: "Telegram message"
	},
	{
		value: "gmail.message.received",
		label: "Gmail message"
	},
	{
		value: "calendar.event.ended",
		label: "Calendar event ended"
	}
];
function HeartbeatForm({ form, editingId, editorEnabled, modalTitle, formError, triggersSaving, templateNotice, triggers, triggerRunsById, t, selectedTriggerId, setField, setForm, setFormError, closeEditor, onSubmit, onDelete, onRunSelectedTrigger, onToggleTriggerEnabled, saveFormAsTemplate, loadTriggerRuns, kickerLabelCreate, kickerLabelEdit, submitLabelCreate, submitLabelEdit }) {
	const cronInvalid = form.triggerType === "cron" && !validateCronExpression(form.cronExpression).ok;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "w-full px-4 pb-8 pt-0 sm:px-5 sm:pb-8 sm:pt-1 lg:px-7 lg:pb-8 lg:pt-1 xl:px-8",
		children: [
			templateNotice && (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
				tone: "accent",
				className: "mb-4 animate-[fadeIn_0.2s_ease] text-xs font-medium",
				children: templateNotice
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "mb-3 flex flex-col justify-between gap-2 lg:flex-row lg:items-start",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "max-w-3xl space-y-1",
					children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
						variant: "kicker",
						children: editingId ? kickerLabelEdit ?? t("heartbeatsview.editHeartbeat") : kickerLabelCreate ?? t("heartbeatsview.createHeartbeat")
					}), (0, import_jsx_runtime.jsx)("h2", {
						className: "text-2xl font-semibold text-txt",
						children: modalTitle
					})]
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "flex flex-wrap items-center gap-2 lg:justify-end",
					children: editingId && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
						(0, import_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							className: "h-9 px-3 text-xs",
							disabled: triggersSaving,
							onClick: () => void onRunSelectedTrigger(editingId),
							children: t("triggersview.RunNow")
						}),
						(0, import_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							className: "h-9 px-3 text-xs",
							onClick: () => void onToggleTriggerEnabled(editingId, editorEnabled),
							children: editorEnabled ? t("common.disable") : t("common.enable")
						}),
						(0, import_jsx_runtime.jsx)("div", { className: "w-px h-6 bg-border/50 mx-1 hidden sm:block" }),
						(0, import_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							className: "h-9 px-3 text-xs text-danger hover:border-danger hover:bg-danger/10 hover:text-danger",
							onClick: () => void onDelete(),
							children: t("common.delete")
						})
					] })
				})]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-6",
				children: [
					formError && (0, import_jsx_runtime.jsx)(PagePanel.Notice, {
						tone: "danger",
						className: "text-sm",
						children: formError
					}),
					(0, import_jsx_runtime.jsxs)(PagePanel, {
						variant: "padded",
						className: "grid gap-5",
						"data-testid": "heartbeats-editor-panel",
						children: [
							(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
								variant: "form",
								children: form.kind === "workflow" ? "Schedule name" : "Task name"
							}), (0, import_jsx_runtime.jsx)(Input, {
								variant: "form",
								value: form.displayName,
								onChange: (event) => setField("displayName", event.target.value),
								placeholder: t("triggersview.eGDailyDigestH")
							})] }),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "grid gap-4 rounded-xl border border-border/30 bg-bg/20 p-4",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "text-xs font-semibold uppercase tracking-[0.14em] text-muted",
									children: "What it does"
								}), (0, import_jsx_runtime.jsx)(TriggerKindSection, {
									form,
									setField,
									t,
									onGoToWorkflows: () => {
										window.dispatchEvent(new CustomEvent("eliza:automations:setFilter", { detail: { filter: "workflows" } }));
									}
								})]
							}),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "grid gap-4 rounded-xl border border-border/30 bg-bg/20 p-4",
								children: [
									(0, import_jsx_runtime.jsx)("div", {
										className: "text-xs font-semibold uppercase tracking-[0.14em] text-muted",
										children: "When it starts"
									}),
									(0, import_jsx_runtime.jsxs)("div", {
										className: "grid grid-cols-1 gap-5 lg:grid-cols-2",
										children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
											variant: "form",
											children: "Trigger type"
										}), (0, import_jsx_runtime.jsxs)(FormSelect, {
											value: form.triggerType,
											onValueChange: (value) => setField("triggerType", value),
											placeholder: "Repeating interval",
											children: [
												(0, import_jsx_runtime.jsx)(FormSelectItem, {
													value: "interval",
													children: "Repeating interval"
												}),
												(0, import_jsx_runtime.jsx)(FormSelectItem, {
													value: "once",
													children: "One time"
												}),
												(0, import_jsx_runtime.jsx)(FormSelectItem, {
													value: "cron",
													children: "Cron schedule"
												}),
												(0, import_jsx_runtime.jsx)(FormSelectItem, {
													value: "event",
													children: "Event"
												})
											]
										})] }), (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
											variant: "form",
											children: "When it fires"
										}), (0, import_jsx_runtime.jsxs)(FormSelect, {
											value: form.wakeMode,
											onValueChange: (value) => setField("wakeMode", value),
											placeholder: "Interrupt and run now",
											children: [(0, import_jsx_runtime.jsx)(FormSelectItem, {
												value: "inject_now",
												children: "Interrupt and run now"
											}), (0, import_jsx_runtime.jsx)(FormSelectItem, {
												value: "next_autonomy_cycle",
												children: "Queue for next cycle"
											})]
										})] })]
									}),
									form.triggerType === "interval" && (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
										variant: "form",
										children: "Repeat every"
									}), (0, import_jsx_runtime.jsxs)("div", {
										className: "grid grid-cols-[140px_minmax(0,1fr)] gap-3",
										children: [(0, import_jsx_runtime.jsx)(Input, {
											type: "number",
											min: "1",
											variant: "form",
											value: form.durationValue,
											onChange: (event) => setField("durationValue", event.target.value),
											placeholder: "1"
										}), (0, import_jsx_runtime.jsx)(FormSelect, {
											value: form.durationUnit,
											onValueChange: (value) => setField("durationUnit", value),
											placeholder: durationUnitLabel(form.durationUnit, t),
											children: DURATION_UNITS.map((unit) => (0, import_jsx_runtime.jsx)(FormSelectItem, {
												value: unit.unit,
												children: durationUnitLabel(unit.unit, t)
											}, unit.unit))
										})]
									})] }),
									form.triggerType === "once" && (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
										variant: "form",
										children: "Run at"
									}), (0, import_jsx_runtime.jsx)(Input, {
										type: "datetime-local",
										variant: "form",
										value: form.scheduledAtIso,
										onChange: (event) => setField("scheduledAtIso", event.target.value)
									})] }),
									form.triggerType === "cron" && (0, import_jsx_runtime.jsx)(CronInputSection, {
										form,
										setField,
										t
									}),
									form.triggerType === "event" && (0, import_jsx_runtime.jsx)(EventInputSection, {
										form,
										setField
									}),
									(0, import_jsx_runtime.jsx)(SchedulePreview, {
										form,
										t
									})
								]
							}),
							(0, import_jsx_runtime.jsxs)("div", {
								className: "grid gap-4 rounded-xl border border-border/30 bg-bg/20 p-4",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "text-xs font-semibold uppercase tracking-[0.14em] text-muted",
									children: "Run behavior"
								}), (0, import_jsx_runtime.jsxs)("div", {
									className: "grid grid-cols-1 gap-5 lg:grid-cols-2",
									children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
										variant: "form",
										children: "Stop after"
									}), (0, import_jsx_runtime.jsx)(Input, {
										variant: "form",
										value: form.maxRuns,
										onChange: (event) => setField("maxRuns", event.target.value),
										placeholder: "Unlimited"
									})] }), (0, import_jsx_runtime.jsx)("div", {
										className: "flex items-end",
										children: (0, import_jsx_runtime.jsx)(FieldSwitch, {
											checked: form.enabled,
											"aria-label": "Enabled",
											className: "flex-1",
											label: "Enabled",
											onCheckedChange: (checked) => setField("enabled", checked)
										})
									})]
								})]
							})
						]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
						children: [form.displayName.trim() && (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							className: "text-xs font-medium text-muted transition-colors hover:text-accent underline-offset-2 hover:underline",
							onClick: saveFormAsTemplate,
							children: t("heartbeatsview.SaveAsTemplate", { defaultValue: "Save as template" })
						}), (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-wrap items-center gap-2.5",
							children: [(0, import_jsx_runtime.jsx)(Button, {
								variant: "default",
								size: "sm",
								className: "h-10 px-6 text-sm text-white shadow-sm hover:text-white dark:text-white dark:hover:text-white",
								disabled: triggersSaving || form.kind === "workflow" && !form.workflowId || cronInvalid,
								onClick: () => void onSubmit(),
								children: triggersSaving ? t("common.saving") : editingId ? submitLabelEdit ?? t("heartbeatsview.saveChanges") : submitLabelCreate ?? t("heartbeatsview.createHeartbeat")
							}), (0, import_jsx_runtime.jsx)(Button, {
								variant: "outline",
								size: "sm",
								className: "h-10 px-6 text-sm",
								onClick: () => {
									if (editingId && selectedTriggerId === editingId) {
										const trigger = triggers.find((trigger) => trigger.id === editingId);
										if (trigger) {
											setForm(formFromTrigger(trigger));
											setFormError(null);
										}
									} else closeEditor();
								},
								children: t("common.cancel")
							})]
						})]
					}),
					editingId && (0, import_jsx_runtime.jsx)(HeartbeatRunHistory, {
						editingId,
						triggers,
						triggerRunsById,
						loadTriggerRuns,
						t
					})
				]
			})
		]
	});
}
function TriggerKindSection({ form, setField, t, onGoToWorkflows }) {
	const [workflows, setWorkflows] = useState([]);
	const [workflowsError, setWorkflowsError] = useState(null);
	const [workflowsLoading, setWorkflowsLoading] = useState(false);
	useEffect(() => {
		if (form.kind !== "workflow") return;
		let cancelled = false;
		setWorkflowsLoading(true);
		setWorkflowsError(null);
		client.listN8nWorkflows().then((list) => {
			if (cancelled) return;
			setWorkflows([...list].sort((a, b) => a.name.localeCompare(b.name)));
			setWorkflowsError(null);
		}).catch(() => {
			if (cancelled) return;
			setWorkflowsError("unavailable");
		}).finally(() => {
			if (!cancelled) setWorkflowsLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [form.kind]);
	return (0, import_jsx_runtime.jsxs)("div", { children: [
		(0, import_jsx_runtime.jsx)(FieldLabel, {
			variant: "form",
			id: "trigger-kind-toggle-label",
			children: "Runs"
		}),
		(0, import_jsx_runtime.jsxs)("div", {
			className: "mt-1.5 flex gap-2",
			children: [(0, import_jsx_runtime.jsx)("button", {
				type: "button",
				"aria-pressed": form.kind === "text",
				onClick: () => setField("kind", "text"),
				className: `rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${form.kind === "text" ? "border-accent bg-accent/10 text-accent" : "border-border/40 text-muted hover:border-border hover:text-txt"}`,
				children: "Prompt"
			}), (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				"aria-pressed": form.kind === "workflow",
				onClick: () => setField("kind", "workflow"),
				className: `rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${form.kind === "workflow" ? "border-accent bg-accent/10 text-accent" : "border-border/40 text-muted hover:border-border hover:text-txt"}`,
				children: "Workflow"
			})]
		}),
		form.kind === "text" && (0, import_jsx_runtime.jsxs)("div", {
			className: "mt-4",
			children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
				variant: "form",
				children: "Prompt"
			}), (0, import_jsx_runtime.jsx)(Textarea, {
				variant: "form",
				value: form.instructions,
				onChange: (event) => setField("instructions", event.target.value),
				placeholder: t("triggersview.WhatShouldTheAgen")
			})]
		}),
		form.kind === "workflow" && (0, import_jsx_runtime.jsx)("div", {
			className: "mt-4",
			children: workflowsError === "unavailable" || !workflowsLoading && workflows.length === 0 ? (0, import_jsx_runtime.jsxs)("div", {
				role: "status",
				className: "rounded-lg border border-border/30 bg-bg/30 px-4 py-3 text-sm text-muted",
				children: [(0, import_jsx_runtime.jsx)("p", { children: t("triggers.workflowUnavailable") }), (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					className: "mt-2 text-xs font-medium text-accent underline-offset-2 hover:underline",
					onClick: onGoToWorkflows,
					children: t("triggers.goToWorkflows")
				})]
			}) : (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
				variant: "form",
				htmlFor: "trigger-workflow-select",
				children: "Workflow"
			}), (0, import_jsx_runtime.jsx)(FormSelect, {
				value: form.workflowId,
				onValueChange: (value) => {
					const wf = workflows.find((w) => w.id === value);
					setField("workflowId", value);
					setField("workflowName", wf?.name ?? "");
				},
				placeholder: workflowsLoading ? t("appsview.Loading") : t("triggers.workflowPlaceholder"),
				children: workflows.map((wf) => (0, import_jsx_runtime.jsx)(FormSelectItem, {
					value: wf.id,
					children: wf.name
				}, wf.id))
			})] })
		})
	] });
}
const CRON_EXAMPLES = [
	{
		expr: "0 9 * * 1-5",
		labelKey: "triggers.cronExample.weekdaysNine"
	},
	{
		expr: "*/15 * * * *",
		labelKey: "triggers.cronExample.every15min"
	},
	{
		expr: "0 0 1 * *",
		labelKey: "triggers.cronExample.monthly"
	}
];
function CronInputSection({ form, setField, t }) {
	const cronErrorId = "cron-expression-error";
	const validationResult = validateCronExpression(form.cronExpression);
	const isInvalid = !validationResult.ok;
	return (0, import_jsx_runtime.jsxs)("div", { children: [
		(0, import_jsx_runtime.jsx)(FieldLabel, {
			variant: "form",
			children: "Cron schedule"
		}),
		(0, import_jsx_runtime.jsx)(Input, {
			variant: "form",
			className: "font-mono",
			value: form.cronExpression,
			onChange: (event) => setField("cronExpression", event.target.value),
			placeholder: "*/15 * * * *",
			"aria-invalid": isInvalid,
			"aria-describedby": isInvalid ? cronErrorId : void 0
		}),
		isInvalid ? (0, import_jsx_runtime.jsxs)("p", {
			id: cronErrorId,
			className: "mt-1.5 text-xs font-medium text-danger",
			role: "alert",
			children: [
				t("triggers.cronError"),
				" ",
				validationResult.message
			]
		}) : (0, import_jsx_runtime.jsx)("div", {
			className: "mt-2 text-xs-tight text-muted",
			children: "minute hour day month weekday"
		}),
		(0, import_jsx_runtime.jsxs)("div", {
			className: "mt-2 flex flex-wrap items-center gap-1.5",
			children: [(0, import_jsx_runtime.jsx)("span", {
				className: "text-xs text-muted",
				children: t("triggers.cronExampleHint")
			}), CRON_EXAMPLES.map(({ expr, labelKey }) => (0, import_jsx_runtime.jsx)(Button, {
				variant: "outline",
				size: "sm",
				className: "h-6 px-2 py-0 text-xs font-mono",
				onClick: () => setField("cronExpression", expr),
				children: t(labelKey)
			}, expr))]
		})
	] });
}
function EventInputSection({ form, setField }) {
	const isCustomEvent = !EVENT_KIND_OPTIONS.some((option) => option.value === form.eventKind);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "grid gap-3",
		children: [
			(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
				variant: "form",
				children: "Event"
			}), (0, import_jsx_runtime.jsxs)(FormSelect, {
				value: isCustomEvent ? "__custom" : form.eventKind,
				onValueChange: (value) => {
					if (value === "__custom") {
						setField("eventKind", "");
						return;
					}
					setField("eventKind", value);
				},
				placeholder: "Message received",
				children: [EVENT_KIND_OPTIONS.map((option) => (0, import_jsx_runtime.jsx)(FormSelectItem, {
					value: option.value,
					children: option.label
				}, option.value)), (0, import_jsx_runtime.jsx)(FormSelectItem, {
					value: "__custom",
					children: "Custom event"
				})]
			})] }),
			isCustomEvent && (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, {
				variant: "form",
				children: "Event name"
			}), (0, import_jsx_runtime.jsx)(Input, {
				variant: "form",
				className: "font-mono",
				value: form.eventKind,
				onChange: (event) => setField("eventKind", event.target.value),
				placeholder: "namespace.subject.verb"
			})] }),
			form.eventKind.trim() && (0, import_jsx_runtime.jsxs)("div", {
				className: "rounded-lg border border-border/30 bg-bg/30 px-4 py-3 text-xs text-muted",
				children: [
					"Runs when",
					" ",
					(0, import_jsx_runtime.jsx)("span", {
						className: "font-medium text-txt",
						children: humanizeEventKind(form.eventKind)
					}),
					" ",
					"arrives."
				]
			})
		]
	});
}
function SchedulePreview({ form, t }) {
	const preview = useMemo(() => {
		const now = /* @__PURE__ */ new Date();
		if (form.triggerType === "interval") {
			const value = Number(form.durationValue);
			if (!Number.isFinite(value) || value <= 0) return {
				kind: "error",
				message: t("triggers.scheduleIntervalError")
			};
			return {
				kind: "dates",
				dates: nextRunsForInterval(durationToMs(value, form.durationUnit), 3, now)
			};
		}
		if (form.triggerType === "once") {
			const raw = form.scheduledAtIso.trim();
			if (!raw || !Number.isFinite(Date.parse(raw))) return null;
			const date = new Date(raw);
			return {
				kind: "once",
				date,
				isPast: date.getTime() <= now.getTime()
			};
		}
		if (form.triggerType === "cron") {
			if (!validateCronExpression(form.cronExpression).ok) return null;
			const dates = nextRunsForCron(form.cronExpression, 3, now);
			if (dates.length === 0) return null;
			return {
				kind: "dates",
				dates
			};
		}
		if (form.triggerType === "event") return {
			kind: "event",
			label: humanizeEventKind(form.eventKind || "event")
		};
		return null;
	}, [
		form.triggerType,
		form.durationValue,
		form.durationUnit,
		form.scheduledAtIso,
		form.cronExpression,
		form.eventKind,
		t
	]);
	if (!preview) return null;
	return (0, import_jsx_runtime.jsx)("div", {
		role: "status",
		"aria-live": "polite",
		className: "rounded-lg border border-border/30 bg-bg/30 px-4 py-3 text-sm",
		children: preview.kind === "error" ? (0, import_jsx_runtime.jsx)("p", {
			className: "text-xs font-medium text-danger",
			children: preview.message
		}) : preview.kind === "once" ? (0, import_jsx_runtime.jsxs)("div", { children: [preview.isPast && (0, import_jsx_runtime.jsx)("p", {
			className: "mb-1 text-xs font-medium text-warning",
			children: t("triggers.scheduleOnceInPast")
		}), (0, import_jsx_runtime.jsx)("p", {
			className: "text-xs text-muted",
			children: t("triggers.scheduleOnceLabel", { time: formatDateTime(preview.date) })
		})] }) : preview.kind === "event" ? (0, import_jsx_runtime.jsxs)("p", {
			className: "text-xs text-muted",
			children: [
				"Waiting for",
				" ",
				(0, import_jsx_runtime.jsx)("span", {
					className: "font-medium text-txt",
					children: preview.label
				}),
				"."
			]
		}) : (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)("p", {
			className: "mb-1 text-xs font-semibold uppercase tracking-wide text-muted",
			children: "Next runs"
		}), (0, import_jsx_runtime.jsx)("ul", {
			className: "space-y-0.5",
			children: preview.dates.map((date) => (0, import_jsx_runtime.jsx)("li", {
				className: "text-xs text-txt/80 before:mr-1.5 before:content-['•']",
				children: formatDateTime(date)
			}, date.getTime()))
		})] })
	});
}
function HeartbeatRunHistory({ editingId, triggers, triggerRunsById, loadTriggerRuns, t }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "mt-10 grid gap-8 pt-8",
		children: [(0, import_jsx_runtime.jsxs)("dl", {
			className: "grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3",
			children: [
				(0, import_jsx_runtime.jsxs)(PagePanel.SummaryCard, {
					className: "px-4 py-4",
					children: [(0, import_jsx_runtime.jsx)("dt", {
						className: "text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted",
						children: t("heartbeatsview.maxRuns")
					}), (0, import_jsx_runtime.jsx)("dd", {
						className: "mt-1.5 text-txt font-medium",
						children: (() => {
							const trigger = triggers.find((trigger) => trigger.id === editingId);
							return trigger?.maxRuns ? trigger.maxRuns : t("heartbeatsview.unlimited");
						})()
					})]
				}),
				(0, import_jsx_runtime.jsxs)(PagePanel.SummaryCard, {
					className: "px-4 py-4",
					children: [(0, import_jsx_runtime.jsx)("dt", {
						className: "text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted",
						children: t("triggersview.LastRun")
					}), (0, import_jsx_runtime.jsx)("dd", {
						className: "mt-1.5 text-txt font-medium",
						children: formatDateTime(triggers.find((trigger) => trigger.id === editingId)?.lastRunAtIso, { fallback: t("heartbeatsview.notYetRun") })
					})]
				}),
				(0, import_jsx_runtime.jsxs)(PagePanel.SummaryCard, {
					className: "px-4 py-4",
					children: [(0, import_jsx_runtime.jsx)("dt", {
						className: "text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted",
						children: t("heartbeatsview.nextRun")
					}), (0, import_jsx_runtime.jsx)("dd", {
						className: "mt-1.5 text-txt font-medium",
						children: formatDateTime(triggers.find((trigger) => trigger.id === editingId)?.nextRunAtMs, { fallback: t("heartbeatsview.notScheduled") })
					})]
				})
			]
		}), (0, import_jsx_runtime.jsxs)(PagePanel, {
			variant: "padded",
			className: "space-y-4",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-3 pb-3",
				children: [(0, import_jsx_runtime.jsx)("div", {
					className: "text-xs font-semibold uppercase tracking-[0.14em] text-muted",
					children: t("triggersview.RunHistory")
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "sm",
					className: "h-7 px-3 text-xs-tight",
					onClick: () => void loadTriggerRuns(editingId),
					children: t("common.refresh")
				})]
			}), (() => {
				const hasLoadedRuns = Object.hasOwn(triggerRunsById, editingId);
				const runs = triggerRunsById[editingId] ?? [];
				if (!hasLoadedRuns) return (0, import_jsx_runtime.jsxs)("div", {
					className: "py-6 text-sm text-muted/70 flex items-center gap-2",
					children: [
						(0, import_jsx_runtime.jsx)("div", { className: "w-4 h-4 border-2 border-muted/30 border-t-muted/80 rounded-full animate-spin" }),
						" ",
						t("appsview.Loading")
					]
				});
				if (runs.length === 0) return (0, import_jsx_runtime.jsx)("div", {
					className: "py-6 text-sm text-muted/70 italic",
					children: t("triggersview.NoRunsRecordedYet")
				});
				return (0, import_jsx_runtime.jsx)("div", {
					className: "space-y-3",
					children: runs.slice().reverse().map((run) => (0, import_jsx_runtime.jsx)("div", {
						className: "rounded-xl bg-bg/30 border border-border/20 px-4 py-3 text-sm transition-colors hover:bg-bg/50",
						children: (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-start gap-3",
							children: [(0, import_jsx_runtime.jsx)(StatusDot, {
								status: run.status,
								className: "mt-1 flex-shrink-0"
							}), (0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 flex-1",
								children: [
									(0, import_jsx_runtime.jsxs)("div", {
										className: "flex flex-wrap items-center justify-between gap-2 mb-1",
										children: [(0, import_jsx_runtime.jsx)("span", {
											className: "font-medium text-txt",
											children: localizedExecutionStatus(run.status, t)
										}), (0, import_jsx_runtime.jsx)("span", {
											className: "text-xs text-muted",
											children: formatDateTime(run.finishedAt, { fallback: t("heartbeatsview.emDash") })
										})]
									}),
									(0, import_jsx_runtime.jsxs)("div", {
										className: "text-xs-tight text-muted/80",
										children: [
											formatDurationMs(run.latencyMs),
											" ·",
											" ",
											(0, import_jsx_runtime.jsx)("span", {
												className: "font-mono text-muted/60 bg-bg/40 px-1 py-0.5 rounded",
												children: run.source
											})
										]
									}),
									run.error && (0, import_jsx_runtime.jsx)("div", {
										className: "mt-2.5 text-xs text-danger/90 bg-danger/10 border border-danger/20 p-2.5 rounded-lg whitespace-pre-wrap font-mono leading-relaxed",
										children: run.error
									})
								]
							})]
						})
					}, run.triggerRunId))
				});
			})()]
		})]
	});
}

//#endregion
//#region node_modules/.bun/classcat@5.0.5/node_modules/classcat/index.js
function cc(names) {
	if (typeof names === "string" || typeof names === "number") return "" + names;
	let out = "";
	if (Array.isArray(names)) {
		for (let i = 0, tmp; i < names.length; i++) if ((tmp = cc(names[i])) !== "") out += (out && " ") + tmp;
	} else for (let k in names) if (names[k]) out += (out && " ") + k;
	return out;
}

//#endregion
//#region node_modules/.bun/d3-dispatch@3.0.1/node_modules/d3-dispatch/src/dispatch.js
var noop = { value: () => {} };
function dispatch() {
	for (var i = 0, n = arguments.length, _ = {}, t; i < n; ++i) {
		if (!(t = arguments[i] + "") || t in _ || /[\s.]/.test(t)) throw new Error("illegal type: " + t);
		_[t] = [];
	}
	return new Dispatch(_);
}
function Dispatch(_) {
	this._ = _;
}
function parseTypenames$1(typenames, types) {
	return typenames.trim().split(/^|\s+/).map(function(t) {
		var name = "", i = t.indexOf(".");
		if (i >= 0) name = t.slice(i + 1), t = t.slice(0, i);
		if (t && !types.hasOwnProperty(t)) throw new Error("unknown type: " + t);
		return {
			type: t,
			name
		};
	});
}
Dispatch.prototype = dispatch.prototype = {
	constructor: Dispatch,
	on: function(typename, callback) {
		var _ = this._, T = parseTypenames$1(typename + "", _), t, i = -1, n = T.length;
		if (arguments.length < 2) {
			while (++i < n) if ((t = (typename = T[i]).type) && (t = get$1(_[t], typename.name))) return t;
			return;
		}
		if (callback != null && typeof callback !== "function") throw new Error("invalid callback: " + callback);
		while (++i < n) if (t = (typename = T[i]).type) _[t] = set$1(_[t], typename.name, callback);
		else if (callback == null) for (t in _) _[t] = set$1(_[t], typename.name, null);
		return this;
	},
	copy: function() {
		var copy = {}, _ = this._;
		for (var t in _) copy[t] = _[t].slice();
		return new Dispatch(copy);
	},
	call: function(type, that) {
		if ((n = arguments.length - 2) > 0) for (var args = new Array(n), i = 0, n, t; i < n; ++i) args[i] = arguments[i + 2];
		if (!this._.hasOwnProperty(type)) throw new Error("unknown type: " + type);
		for (t = this._[type], i = 0, n = t.length; i < n; ++i) t[i].value.apply(that, args);
	},
	apply: function(type, that, args) {
		if (!this._.hasOwnProperty(type)) throw new Error("unknown type: " + type);
		for (var t = this._[type], i = 0, n = t.length; i < n; ++i) t[i].value.apply(that, args);
	}
};
function get$1(type, name) {
	for (var i = 0, n = type.length, c; i < n; ++i) if ((c = type[i]).name === name) return c.value;
}
function set$1(type, name, callback) {
	for (var i = 0, n = type.length; i < n; ++i) if (type[i].name === name) {
		type[i] = noop, type = type.slice(0, i).concat(type.slice(i + 1));
		break;
	}
	if (callback != null) type.push({
		name,
		value: callback
	});
	return type;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/namespaces.js
var xhtml = "http://www.w3.org/1999/xhtml";
var namespaces_default = {
	svg: "http://www.w3.org/2000/svg",
	xhtml,
	xlink: "http://www.w3.org/1999/xlink",
	xml: "http://www.w3.org/XML/1998/namespace",
	xmlns: "http://www.w3.org/2000/xmlns/"
};

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/namespace.js
function namespace_default(name) {
	var prefix = name += "", i = prefix.indexOf(":");
	if (i >= 0 && (prefix = name.slice(0, i)) !== "xmlns") name = name.slice(i + 1);
	return namespaces_default.hasOwnProperty(prefix) ? {
		space: namespaces_default[prefix],
		local: name
	} : name;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/creator.js
function creatorInherit(name) {
	return function() {
		var document = this.ownerDocument, uri = this.namespaceURI;
		return uri === xhtml && document.documentElement.namespaceURI === xhtml ? document.createElement(name) : document.createElementNS(uri, name);
	};
}
function creatorFixed(fullname) {
	return function() {
		return this.ownerDocument.createElementNS(fullname.space, fullname.local);
	};
}
function creator_default(name) {
	var fullname = namespace_default(name);
	return (fullname.local ? creatorFixed : creatorInherit)(fullname);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selector.js
function none() {}
function selector_default(selector) {
	return selector == null ? none : function() {
		return this.querySelector(selector);
	};
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/select.js
function select_default$2(select) {
	if (typeof select !== "function") select = selector_default(select);
	for (var groups = this._groups, m = groups.length, subgroups = new Array(m), j = 0; j < m; ++j) for (var group = groups[j], n = group.length, subgroup = subgroups[j] = new Array(n), node, subnode, i = 0; i < n; ++i) if ((node = group[i]) && (subnode = select.call(node, node.__data__, i, group))) {
		if ("__data__" in node) subnode.__data__ = node.__data__;
		subgroup[i] = subnode;
	}
	return new Selection$1(subgroups, this._parents);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/array.js
function array(x) {
	return x == null ? [] : Array.isArray(x) ? x : Array.from(x);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selectorAll.js
function empty() {
	return [];
}
function selectorAll_default(selector) {
	return selector == null ? empty : function() {
		return this.querySelectorAll(selector);
	};
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/selectAll.js
function arrayAll(select) {
	return function() {
		return array(select.apply(this, arguments));
	};
}
function selectAll_default$1(select) {
	if (typeof select === "function") select = arrayAll(select);
	else select = selectorAll_default(select);
	for (var groups = this._groups, m = groups.length, subgroups = [], parents = [], j = 0; j < m; ++j) for (var group = groups[j], n = group.length, node, i = 0; i < n; ++i) if (node = group[i]) {
		subgroups.push(select.call(node, node.__data__, i, group));
		parents.push(node);
	}
	return new Selection$1(subgroups, parents);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/matcher.js
function matcher_default(selector) {
	return function() {
		return this.matches(selector);
	};
}
function childMatcher(selector) {
	return function(node) {
		return node.matches(selector);
	};
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/selectChild.js
var find = Array.prototype.find;
function childFind(match) {
	return function() {
		return find.call(this.children, match);
	};
}
function childFirst() {
	return this.firstElementChild;
}
function selectChild_default(match) {
	return this.select(match == null ? childFirst : childFind(typeof match === "function" ? match : childMatcher(match)));
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/selectChildren.js
var filter = Array.prototype.filter;
function children() {
	return Array.from(this.children);
}
function childrenFilter(match) {
	return function() {
		return filter.call(this.children, match);
	};
}
function selectChildren_default(match) {
	return this.selectAll(match == null ? children : childrenFilter(typeof match === "function" ? match : childMatcher(match)));
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/filter.js
function filter_default$1(match) {
	if (typeof match !== "function") match = matcher_default(match);
	for (var groups = this._groups, m = groups.length, subgroups = new Array(m), j = 0; j < m; ++j) for (var group = groups[j], n = group.length, subgroup = subgroups[j] = [], node, i = 0; i < n; ++i) if ((node = group[i]) && match.call(node, node.__data__, i, group)) subgroup.push(node);
	return new Selection$1(subgroups, this._parents);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/sparse.js
function sparse_default(update) {
	return new Array(update.length);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/enter.js
function enter_default() {
	return new Selection$1(this._enter || this._groups.map(sparse_default), this._parents);
}
function EnterNode(parent, datum) {
	this.ownerDocument = parent.ownerDocument;
	this.namespaceURI = parent.namespaceURI;
	this._next = null;
	this._parent = parent;
	this.__data__ = datum;
}
EnterNode.prototype = {
	constructor: EnterNode,
	appendChild: function(child) {
		return this._parent.insertBefore(child, this._next);
	},
	insertBefore: function(child, next) {
		return this._parent.insertBefore(child, next);
	},
	querySelector: function(selector) {
		return this._parent.querySelector(selector);
	},
	querySelectorAll: function(selector) {
		return this._parent.querySelectorAll(selector);
	}
};

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/constant.js
function constant_default$3(x) {
	return function() {
		return x;
	};
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/data.js
function bindIndex(parent, group, enter, update, exit, data) {
	var i = 0, node, groupLength = group.length, dataLength = data.length;
	for (; i < dataLength; ++i) if (node = group[i]) {
		node.__data__ = data[i];
		update[i] = node;
	} else enter[i] = new EnterNode(parent, data[i]);
	for (; i < groupLength; ++i) if (node = group[i]) exit[i] = node;
}
function bindKey(parent, group, enter, update, exit, data, key) {
	var i, node, nodeByKeyValue = /* @__PURE__ */ new Map(), groupLength = group.length, dataLength = data.length, keyValues = new Array(groupLength), keyValue;
	for (i = 0; i < groupLength; ++i) if (node = group[i]) {
		keyValues[i] = keyValue = key.call(node, node.__data__, i, group) + "";
		if (nodeByKeyValue.has(keyValue)) exit[i] = node;
		else nodeByKeyValue.set(keyValue, node);
	}
	for (i = 0; i < dataLength; ++i) {
		keyValue = key.call(parent, data[i], i, data) + "";
		if (node = nodeByKeyValue.get(keyValue)) {
			update[i] = node;
			node.__data__ = data[i];
			nodeByKeyValue.delete(keyValue);
		} else enter[i] = new EnterNode(parent, data[i]);
	}
	for (i = 0; i < groupLength; ++i) if ((node = group[i]) && nodeByKeyValue.get(keyValues[i]) === node) exit[i] = node;
}
function datum(node) {
	return node.__data__;
}
function data_default(value, key) {
	if (!arguments.length) return Array.from(this, datum);
	var bind = key ? bindKey : bindIndex, parents = this._parents, groups = this._groups;
	if (typeof value !== "function") value = constant_default$3(value);
	for (var m = groups.length, update = new Array(m), enter = new Array(m), exit = new Array(m), j = 0; j < m; ++j) {
		var parent = parents[j], group = groups[j], groupLength = group.length, data = arraylike(value.call(parent, parent && parent.__data__, j, parents)), dataLength = data.length, enterGroup = enter[j] = new Array(dataLength), updateGroup = update[j] = new Array(dataLength);
		bind(parent, group, enterGroup, updateGroup, exit[j] = new Array(groupLength), data, key);
		for (var i0 = 0, i1 = 0, previous, next; i0 < dataLength; ++i0) if (previous = enterGroup[i0]) {
			if (i0 >= i1) i1 = i0 + 1;
			while (!(next = updateGroup[i1]) && ++i1 < dataLength);
			previous._next = next || null;
		}
	}
	update = new Selection$1(update, parents);
	update._enter = enter;
	update._exit = exit;
	return update;
}
function arraylike(data) {
	return typeof data === "object" && "length" in data ? data : Array.from(data);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/exit.js
function exit_default() {
	return new Selection$1(this._exit || this._groups.map(sparse_default), this._parents);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/join.js
function join_default(onenter, onupdate, onexit) {
	var enter = this.enter(), update = this, exit = this.exit();
	if (typeof onenter === "function") {
		enter = onenter(enter);
		if (enter) enter = enter.selection();
	} else enter = enter.append(onenter + "");
	if (onupdate != null) {
		update = onupdate(update);
		if (update) update = update.selection();
	}
	if (onexit == null) exit.remove();
	else onexit(exit);
	return enter && update ? enter.merge(update).order() : update;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/merge.js
function merge_default$1(context) {
	var selection = context.selection ? context.selection() : context;
	for (var groups0 = this._groups, groups1 = selection._groups, m0 = groups0.length, m1 = groups1.length, m = Math.min(m0, m1), merges = new Array(m0), j = 0; j < m; ++j) for (var group0 = groups0[j], group1 = groups1[j], n = group0.length, merge = merges[j] = new Array(n), node, i = 0; i < n; ++i) if (node = group0[i] || group1[i]) merge[i] = node;
	for (; j < m0; ++j) merges[j] = groups0[j];
	return new Selection$1(merges, this._parents);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/order.js
function order_default() {
	for (var groups = this._groups, j = -1, m = groups.length; ++j < m;) for (var group = groups[j], i = group.length - 1, next = group[i], node; --i >= 0;) if (node = group[i]) {
		if (next && node.compareDocumentPosition(next) ^ 4) next.parentNode.insertBefore(node, next);
		next = node;
	}
	return this;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/sort.js
function sort_default(compare) {
	if (!compare) compare = ascending;
	function compareNode(a, b) {
		return a && b ? compare(a.__data__, b.__data__) : !a - !b;
	}
	for (var groups = this._groups, m = groups.length, sortgroups = new Array(m), j = 0; j < m; ++j) {
		for (var group = groups[j], n = group.length, sortgroup = sortgroups[j] = new Array(n), node, i = 0; i < n; ++i) if (node = group[i]) sortgroup[i] = node;
		sortgroup.sort(compareNode);
	}
	return new Selection$1(sortgroups, this._parents).order();
}
function ascending(a, b) {
	return a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/call.js
function call_default() {
	var callback = arguments[0];
	arguments[0] = this;
	callback.apply(null, arguments);
	return this;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/nodes.js
function nodes_default() {
	return Array.from(this);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/node.js
function node_default() {
	for (var groups = this._groups, j = 0, m = groups.length; j < m; ++j) for (var group = groups[j], i = 0, n = group.length; i < n; ++i) {
		var node = group[i];
		if (node) return node;
	}
	return null;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/size.js
function size_default() {
	let size = 0;
	for (const node of this) ++size;
	return size;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/empty.js
function empty_default() {
	return !this.node();
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/each.js
function each_default(callback) {
	for (var groups = this._groups, j = 0, m = groups.length; j < m; ++j) for (var group = groups[j], i = 0, n = group.length, node; i < n; ++i) if (node = group[i]) callback.call(node, node.__data__, i, group);
	return this;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/attr.js
function attrRemove$1(name) {
	return function() {
		this.removeAttribute(name);
	};
}
function attrRemoveNS$1(fullname) {
	return function() {
		this.removeAttributeNS(fullname.space, fullname.local);
	};
}
function attrConstant$1(name, value) {
	return function() {
		this.setAttribute(name, value);
	};
}
function attrConstantNS$1(fullname, value) {
	return function() {
		this.setAttributeNS(fullname.space, fullname.local, value);
	};
}
function attrFunction$1(name, value) {
	return function() {
		var v = value.apply(this, arguments);
		if (v == null) this.removeAttribute(name);
		else this.setAttribute(name, v);
	};
}
function attrFunctionNS$1(fullname, value) {
	return function() {
		var v = value.apply(this, arguments);
		if (v == null) this.removeAttributeNS(fullname.space, fullname.local);
		else this.setAttributeNS(fullname.space, fullname.local, v);
	};
}
function attr_default$1(name, value) {
	var fullname = namespace_default(name);
	if (arguments.length < 2) {
		var node = this.node();
		return fullname.local ? node.getAttributeNS(fullname.space, fullname.local) : node.getAttribute(fullname);
	}
	return this.each((value == null ? fullname.local ? attrRemoveNS$1 : attrRemove$1 : typeof value === "function" ? fullname.local ? attrFunctionNS$1 : attrFunction$1 : fullname.local ? attrConstantNS$1 : attrConstant$1)(fullname, value));
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/window.js
function window_default(node) {
	return node.ownerDocument && node.ownerDocument.defaultView || node.document && node || node.defaultView;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/style.js
function styleRemove$1(name) {
	return function() {
		this.style.removeProperty(name);
	};
}
function styleConstant$1(name, value, priority) {
	return function() {
		this.style.setProperty(name, value, priority);
	};
}
function styleFunction$1(name, value, priority) {
	return function() {
		var v = value.apply(this, arguments);
		if (v == null) this.style.removeProperty(name);
		else this.style.setProperty(name, v, priority);
	};
}
function style_default$1(name, value, priority) {
	return arguments.length > 1 ? this.each((value == null ? styleRemove$1 : typeof value === "function" ? styleFunction$1 : styleConstant$1)(name, value, priority == null ? "" : priority)) : styleValue(this.node(), name);
}
function styleValue(node, name) {
	return node.style.getPropertyValue(name) || window_default(node).getComputedStyle(node, null).getPropertyValue(name);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/property.js
function propertyRemove(name) {
	return function() {
		delete this[name];
	};
}
function propertyConstant(name, value) {
	return function() {
		this[name] = value;
	};
}
function propertyFunction(name, value) {
	return function() {
		var v = value.apply(this, arguments);
		if (v == null) delete this[name];
		else this[name] = v;
	};
}
function property_default(name, value) {
	return arguments.length > 1 ? this.each((value == null ? propertyRemove : typeof value === "function" ? propertyFunction : propertyConstant)(name, value)) : this.node()[name];
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/classed.js
function classArray(string) {
	return string.trim().split(/^|\s+/);
}
function classList(node) {
	return node.classList || new ClassList(node);
}
function ClassList(node) {
	this._node = node;
	this._names = classArray(node.getAttribute("class") || "");
}
ClassList.prototype = {
	add: function(name) {
		if (this._names.indexOf(name) < 0) {
			this._names.push(name);
			this._node.setAttribute("class", this._names.join(" "));
		}
	},
	remove: function(name) {
		var i = this._names.indexOf(name);
		if (i >= 0) {
			this._names.splice(i, 1);
			this._node.setAttribute("class", this._names.join(" "));
		}
	},
	contains: function(name) {
		return this._names.indexOf(name) >= 0;
	}
};
function classedAdd(node, names) {
	var list = classList(node), i = -1, n = names.length;
	while (++i < n) list.add(names[i]);
}
function classedRemove(node, names) {
	var list = classList(node), i = -1, n = names.length;
	while (++i < n) list.remove(names[i]);
}
function classedTrue(names) {
	return function() {
		classedAdd(this, names);
	};
}
function classedFalse(names) {
	return function() {
		classedRemove(this, names);
	};
}
function classedFunction(names, value) {
	return function() {
		(value.apply(this, arguments) ? classedAdd : classedRemove)(this, names);
	};
}
function classed_default(name, value) {
	var names = classArray(name + "");
	if (arguments.length < 2) {
		var list = classList(this.node()), i = -1, n = names.length;
		while (++i < n) if (!list.contains(names[i])) return false;
		return true;
	}
	return this.each((typeof value === "function" ? classedFunction : value ? classedTrue : classedFalse)(names, value));
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/text.js
function textRemove() {
	this.textContent = "";
}
function textConstant$1(value) {
	return function() {
		this.textContent = value;
	};
}
function textFunction$1(value) {
	return function() {
		var v = value.apply(this, arguments);
		this.textContent = v == null ? "" : v;
	};
}
function text_default$1(value) {
	return arguments.length ? this.each(value == null ? textRemove : (typeof value === "function" ? textFunction$1 : textConstant$1)(value)) : this.node().textContent;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/html.js
function htmlRemove() {
	this.innerHTML = "";
}
function htmlConstant(value) {
	return function() {
		this.innerHTML = value;
	};
}
function htmlFunction(value) {
	return function() {
		var v = value.apply(this, arguments);
		this.innerHTML = v == null ? "" : v;
	};
}
function html_default(value) {
	return arguments.length ? this.each(value == null ? htmlRemove : (typeof value === "function" ? htmlFunction : htmlConstant)(value)) : this.node().innerHTML;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/raise.js
function raise() {
	if (this.nextSibling) this.parentNode.appendChild(this);
}
function raise_default() {
	return this.each(raise);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/lower.js
function lower() {
	if (this.previousSibling) this.parentNode.insertBefore(this, this.parentNode.firstChild);
}
function lower_default() {
	return this.each(lower);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/append.js
function append_default(name) {
	var create = typeof name === "function" ? name : creator_default(name);
	return this.select(function() {
		return this.appendChild(create.apply(this, arguments));
	});
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/insert.js
function constantNull() {
	return null;
}
function insert_default(name, before) {
	var create = typeof name === "function" ? name : creator_default(name), select = before == null ? constantNull : typeof before === "function" ? before : selector_default(before);
	return this.select(function() {
		return this.insertBefore(create.apply(this, arguments), select.apply(this, arguments) || null);
	});
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/remove.js
function remove() {
	var parent = this.parentNode;
	if (parent) parent.removeChild(this);
}
function remove_default$1() {
	return this.each(remove);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/clone.js
function selection_cloneShallow() {
	var clone = this.cloneNode(false), parent = this.parentNode;
	return parent ? parent.insertBefore(clone, this.nextSibling) : clone;
}
function selection_cloneDeep() {
	var clone = this.cloneNode(true), parent = this.parentNode;
	return parent ? parent.insertBefore(clone, this.nextSibling) : clone;
}
function clone_default(deep) {
	return this.select(deep ? selection_cloneDeep : selection_cloneShallow);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/datum.js
function datum_default(value) {
	return arguments.length ? this.property("__data__", value) : this.node().__data__;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/on.js
function contextListener(listener) {
	return function(event) {
		listener.call(this, event, this.__data__);
	};
}
function parseTypenames(typenames) {
	return typenames.trim().split(/^|\s+/).map(function(t) {
		var name = "", i = t.indexOf(".");
		if (i >= 0) name = t.slice(i + 1), t = t.slice(0, i);
		return {
			type: t,
			name
		};
	});
}
function onRemove(typename) {
	return function() {
		var on = this.__on;
		if (!on) return;
		for (var j = 0, i = -1, m = on.length, o; j < m; ++j) if (o = on[j], (!typename.type || o.type === typename.type) && o.name === typename.name) this.removeEventListener(o.type, o.listener, o.options);
		else on[++i] = o;
		if (++i) on.length = i;
		else delete this.__on;
	};
}
function onAdd(typename, value, options) {
	return function() {
		var on = this.__on, o, listener = contextListener(value);
		if (on) {
			for (var j = 0, m = on.length; j < m; ++j) if ((o = on[j]).type === typename.type && o.name === typename.name) {
				this.removeEventListener(o.type, o.listener, o.options);
				this.addEventListener(o.type, o.listener = listener, o.options = options);
				o.value = value;
				return;
			}
		}
		this.addEventListener(typename.type, listener, options);
		o = {
			type: typename.type,
			name: typename.name,
			value,
			listener,
			options
		};
		if (!on) this.__on = [o];
		else on.push(o);
	};
}
function on_default$1(typename, value, options) {
	var typenames = parseTypenames(typename + ""), i, n = typenames.length, t;
	if (arguments.length < 2) {
		var on = this.node().__on;
		if (on) {
			for (var j = 0, m = on.length, o; j < m; ++j) for (i = 0, o = on[j]; i < n; ++i) if ((t = typenames[i]).type === o.type && t.name === o.name) return o.value;
		}
		return;
	}
	on = value ? onAdd : onRemove;
	for (i = 0; i < n; ++i) this.each(on(typenames[i], value, options));
	return this;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/dispatch.js
function dispatchEvent(node, type, params) {
	var window = window_default(node), event = window.CustomEvent;
	if (typeof event === "function") event = new event(type, params);
	else {
		event = window.document.createEvent("Event");
		if (params) event.initEvent(type, params.bubbles, params.cancelable), event.detail = params.detail;
		else event.initEvent(type, false, false);
	}
	node.dispatchEvent(event);
}
function dispatchConstant(type, params) {
	return function() {
		return dispatchEvent(this, type, params);
	};
}
function dispatchFunction(type, params) {
	return function() {
		return dispatchEvent(this, type, params.apply(this, arguments));
	};
}
function dispatch_default(type, params) {
	return this.each((typeof params === "function" ? dispatchFunction : dispatchConstant)(type, params));
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/iterator.js
function* iterator_default() {
	for (var groups = this._groups, j = 0, m = groups.length; j < m; ++j) for (var group = groups[j], i = 0, n = group.length, node; i < n; ++i) if (node = group[i]) yield node;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/selection/index.js
var root = [null];
function Selection$1(groups, parents) {
	this._groups = groups;
	this._parents = parents;
}
function selection() {
	return new Selection$1([[document.documentElement]], root);
}
function selection_selection() {
	return this;
}
Selection$1.prototype = selection.prototype = {
	constructor: Selection$1,
	select: select_default$2,
	selectAll: selectAll_default$1,
	selectChild: selectChild_default,
	selectChildren: selectChildren_default,
	filter: filter_default$1,
	data: data_default,
	enter: enter_default,
	exit: exit_default,
	join: join_default,
	merge: merge_default$1,
	selection: selection_selection,
	order: order_default,
	sort: sort_default,
	call: call_default,
	nodes: nodes_default,
	node: node_default,
	size: size_default,
	empty: empty_default,
	each: each_default,
	attr: attr_default$1,
	style: style_default$1,
	property: property_default,
	classed: classed_default,
	text: text_default$1,
	html: html_default,
	raise: raise_default,
	lower: lower_default,
	append: append_default,
	insert: insert_default,
	remove: remove_default$1,
	clone: clone_default,
	datum: datum_default,
	on: on_default$1,
	dispatch: dispatch_default,
	[Symbol.iterator]: iterator_default
};

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/select.js
function select_default$1(selector) {
	return typeof selector === "string" ? new Selection$1([[document.querySelector(selector)]], [document.documentElement]) : new Selection$1([[selector]], root);
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/sourceEvent.js
function sourceEvent_default(event) {
	let sourceEvent;
	while (sourceEvent = event.sourceEvent) event = sourceEvent;
	return event;
}

//#endregion
//#region node_modules/.bun/d3-selection@3.0.0/node_modules/d3-selection/src/pointer.js
function pointer_default(event, node) {
	event = sourceEvent_default(event);
	if (node === void 0) node = event.currentTarget;
	if (node) {
		var svg = node.ownerSVGElement || node;
		if (svg.createSVGPoint) {
			var point = svg.createSVGPoint();
			point.x = event.clientX, point.y = event.clientY;
			point = point.matrixTransform(node.getScreenCTM().inverse());
			return [point.x, point.y];
		}
		if (node.getBoundingClientRect) {
			var rect = node.getBoundingClientRect();
			return [event.clientX - rect.left - node.clientLeft, event.clientY - rect.top - node.clientTop];
		}
	}
	return [event.pageX, event.pageY];
}

//#endregion
//#region node_modules/.bun/d3-drag@3.0.0/node_modules/d3-drag/src/noevent.js
const nonpassive = { passive: false };
const nonpassivecapture = {
	capture: true,
	passive: false
};
function nopropagation$1(event) {
	event.stopImmediatePropagation();
}
function noevent_default$1(event) {
	event.preventDefault();
	event.stopImmediatePropagation();
}

//#endregion
//#region node_modules/.bun/d3-drag@3.0.0/node_modules/d3-drag/src/nodrag.js
function nodrag_default(view) {
	var root = view.document.documentElement, selection = select_default$1(view).on("dragstart.drag", noevent_default$1, nonpassivecapture);
	if ("onselectstart" in root) selection.on("selectstart.drag", noevent_default$1, nonpassivecapture);
	else {
		root.__noselect = root.style.MozUserSelect;
		root.style.MozUserSelect = "none";
	}
}
function yesdrag(view, noclick) {
	var root = view.document.documentElement, selection = select_default$1(view).on("dragstart.drag", null);
	if (noclick) {
		selection.on("click.drag", noevent_default$1, nonpassivecapture);
		setTimeout(function() {
			selection.on("click.drag", null);
		}, 0);
	}
	if ("onselectstart" in root) selection.on("selectstart.drag", null);
	else {
		root.style.MozUserSelect = root.__noselect;
		delete root.__noselect;
	}
}

//#endregion
//#region node_modules/.bun/d3-drag@3.0.0/node_modules/d3-drag/src/constant.js
var constant_default$2 = (x) => () => x;

//#endregion
//#region node_modules/.bun/d3-drag@3.0.0/node_modules/d3-drag/src/event.js
function DragEvent(type, { sourceEvent, subject, target, identifier, active, x, y, dx, dy, dispatch }) {
	Object.defineProperties(this, {
		type: {
			value: type,
			enumerable: true,
			configurable: true
		},
		sourceEvent: {
			value: sourceEvent,
			enumerable: true,
			configurable: true
		},
		subject: {
			value: subject,
			enumerable: true,
			configurable: true
		},
		target: {
			value: target,
			enumerable: true,
			configurable: true
		},
		identifier: {
			value: identifier,
			enumerable: true,
			configurable: true
		},
		active: {
			value: active,
			enumerable: true,
			configurable: true
		},
		x: {
			value: x,
			enumerable: true,
			configurable: true
		},
		y: {
			value: y,
			enumerable: true,
			configurable: true
		},
		dx: {
			value: dx,
			enumerable: true,
			configurable: true
		},
		dy: {
			value: dy,
			enumerable: true,
			configurable: true
		},
		_: { value: dispatch }
	});
}
DragEvent.prototype.on = function() {
	var value = this._.on.apply(this._, arguments);
	return value === this._ ? this : value;
};

//#endregion
//#region node_modules/.bun/d3-drag@3.0.0/node_modules/d3-drag/src/drag.js
function defaultFilter$1(event) {
	return !event.ctrlKey && !event.button;
}
function defaultContainer() {
	return this.parentNode;
}
function defaultSubject(event, d) {
	return d == null ? {
		x: event.x,
		y: event.y
	} : d;
}
function defaultTouchable$1() {
	return navigator.maxTouchPoints || "ontouchstart" in this;
}
function drag_default() {
	var filter = defaultFilter$1, container = defaultContainer, subject = defaultSubject, touchable = defaultTouchable$1, gestures = {}, listeners = dispatch("start", "drag", "end"), active = 0, mousedownx, mousedowny, mousemoving, touchending, clickDistance2 = 0;
	function drag(selection) {
		selection.on("mousedown.drag", mousedowned).filter(touchable).on("touchstart.drag", touchstarted).on("touchmove.drag", touchmoved, nonpassive).on("touchend.drag touchcancel.drag", touchended).style("touch-action", "none").style("-webkit-tap-highlight-color", "rgba(0,0,0,0)");
	}
	function mousedowned(event, d) {
		if (touchending || !filter.call(this, event, d)) return;
		var gesture = beforestart(this, container.call(this, event, d), event, d, "mouse");
		if (!gesture) return;
		select_default$1(event.view).on("mousemove.drag", mousemoved, nonpassivecapture).on("mouseup.drag", mouseupped, nonpassivecapture);
		nodrag_default(event.view);
		nopropagation$1(event);
		mousemoving = false;
		mousedownx = event.clientX;
		mousedowny = event.clientY;
		gesture("start", event);
	}
	function mousemoved(event) {
		noevent_default$1(event);
		if (!mousemoving) {
			var dx = event.clientX - mousedownx, dy = event.clientY - mousedowny;
			mousemoving = dx * dx + dy * dy > clickDistance2;
		}
		gestures.mouse("drag", event);
	}
	function mouseupped(event) {
		select_default$1(event.view).on("mousemove.drag mouseup.drag", null);
		yesdrag(event.view, mousemoving);
		noevent_default$1(event);
		gestures.mouse("end", event);
	}
	function touchstarted(event, d) {
		if (!filter.call(this, event, d)) return;
		var touches = event.changedTouches, c = container.call(this, event, d), n = touches.length, i, gesture;
		for (i = 0; i < n; ++i) if (gesture = beforestart(this, c, event, d, touches[i].identifier, touches[i])) {
			nopropagation$1(event);
			gesture("start", event, touches[i]);
		}
	}
	function touchmoved(event) {
		var touches = event.changedTouches, n = touches.length, i, gesture;
		for (i = 0; i < n; ++i) if (gesture = gestures[touches[i].identifier]) {
			noevent_default$1(event);
			gesture("drag", event, touches[i]);
		}
	}
	function touchended(event) {
		var touches = event.changedTouches, n = touches.length, i, gesture;
		if (touchending) clearTimeout(touchending);
		touchending = setTimeout(function() {
			touchending = null;
		}, 500);
		for (i = 0; i < n; ++i) if (gesture = gestures[touches[i].identifier]) {
			nopropagation$1(event);
			gesture("end", event, touches[i]);
		}
	}
	function beforestart(that, container, event, d, identifier, touch) {
		var dispatch = listeners.copy(), p = pointer_default(touch || event, container), dx, dy, s;
		if ((s = subject.call(that, new DragEvent("beforestart", {
			sourceEvent: event,
			target: drag,
			identifier,
			active,
			x: p[0],
			y: p[1],
			dx: 0,
			dy: 0,
			dispatch
		}), d)) == null) return;
		dx = s.x - p[0] || 0;
		dy = s.y - p[1] || 0;
		return function gesture(type, event, touch) {
			var p0 = p, n;
			switch (type) {
				case "start":
					gestures[identifier] = gesture, n = active++;
					break;
				case "end": delete gestures[identifier], --active;
				case "drag":
					p = pointer_default(touch || event, container), n = active;
					break;
			}
			dispatch.call(type, that, new DragEvent(type, {
				sourceEvent: event,
				subject: s,
				target: drag,
				identifier,
				active: n,
				x: p[0] + dx,
				y: p[1] + dy,
				dx: p[0] - p0[0],
				dy: p[1] - p0[1],
				dispatch
			}), d);
		};
	}
	drag.filter = function(_) {
		return arguments.length ? (filter = typeof _ === "function" ? _ : constant_default$2(!!_), drag) : filter;
	};
	drag.container = function(_) {
		return arguments.length ? (container = typeof _ === "function" ? _ : constant_default$2(_), drag) : container;
	};
	drag.subject = function(_) {
		return arguments.length ? (subject = typeof _ === "function" ? _ : constant_default$2(_), drag) : subject;
	};
	drag.touchable = function(_) {
		return arguments.length ? (touchable = typeof _ === "function" ? _ : constant_default$2(!!_), drag) : touchable;
	};
	drag.on = function() {
		var value = listeners.on.apply(listeners, arguments);
		return value === listeners ? drag : value;
	};
	drag.clickDistance = function(_) {
		return arguments.length ? (clickDistance2 = (_ = +_) * _, drag) : Math.sqrt(clickDistance2);
	};
	return drag;
}

//#endregion
//#region node_modules/.bun/d3-color@3.1.0/node_modules/d3-color/src/define.js
function define_default(constructor, factory, prototype) {
	constructor.prototype = factory.prototype = prototype;
	prototype.constructor = constructor;
}
function extend(parent, definition) {
	var prototype = Object.create(parent.prototype);
	for (var key in definition) prototype[key] = definition[key];
	return prototype;
}

//#endregion
//#region node_modules/.bun/d3-color@3.1.0/node_modules/d3-color/src/color.js
function Color() {}
var darker = .7;
var brighter = 1 / darker;
var reI = "\\s*([+-]?\\d+)\\s*", reN = "\\s*([+-]?(?:\\d*\\.)?\\d+(?:[eE][+-]?\\d+)?)\\s*", reP = "\\s*([+-]?(?:\\d*\\.)?\\d+(?:[eE][+-]?\\d+)?)%\\s*", reHex = /^#([0-9a-f]{3,8})$/, reRgbInteger = new RegExp(`^rgb\\(${reI},${reI},${reI}\\)$`), reRgbPercent = new RegExp(`^rgb\\(${reP},${reP},${reP}\\)$`), reRgbaInteger = new RegExp(`^rgba\\(${reI},${reI},${reI},${reN}\\)$`), reRgbaPercent = new RegExp(`^rgba\\(${reP},${reP},${reP},${reN}\\)$`), reHslPercent = new RegExp(`^hsl\\(${reN},${reP},${reP}\\)$`), reHslaPercent = new RegExp(`^hsla\\(${reN},${reP},${reP},${reN}\\)$`);
var named = {
	aliceblue: 15792383,
	antiquewhite: 16444375,
	aqua: 65535,
	aquamarine: 8388564,
	azure: 15794175,
	beige: 16119260,
	bisque: 16770244,
	black: 0,
	blanchedalmond: 16772045,
	blue: 255,
	blueviolet: 9055202,
	brown: 10824234,
	burlywood: 14596231,
	cadetblue: 6266528,
	chartreuse: 8388352,
	chocolate: 13789470,
	coral: 16744272,
	cornflowerblue: 6591981,
	cornsilk: 16775388,
	crimson: 14423100,
	cyan: 65535,
	darkblue: 139,
	darkcyan: 35723,
	darkgoldenrod: 12092939,
	darkgray: 11119017,
	darkgreen: 25600,
	darkgrey: 11119017,
	darkkhaki: 12433259,
	darkmagenta: 9109643,
	darkolivegreen: 5597999,
	darkorange: 16747520,
	darkorchid: 10040012,
	darkred: 9109504,
	darksalmon: 15308410,
	darkseagreen: 9419919,
	darkslateblue: 4734347,
	darkslategray: 3100495,
	darkslategrey: 3100495,
	darkturquoise: 52945,
	darkviolet: 9699539,
	deeppink: 16716947,
	deepskyblue: 49151,
	dimgray: 6908265,
	dimgrey: 6908265,
	dodgerblue: 2003199,
	firebrick: 11674146,
	floralwhite: 16775920,
	forestgreen: 2263842,
	fuchsia: 16711935,
	gainsboro: 14474460,
	ghostwhite: 16316671,
	gold: 16766720,
	goldenrod: 14329120,
	gray: 8421504,
	green: 32768,
	greenyellow: 11403055,
	grey: 8421504,
	honeydew: 15794160,
	hotpink: 16738740,
	indianred: 13458524,
	indigo: 4915330,
	ivory: 16777200,
	khaki: 15787660,
	lavender: 15132410,
	lavenderblush: 16773365,
	lawngreen: 8190976,
	lemonchiffon: 16775885,
	lightblue: 11393254,
	lightcoral: 15761536,
	lightcyan: 14745599,
	lightgoldenrodyellow: 16448210,
	lightgray: 13882323,
	lightgreen: 9498256,
	lightgrey: 13882323,
	lightpink: 16758465,
	lightsalmon: 16752762,
	lightseagreen: 2142890,
	lightskyblue: 8900346,
	lightslategray: 7833753,
	lightslategrey: 7833753,
	lightsteelblue: 11584734,
	lightyellow: 16777184,
	lime: 65280,
	limegreen: 3329330,
	linen: 16445670,
	magenta: 16711935,
	maroon: 8388608,
	mediumaquamarine: 6737322,
	mediumblue: 205,
	mediumorchid: 12211667,
	mediumpurple: 9662683,
	mediumseagreen: 3978097,
	mediumslateblue: 8087790,
	mediumspringgreen: 64154,
	mediumturquoise: 4772300,
	mediumvioletred: 13047173,
	midnightblue: 1644912,
	mintcream: 16121850,
	mistyrose: 16770273,
	moccasin: 16770229,
	navajowhite: 16768685,
	navy: 128,
	oldlace: 16643558,
	olive: 8421376,
	olivedrab: 7048739,
	orange: 16753920,
	orangered: 16729344,
	orchid: 14315734,
	palegoldenrod: 15657130,
	palegreen: 10025880,
	paleturquoise: 11529966,
	palevioletred: 14381203,
	papayawhip: 16773077,
	peachpuff: 16767673,
	peru: 13468991,
	pink: 16761035,
	plum: 14524637,
	powderblue: 11591910,
	purple: 8388736,
	rebeccapurple: 6697881,
	red: 16711680,
	rosybrown: 12357519,
	royalblue: 4286945,
	saddlebrown: 9127187,
	salmon: 16416882,
	sandybrown: 16032864,
	seagreen: 3050327,
	seashell: 16774638,
	sienna: 10506797,
	silver: 12632256,
	skyblue: 8900331,
	slateblue: 6970061,
	slategray: 7372944,
	slategrey: 7372944,
	snow: 16775930,
	springgreen: 65407,
	steelblue: 4620980,
	tan: 13808780,
	teal: 32896,
	thistle: 14204888,
	tomato: 16737095,
	turquoise: 4251856,
	violet: 15631086,
	wheat: 16113331,
	white: 16777215,
	whitesmoke: 16119285,
	yellow: 16776960,
	yellowgreen: 10145074
};
define_default(Color, color, {
	copy(channels) {
		return Object.assign(new this.constructor(), this, channels);
	},
	displayable() {
		return this.rgb().displayable();
	},
	hex: color_formatHex,
	formatHex: color_formatHex,
	formatHex8: color_formatHex8,
	formatHsl: color_formatHsl,
	formatRgb: color_formatRgb,
	toString: color_formatRgb
});
function color_formatHex() {
	return this.rgb().formatHex();
}
function color_formatHex8() {
	return this.rgb().formatHex8();
}
function color_formatHsl() {
	return hslConvert(this).formatHsl();
}
function color_formatRgb() {
	return this.rgb().formatRgb();
}
function color(format) {
	var m, l;
	format = (format + "").trim().toLowerCase();
	return (m = reHex.exec(format)) ? (l = m[1].length, m = parseInt(m[1], 16), l === 6 ? rgbn(m) : l === 3 ? new Rgb(m >> 8 & 15 | m >> 4 & 240, m >> 4 & 15 | m & 240, (m & 15) << 4 | m & 15, 1) : l === 8 ? rgba(m >> 24 & 255, m >> 16 & 255, m >> 8 & 255, (m & 255) / 255) : l === 4 ? rgba(m >> 12 & 15 | m >> 8 & 240, m >> 8 & 15 | m >> 4 & 240, m >> 4 & 15 | m & 240, ((m & 15) << 4 | m & 15) / 255) : null) : (m = reRgbInteger.exec(format)) ? new Rgb(m[1], m[2], m[3], 1) : (m = reRgbPercent.exec(format)) ? new Rgb(m[1] * 255 / 100, m[2] * 255 / 100, m[3] * 255 / 100, 1) : (m = reRgbaInteger.exec(format)) ? rgba(m[1], m[2], m[3], m[4]) : (m = reRgbaPercent.exec(format)) ? rgba(m[1] * 255 / 100, m[2] * 255 / 100, m[3] * 255 / 100, m[4]) : (m = reHslPercent.exec(format)) ? hsla(m[1], m[2] / 100, m[3] / 100, 1) : (m = reHslaPercent.exec(format)) ? hsla(m[1], m[2] / 100, m[3] / 100, m[4]) : named.hasOwnProperty(format) ? rgbn(named[format]) : format === "transparent" ? new Rgb(NaN, NaN, NaN, 0) : null;
}
function rgbn(n) {
	return new Rgb(n >> 16 & 255, n >> 8 & 255, n & 255, 1);
}
function rgba(r, g, b, a) {
	if (a <= 0) r = g = b = NaN;
	return new Rgb(r, g, b, a);
}
function rgbConvert(o) {
	if (!(o instanceof Color)) o = color(o);
	if (!o) return new Rgb();
	o = o.rgb();
	return new Rgb(o.r, o.g, o.b, o.opacity);
}
function rgb(r, g, b, opacity) {
	return arguments.length === 1 ? rgbConvert(r) : new Rgb(r, g, b, opacity == null ? 1 : opacity);
}
function Rgb(r, g, b, opacity) {
	this.r = +r;
	this.g = +g;
	this.b = +b;
	this.opacity = +opacity;
}
define_default(Rgb, rgb, extend(Color, {
	brighter(k) {
		k = k == null ? brighter : Math.pow(brighter, k);
		return new Rgb(this.r * k, this.g * k, this.b * k, this.opacity);
	},
	darker(k) {
		k = k == null ? darker : Math.pow(darker, k);
		return new Rgb(this.r * k, this.g * k, this.b * k, this.opacity);
	},
	rgb() {
		return this;
	},
	clamp() {
		return new Rgb(clampi(this.r), clampi(this.g), clampi(this.b), clampa(this.opacity));
	},
	displayable() {
		return -.5 <= this.r && this.r < 255.5 && -.5 <= this.g && this.g < 255.5 && -.5 <= this.b && this.b < 255.5 && 0 <= this.opacity && this.opacity <= 1;
	},
	hex: rgb_formatHex,
	formatHex: rgb_formatHex,
	formatHex8: rgb_formatHex8,
	formatRgb: rgb_formatRgb,
	toString: rgb_formatRgb
}));
function rgb_formatHex() {
	return `#${hex(this.r)}${hex(this.g)}${hex(this.b)}`;
}
function rgb_formatHex8() {
	return `#${hex(this.r)}${hex(this.g)}${hex(this.b)}${hex((isNaN(this.opacity) ? 1 : this.opacity) * 255)}`;
}
function rgb_formatRgb() {
	const a = clampa(this.opacity);
	return `${a === 1 ? "rgb(" : "rgba("}${clampi(this.r)}, ${clampi(this.g)}, ${clampi(this.b)}${a === 1 ? ")" : `, ${a})`}`;
}
function clampa(opacity) {
	return isNaN(opacity) ? 1 : Math.max(0, Math.min(1, opacity));
}
function clampi(value) {
	return Math.max(0, Math.min(255, Math.round(value) || 0));
}
function hex(value) {
	value = clampi(value);
	return (value < 16 ? "0" : "") + value.toString(16);
}
function hsla(h, s, l, a) {
	if (a <= 0) h = s = l = NaN;
	else if (l <= 0 || l >= 1) h = s = NaN;
	else if (s <= 0) h = NaN;
	return new Hsl(h, s, l, a);
}
function hslConvert(o) {
	if (o instanceof Hsl) return new Hsl(o.h, o.s, o.l, o.opacity);
	if (!(o instanceof Color)) o = color(o);
	if (!o) return new Hsl();
	if (o instanceof Hsl) return o;
	o = o.rgb();
	var r = o.r / 255, g = o.g / 255, b = o.b / 255, min = Math.min(r, g, b), max = Math.max(r, g, b), h = NaN, s = max - min, l = (max + min) / 2;
	if (s) {
		if (r === max) h = (g - b) / s + (g < b) * 6;
		else if (g === max) h = (b - r) / s + 2;
		else h = (r - g) / s + 4;
		s /= l < .5 ? max + min : 2 - max - min;
		h *= 60;
	} else s = l > 0 && l < 1 ? 0 : h;
	return new Hsl(h, s, l, o.opacity);
}
function hsl(h, s, l, opacity) {
	return arguments.length === 1 ? hslConvert(h) : new Hsl(h, s, l, opacity == null ? 1 : opacity);
}
function Hsl(h, s, l, opacity) {
	this.h = +h;
	this.s = +s;
	this.l = +l;
	this.opacity = +opacity;
}
define_default(Hsl, hsl, extend(Color, {
	brighter(k) {
		k = k == null ? brighter : Math.pow(brighter, k);
		return new Hsl(this.h, this.s, this.l * k, this.opacity);
	},
	darker(k) {
		k = k == null ? darker : Math.pow(darker, k);
		return new Hsl(this.h, this.s, this.l * k, this.opacity);
	},
	rgb() {
		var h = this.h % 360 + (this.h < 0) * 360, s = isNaN(h) || isNaN(this.s) ? 0 : this.s, l = this.l, m2 = l + (l < .5 ? l : 1 - l) * s, m1 = 2 * l - m2;
		return new Rgb(hsl2rgb(h >= 240 ? h - 240 : h + 120, m1, m2), hsl2rgb(h, m1, m2), hsl2rgb(h < 120 ? h + 240 : h - 120, m1, m2), this.opacity);
	},
	clamp() {
		return new Hsl(clamph(this.h), clampt(this.s), clampt(this.l), clampa(this.opacity));
	},
	displayable() {
		return (0 <= this.s && this.s <= 1 || isNaN(this.s)) && 0 <= this.l && this.l <= 1 && 0 <= this.opacity && this.opacity <= 1;
	},
	formatHsl() {
		const a = clampa(this.opacity);
		return `${a === 1 ? "hsl(" : "hsla("}${clamph(this.h)}, ${clampt(this.s) * 100}%, ${clampt(this.l) * 100}%${a === 1 ? ")" : `, ${a})`}`;
	}
}));
function clamph(value) {
	value = (value || 0) % 360;
	return value < 0 ? value + 360 : value;
}
function clampt(value) {
	return Math.max(0, Math.min(1, value || 0));
}
function hsl2rgb(h, m1, m2) {
	return (h < 60 ? m1 + (m2 - m1) * h / 60 : h < 180 ? m2 : h < 240 ? m1 + (m2 - m1) * (240 - h) / 60 : m1) * 255;
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/basis.js
function basis(t1, v0, v1, v2, v3) {
	var t2 = t1 * t1, t3 = t2 * t1;
	return ((1 - 3 * t1 + 3 * t2 - t3) * v0 + (4 - 6 * t2 + 3 * t3) * v1 + (1 + 3 * t1 + 3 * t2 - 3 * t3) * v2 + t3 * v3) / 6;
}
function basis_default(values) {
	var n = values.length - 1;
	return function(t) {
		var i = t <= 0 ? t = 0 : t >= 1 ? (t = 1, n - 1) : Math.floor(t * n), v1 = values[i], v2 = values[i + 1], v0 = i > 0 ? values[i - 1] : 2 * v1 - v2, v3 = i < n - 1 ? values[i + 2] : 2 * v2 - v1;
		return basis((t - i / n) * n, v0, v1, v2, v3);
	};
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/basisClosed.js
function basisClosed_default(values) {
	var n = values.length;
	return function(t) {
		var i = Math.floor(((t %= 1) < 0 ? ++t : t) * n), v0 = values[(i + n - 1) % n], v1 = values[i % n], v2 = values[(i + 1) % n], v3 = values[(i + 2) % n];
		return basis((t - i / n) * n, v0, v1, v2, v3);
	};
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/constant.js
var constant_default$1 = (x) => () => x;

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/color.js
function linear(a, d) {
	return function(t) {
		return a + t * d;
	};
}
function exponential(a, b, y) {
	return a = Math.pow(a, y), b = Math.pow(b, y) - a, y = 1 / y, function(t) {
		return Math.pow(a + t * b, y);
	};
}
function gamma(y) {
	return (y = +y) === 1 ? nogamma : function(a, b) {
		return b - a ? exponential(a, b, y) : constant_default$1(isNaN(a) ? b : a);
	};
}
function nogamma(a, b) {
	var d = b - a;
	return d ? linear(a, d) : constant_default$1(isNaN(a) ? b : a);
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/rgb.js
var rgb_default = (function rgbGamma(y) {
	var color = gamma(y);
	function rgb$1(start, end) {
		var r = color((start = rgb(start)).r, (end = rgb(end)).r), g = color(start.g, end.g), b = color(start.b, end.b), opacity = nogamma(start.opacity, end.opacity);
		return function(t) {
			start.r = r(t);
			start.g = g(t);
			start.b = b(t);
			start.opacity = opacity(t);
			return start + "";
		};
	}
	rgb$1.gamma = rgbGamma;
	return rgb$1;
})(1);
function rgbSpline(spline) {
	return function(colors) {
		var n = colors.length, r = new Array(n), g = new Array(n), b = new Array(n), i, color;
		for (i = 0; i < n; ++i) {
			color = rgb(colors[i]);
			r[i] = color.r || 0;
			g[i] = color.g || 0;
			b[i] = color.b || 0;
		}
		r = spline(r);
		g = spline(g);
		b = spline(b);
		color.opacity = 1;
		return function(t) {
			color.r = r(t);
			color.g = g(t);
			color.b = b(t);
			return color + "";
		};
	};
}
var rgbBasis = rgbSpline(basis_default);
var rgbBasisClosed = rgbSpline(basisClosed_default);

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/numberArray.js
function numberArray_default(a, b) {
	if (!b) b = [];
	var n = a ? Math.min(b.length, a.length) : 0, c = b.slice(), i;
	return function(t) {
		for (i = 0; i < n; ++i) c[i] = a[i] * (1 - t) + b[i] * t;
		return c;
	};
}
function isNumberArray(x) {
	return ArrayBuffer.isView(x) && !(x instanceof DataView);
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/array.js
function genericArray(a, b) {
	var nb = b ? b.length : 0, na = a ? Math.min(nb, a.length) : 0, x = new Array(na), c = new Array(nb), i;
	for (i = 0; i < na; ++i) x[i] = value_default(a[i], b[i]);
	for (; i < nb; ++i) c[i] = b[i];
	return function(t) {
		for (i = 0; i < na; ++i) c[i] = x[i](t);
		return c;
	};
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/date.js
function date_default(a, b) {
	var d = /* @__PURE__ */ new Date();
	return a = +a, b = +b, function(t) {
		return d.setTime(a * (1 - t) + b * t), d;
	};
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/number.js
function number_default(a, b) {
	return a = +a, b = +b, function(t) {
		return a * (1 - t) + b * t;
	};
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/object.js
function object_default(a, b) {
	var i = {}, c = {}, k;
	if (a === null || typeof a !== "object") a = {};
	if (b === null || typeof b !== "object") b = {};
	for (k in b) if (k in a) i[k] = value_default(a[k], b[k]);
	else c[k] = b[k];
	return function(t) {
		for (k in i) c[k] = i[k](t);
		return c;
	};
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/string.js
var reA = /[-+]?(?:\d+\.?\d*|\.?\d+)(?:[eE][-+]?\d+)?/g, reB = new RegExp(reA.source, "g");
function zero(b) {
	return function() {
		return b;
	};
}
function one(b) {
	return function(t) {
		return b(t) + "";
	};
}
function string_default(a, b) {
	var bi = reA.lastIndex = reB.lastIndex = 0, am, bm, bs, i = -1, s = [], q = [];
	a = a + "", b = b + "";
	while ((am = reA.exec(a)) && (bm = reB.exec(b))) {
		if ((bs = bm.index) > bi) {
			bs = b.slice(bi, bs);
			if (s[i]) s[i] += bs;
			else s[++i] = bs;
		}
		if ((am = am[0]) === (bm = bm[0])) if (s[i]) s[i] += bm;
		else s[++i] = bm;
		else {
			s[++i] = null;
			q.push({
				i,
				x: number_default(am, bm)
			});
		}
		bi = reB.lastIndex;
	}
	if (bi < b.length) {
		bs = b.slice(bi);
		if (s[i]) s[i] += bs;
		else s[++i] = bs;
	}
	return s.length < 2 ? q[0] ? one(q[0].x) : zero(b) : (b = q.length, function(t) {
		for (var i = 0, o; i < b; ++i) s[(o = q[i]).i] = o.x(t);
		return s.join("");
	});
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/value.js
function value_default(a, b) {
	var t = typeof b, c;
	return b == null || t === "boolean" ? constant_default$1(b) : (t === "number" ? number_default : t === "string" ? (c = color(b)) ? (b = c, rgb_default) : string_default : b instanceof color ? rgb_default : b instanceof Date ? date_default : isNumberArray(b) ? numberArray_default : Array.isArray(b) ? genericArray : typeof b.valueOf !== "function" && typeof b.toString !== "function" || isNaN(b) ? object_default : number_default)(a, b);
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/transform/decompose.js
var degrees = 180 / Math.PI;
var identity$2 = {
	translateX: 0,
	translateY: 0,
	rotate: 0,
	skewX: 0,
	scaleX: 1,
	scaleY: 1
};
function decompose_default(a, b, c, d, e, f) {
	var scaleX, scaleY, skewX;
	if (scaleX = Math.sqrt(a * a + b * b)) a /= scaleX, b /= scaleX;
	if (skewX = a * c + b * d) c -= a * skewX, d -= b * skewX;
	if (scaleY = Math.sqrt(c * c + d * d)) c /= scaleY, d /= scaleY, skewX /= scaleY;
	if (a * d < b * c) a = -a, b = -b, skewX = -skewX, scaleX = -scaleX;
	return {
		translateX: e,
		translateY: f,
		rotate: Math.atan2(b, a) * degrees,
		skewX: Math.atan(skewX) * degrees,
		scaleX,
		scaleY
	};
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/transform/parse.js
var svgNode;
function parseCss(value) {
	const m = new (typeof DOMMatrix === "function" ? DOMMatrix : WebKitCSSMatrix)(value + "");
	return m.isIdentity ? identity$2 : decompose_default(m.a, m.b, m.c, m.d, m.e, m.f);
}
function parseSvg(value) {
	if (value == null) return identity$2;
	if (!svgNode) svgNode = document.createElementNS("http://www.w3.org/2000/svg", "g");
	svgNode.setAttribute("transform", value);
	if (!(value = svgNode.transform.baseVal.consolidate())) return identity$2;
	value = value.matrix;
	return decompose_default(value.a, value.b, value.c, value.d, value.e, value.f);
}

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/transform/index.js
function interpolateTransform(parse, pxComma, pxParen, degParen) {
	function pop(s) {
		return s.length ? s.pop() + " " : "";
	}
	function translate(xa, ya, xb, yb, s, q) {
		if (xa !== xb || ya !== yb) {
			var i = s.push("translate(", null, pxComma, null, pxParen);
			q.push({
				i: i - 4,
				x: number_default(xa, xb)
			}, {
				i: i - 2,
				x: number_default(ya, yb)
			});
		} else if (xb || yb) s.push("translate(" + xb + pxComma + yb + pxParen);
	}
	function rotate(a, b, s, q) {
		if (a !== b) {
			if (a - b > 180) b += 360;
			else if (b - a > 180) a += 360;
			q.push({
				i: s.push(pop(s) + "rotate(", null, degParen) - 2,
				x: number_default(a, b)
			});
		} else if (b) s.push(pop(s) + "rotate(" + b + degParen);
	}
	function skewX(a, b, s, q) {
		if (a !== b) q.push({
			i: s.push(pop(s) + "skewX(", null, degParen) - 2,
			x: number_default(a, b)
		});
		else if (b) s.push(pop(s) + "skewX(" + b + degParen);
	}
	function scale(xa, ya, xb, yb, s, q) {
		if (xa !== xb || ya !== yb) {
			var i = s.push(pop(s) + "scale(", null, ",", null, ")");
			q.push({
				i: i - 4,
				x: number_default(xa, xb)
			}, {
				i: i - 2,
				x: number_default(ya, yb)
			});
		} else if (xb !== 1 || yb !== 1) s.push(pop(s) + "scale(" + xb + "," + yb + ")");
	}
	return function(a, b) {
		var s = [], q = [];
		a = parse(a), b = parse(b);
		translate(a.translateX, a.translateY, b.translateX, b.translateY, s, q);
		rotate(a.rotate, b.rotate, s, q);
		skewX(a.skewX, b.skewX, s, q);
		scale(a.scaleX, a.scaleY, b.scaleX, b.scaleY, s, q);
		a = b = null;
		return function(t) {
			var i = -1, n = q.length, o;
			while (++i < n) s[(o = q[i]).i] = o.x(t);
			return s.join("");
		};
	};
}
var interpolateTransformCss = interpolateTransform(parseCss, "px, ", "px)", "deg)");
var interpolateTransformSvg = interpolateTransform(parseSvg, ", ", ")", ")");

//#endregion
//#region node_modules/.bun/d3-interpolate@3.0.1/node_modules/d3-interpolate/src/zoom.js
var epsilon2 = 1e-12;
function cosh(x) {
	return ((x = Math.exp(x)) + 1 / x) / 2;
}
function sinh(x) {
	return ((x = Math.exp(x)) - 1 / x) / 2;
}
function tanh(x) {
	return ((x = Math.exp(2 * x)) - 1) / (x + 1);
}
var zoom_default$1 = (function zoomRho(rho, rho2, rho4) {
	function zoom(p0, p1) {
		var ux0 = p0[0], uy0 = p0[1], w0 = p0[2], ux1 = p1[0], uy1 = p1[1], w1 = p1[2], dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy, i, S;
		if (d2 < epsilon2) {
			S = Math.log(w1 / w0) / rho;
			i = function(t) {
				return [
					ux0 + t * dx,
					uy0 + t * dy,
					w0 * Math.exp(rho * t * S)
				];
			};
		} else {
			var d1 = Math.sqrt(d2), b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1), b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1), r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
			S = (Math.log(Math.sqrt(b1 * b1 + 1) - b1) - r0) / rho;
			i = function(t) {
				var s = t * S, coshr0 = cosh(r0), u = w0 / (rho2 * d1) * (coshr0 * tanh(rho * s + r0) - sinh(r0));
				return [
					ux0 + u * dx,
					uy0 + u * dy,
					w0 * coshr0 / cosh(rho * s + r0)
				];
			};
		}
		i.duration = S * 1e3 * rho / Math.SQRT2;
		return i;
	}
	zoom.rho = function(_) {
		var _1 = Math.max(.001, +_), _2 = _1 * _1;
		return zoomRho(_1, _2, _2 * _2);
	};
	return zoom;
})(Math.SQRT2, 2, 4);

//#endregion
//#region node_modules/.bun/d3-timer@3.0.1/node_modules/d3-timer/src/timer.js
var frame = 0, timeout = 0, interval = 0, pokeDelay = 1e3, taskHead, taskTail, clockLast = 0, clockNow = 0, clockSkew = 0, clock = typeof performance === "object" && performance.now ? performance : Date, setFrame = typeof window === "object" && window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function(f) {
	setTimeout(f, 17);
};
function now() {
	return clockNow || (setFrame(clearNow), clockNow = clock.now() + clockSkew);
}
function clearNow() {
	clockNow = 0;
}
function Timer() {
	this._call = this._time = this._next = null;
}
Timer.prototype = timer.prototype = {
	constructor: Timer,
	restart: function(callback, delay, time) {
		if (typeof callback !== "function") throw new TypeError("callback is not a function");
		time = (time == null ? now() : +time) + (delay == null ? 0 : +delay);
		if (!this._next && taskTail !== this) {
			if (taskTail) taskTail._next = this;
			else taskHead = this;
			taskTail = this;
		}
		this._call = callback;
		this._time = time;
		sleep();
	},
	stop: function() {
		if (this._call) {
			this._call = null;
			this._time = Infinity;
			sleep();
		}
	}
};
function timer(callback, delay, time) {
	var t = new Timer();
	t.restart(callback, delay, time);
	return t;
}
function timerFlush() {
	now();
	++frame;
	var t = taskHead, e;
	while (t) {
		if ((e = clockNow - t._time) >= 0) t._call.call(void 0, e);
		t = t._next;
	}
	--frame;
}
function wake() {
	clockNow = (clockLast = clock.now()) + clockSkew;
	frame = timeout = 0;
	try {
		timerFlush();
	} finally {
		frame = 0;
		nap();
		clockNow = 0;
	}
}
function poke() {
	var now = clock.now(), delay = now - clockLast;
	if (delay > pokeDelay) clockSkew -= delay, clockLast = now;
}
function nap() {
	var t0, t1 = taskHead, t2, time = Infinity;
	while (t1) if (t1._call) {
		if (time > t1._time) time = t1._time;
		t0 = t1, t1 = t1._next;
	} else {
		t2 = t1._next, t1._next = null;
		t1 = t0 ? t0._next = t2 : taskHead = t2;
	}
	taskTail = t0;
	sleep(time);
}
function sleep(time) {
	if (frame) return;
	if (timeout) timeout = clearTimeout(timeout);
	if (time - clockNow > 24) {
		if (time < Infinity) timeout = setTimeout(wake, time - clock.now() - clockSkew);
		if (interval) interval = clearInterval(interval);
	} else {
		if (!interval) clockLast = clock.now(), interval = setInterval(poke, pokeDelay);
		frame = 1, setFrame(wake);
	}
}

//#endregion
//#region node_modules/.bun/d3-timer@3.0.1/node_modules/d3-timer/src/timeout.js
function timeout_default(callback, delay, time) {
	var t = new Timer();
	delay = delay == null ? 0 : +delay;
	t.restart((elapsed) => {
		t.stop();
		callback(elapsed + delay);
	}, delay, time);
	return t;
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/schedule.js
var emptyOn = dispatch("start", "end", "cancel", "interrupt");
var emptyTween = [];
var CREATED = 0;
var SCHEDULED = 1;
var STARTING = 2;
var STARTED = 3;
var RUNNING = 4;
var ENDING = 5;
var ENDED = 6;
function schedule_default(node, name, id, index, group, timing) {
	var schedules = node.__transition;
	if (!schedules) node.__transition = {};
	else if (id in schedules) return;
	create(node, id, {
		name,
		index,
		group,
		on: emptyOn,
		tween: emptyTween,
		time: timing.time,
		delay: timing.delay,
		duration: timing.duration,
		ease: timing.ease,
		timer: null,
		state: CREATED
	});
}
function init(node, id) {
	var schedule = get(node, id);
	if (schedule.state > CREATED) throw new Error("too late; already scheduled");
	return schedule;
}
function set(node, id) {
	var schedule = get(node, id);
	if (schedule.state > STARTED) throw new Error("too late; already running");
	return schedule;
}
function get(node, id) {
	var schedule = node.__transition;
	if (!schedule || !(schedule = schedule[id])) throw new Error("transition not found");
	return schedule;
}
function create(node, id, self) {
	var schedules = node.__transition, tween;
	schedules[id] = self;
	self.timer = timer(schedule, 0, self.time);
	function schedule(elapsed) {
		self.state = SCHEDULED;
		self.timer.restart(start, self.delay, self.time);
		if (self.delay <= elapsed) start(elapsed - self.delay);
	}
	function start(elapsed) {
		var i, j, n, o;
		if (self.state !== SCHEDULED) return stop();
		for (i in schedules) {
			o = schedules[i];
			if (o.name !== self.name) continue;
			if (o.state === STARTED) return timeout_default(start);
			if (o.state === RUNNING) {
				o.state = ENDED;
				o.timer.stop();
				o.on.call("interrupt", node, node.__data__, o.index, o.group);
				delete schedules[i];
			} else if (+i < id) {
				o.state = ENDED;
				o.timer.stop();
				o.on.call("cancel", node, node.__data__, o.index, o.group);
				delete schedules[i];
			}
		}
		timeout_default(function() {
			if (self.state === STARTED) {
				self.state = RUNNING;
				self.timer.restart(tick, self.delay, self.time);
				tick(elapsed);
			}
		});
		self.state = STARTING;
		self.on.call("start", node, node.__data__, self.index, self.group);
		if (self.state !== STARTING) return;
		self.state = STARTED;
		tween = new Array(n = self.tween.length);
		for (i = 0, j = -1; i < n; ++i) if (o = self.tween[i].value.call(node, node.__data__, self.index, self.group)) tween[++j] = o;
		tween.length = j + 1;
	}
	function tick(elapsed) {
		var t = elapsed < self.duration ? self.ease.call(null, elapsed / self.duration) : (self.timer.restart(stop), self.state = ENDING, 1), i = -1, n = tween.length;
		while (++i < n) tween[i].call(node, t);
		if (self.state === ENDING) {
			self.on.call("end", node, node.__data__, self.index, self.group);
			stop();
		}
	}
	function stop() {
		self.state = ENDED;
		self.timer.stop();
		delete schedules[id];
		for (var i in schedules) return;
		delete node.__transition;
	}
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/interrupt.js
function interrupt_default$1(node, name) {
	var schedules = node.__transition, schedule, active, empty = true, i;
	if (!schedules) return;
	name = name == null ? null : name + "";
	for (i in schedules) {
		if ((schedule = schedules[i]).name !== name) {
			empty = false;
			continue;
		}
		active = schedule.state > STARTING && schedule.state < ENDING;
		schedule.state = ENDED;
		schedule.timer.stop();
		schedule.on.call(active ? "interrupt" : "cancel", node, node.__data__, schedule.index, schedule.group);
		delete schedules[i];
	}
	if (empty) delete node.__transition;
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/selection/interrupt.js
function interrupt_default(name) {
	return this.each(function() {
		interrupt_default$1(this, name);
	});
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/tween.js
function tweenRemove(id, name) {
	var tween0, tween1;
	return function() {
		var schedule = set(this, id), tween = schedule.tween;
		if (tween !== tween0) {
			tween1 = tween0 = tween;
			for (var i = 0, n = tween1.length; i < n; ++i) if (tween1[i].name === name) {
				tween1 = tween1.slice();
				tween1.splice(i, 1);
				break;
			}
		}
		schedule.tween = tween1;
	};
}
function tweenFunction(id, name, value) {
	var tween0, tween1;
	if (typeof value !== "function") throw new Error();
	return function() {
		var schedule = set(this, id), tween = schedule.tween;
		if (tween !== tween0) {
			tween1 = (tween0 = tween).slice();
			for (var t = {
				name,
				value
			}, i = 0, n = tween1.length; i < n; ++i) if (tween1[i].name === name) {
				tween1[i] = t;
				break;
			}
			if (i === n) tween1.push(t);
		}
		schedule.tween = tween1;
	};
}
function tween_default(name, value) {
	var id = this._id;
	name += "";
	if (arguments.length < 2) {
		var tween = get(this.node(), id).tween;
		for (var i = 0, n = tween.length, t; i < n; ++i) if ((t = tween[i]).name === name) return t.value;
		return null;
	}
	return this.each((value == null ? tweenRemove : tweenFunction)(id, name, value));
}
function tweenValue(transition, name, value) {
	var id = transition._id;
	transition.each(function() {
		var schedule = set(this, id);
		(schedule.value || (schedule.value = {}))[name] = value.apply(this, arguments);
	});
	return function(node) {
		return get(node, id).value[name];
	};
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/interpolate.js
function interpolate_default(a, b) {
	var c;
	return (typeof b === "number" ? number_default : b instanceof color ? rgb_default : (c = color(b)) ? (b = c, rgb_default) : string_default)(a, b);
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/attr.js
function attrRemove(name) {
	return function() {
		this.removeAttribute(name);
	};
}
function attrRemoveNS(fullname) {
	return function() {
		this.removeAttributeNS(fullname.space, fullname.local);
	};
}
function attrConstant(name, interpolate, value1) {
	var string00, string1 = value1 + "", interpolate0;
	return function() {
		var string0 = this.getAttribute(name);
		return string0 === string1 ? null : string0 === string00 ? interpolate0 : interpolate0 = interpolate(string00 = string0, value1);
	};
}
function attrConstantNS(fullname, interpolate, value1) {
	var string00, string1 = value1 + "", interpolate0;
	return function() {
		var string0 = this.getAttributeNS(fullname.space, fullname.local);
		return string0 === string1 ? null : string0 === string00 ? interpolate0 : interpolate0 = interpolate(string00 = string0, value1);
	};
}
function attrFunction(name, interpolate, value) {
	var string00, string10, interpolate0;
	return function() {
		var string0, value1 = value(this), string1;
		if (value1 == null) return void this.removeAttribute(name);
		string0 = this.getAttribute(name);
		string1 = value1 + "";
		return string0 === string1 ? null : string0 === string00 && string1 === string10 ? interpolate0 : (string10 = string1, interpolate0 = interpolate(string00 = string0, value1));
	};
}
function attrFunctionNS(fullname, interpolate, value) {
	var string00, string10, interpolate0;
	return function() {
		var string0, value1 = value(this), string1;
		if (value1 == null) return void this.removeAttributeNS(fullname.space, fullname.local);
		string0 = this.getAttributeNS(fullname.space, fullname.local);
		string1 = value1 + "";
		return string0 === string1 ? null : string0 === string00 && string1 === string10 ? interpolate0 : (string10 = string1, interpolate0 = interpolate(string00 = string0, value1));
	};
}
function attr_default(name, value) {
	var fullname = namespace_default(name), i = fullname === "transform" ? interpolateTransformSvg : interpolate_default;
	return this.attrTween(name, typeof value === "function" ? (fullname.local ? attrFunctionNS : attrFunction)(fullname, i, tweenValue(this, "attr." + name, value)) : value == null ? (fullname.local ? attrRemoveNS : attrRemove)(fullname) : (fullname.local ? attrConstantNS : attrConstant)(fullname, i, value));
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/attrTween.js
function attrInterpolate(name, i) {
	return function(t) {
		this.setAttribute(name, i.call(this, t));
	};
}
function attrInterpolateNS(fullname, i) {
	return function(t) {
		this.setAttributeNS(fullname.space, fullname.local, i.call(this, t));
	};
}
function attrTweenNS(fullname, value) {
	var t0, i0;
	function tween() {
		var i = value.apply(this, arguments);
		if (i !== i0) t0 = (i0 = i) && attrInterpolateNS(fullname, i);
		return t0;
	}
	tween._value = value;
	return tween;
}
function attrTween(name, value) {
	var t0, i0;
	function tween() {
		var i = value.apply(this, arguments);
		if (i !== i0) t0 = (i0 = i) && attrInterpolate(name, i);
		return t0;
	}
	tween._value = value;
	return tween;
}
function attrTween_default(name, value) {
	var key = "attr." + name;
	if (arguments.length < 2) return (key = this.tween(key)) && key._value;
	if (value == null) return this.tween(key, null);
	if (typeof value !== "function") throw new Error();
	var fullname = namespace_default(name);
	return this.tween(key, (fullname.local ? attrTweenNS : attrTween)(fullname, value));
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/delay.js
function delayFunction(id, value) {
	return function() {
		init(this, id).delay = +value.apply(this, arguments);
	};
}
function delayConstant(id, value) {
	return value = +value, function() {
		init(this, id).delay = value;
	};
}
function delay_default(value) {
	var id = this._id;
	return arguments.length ? this.each((typeof value === "function" ? delayFunction : delayConstant)(id, value)) : get(this.node(), id).delay;
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/duration.js
function durationFunction(id, value) {
	return function() {
		set(this, id).duration = +value.apply(this, arguments);
	};
}
function durationConstant(id, value) {
	return value = +value, function() {
		set(this, id).duration = value;
	};
}
function duration_default(value) {
	var id = this._id;
	return arguments.length ? this.each((typeof value === "function" ? durationFunction : durationConstant)(id, value)) : get(this.node(), id).duration;
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/ease.js
function easeConstant(id, value) {
	if (typeof value !== "function") throw new Error();
	return function() {
		set(this, id).ease = value;
	};
}
function ease_default(value) {
	var id = this._id;
	return arguments.length ? this.each(easeConstant(id, value)) : get(this.node(), id).ease;
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/easeVarying.js
function easeVarying(id, value) {
	return function() {
		var v = value.apply(this, arguments);
		if (typeof v !== "function") throw new Error();
		set(this, id).ease = v;
	};
}
function easeVarying_default(value) {
	if (typeof value !== "function") throw new Error();
	return this.each(easeVarying(this._id, value));
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/filter.js
function filter_default(match) {
	if (typeof match !== "function") match = matcher_default(match);
	for (var groups = this._groups, m = groups.length, subgroups = new Array(m), j = 0; j < m; ++j) for (var group = groups[j], n = group.length, subgroup = subgroups[j] = [], node, i = 0; i < n; ++i) if ((node = group[i]) && match.call(node, node.__data__, i, group)) subgroup.push(node);
	return new Transition(subgroups, this._parents, this._name, this._id);
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/merge.js
function merge_default(transition) {
	if (transition._id !== this._id) throw new Error();
	for (var groups0 = this._groups, groups1 = transition._groups, m0 = groups0.length, m1 = groups1.length, m = Math.min(m0, m1), merges = new Array(m0), j = 0; j < m; ++j) for (var group0 = groups0[j], group1 = groups1[j], n = group0.length, merge = merges[j] = new Array(n), node, i = 0; i < n; ++i) if (node = group0[i] || group1[i]) merge[i] = node;
	for (; j < m0; ++j) merges[j] = groups0[j];
	return new Transition(merges, this._parents, this._name, this._id);
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/on.js
function start(name) {
	return (name + "").trim().split(/^|\s+/).every(function(t) {
		var i = t.indexOf(".");
		if (i >= 0) t = t.slice(0, i);
		return !t || t === "start";
	});
}
function onFunction(id, name, listener) {
	var on0, on1, sit = start(name) ? init : set;
	return function() {
		var schedule = sit(this, id), on = schedule.on;
		if (on !== on0) (on1 = (on0 = on).copy()).on(name, listener);
		schedule.on = on1;
	};
}
function on_default(name, listener) {
	var id = this._id;
	return arguments.length < 2 ? get(this.node(), id).on.on(name) : this.each(onFunction(id, name, listener));
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/remove.js
function removeFunction(id) {
	return function() {
		var parent = this.parentNode;
		for (var i in this.__transition) if (+i !== id) return;
		if (parent) parent.removeChild(this);
	};
}
function remove_default() {
	return this.on("end.remove", removeFunction(this._id));
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/select.js
function select_default(select) {
	var name = this._name, id = this._id;
	if (typeof select !== "function") select = selector_default(select);
	for (var groups = this._groups, m = groups.length, subgroups = new Array(m), j = 0; j < m; ++j) for (var group = groups[j], n = group.length, subgroup = subgroups[j] = new Array(n), node, subnode, i = 0; i < n; ++i) if ((node = group[i]) && (subnode = select.call(node, node.__data__, i, group))) {
		if ("__data__" in node) subnode.__data__ = node.__data__;
		subgroup[i] = subnode;
		schedule_default(subgroup[i], name, id, i, subgroup, get(node, id));
	}
	return new Transition(subgroups, this._parents, name, id);
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/selectAll.js
function selectAll_default(select) {
	var name = this._name, id = this._id;
	if (typeof select !== "function") select = selectorAll_default(select);
	for (var groups = this._groups, m = groups.length, subgroups = [], parents = [], j = 0; j < m; ++j) for (var group = groups[j], n = group.length, node, i = 0; i < n; ++i) if (node = group[i]) {
		for (var children = select.call(node, node.__data__, i, group), child, inherit = get(node, id), k = 0, l = children.length; k < l; ++k) if (child = children[k]) schedule_default(child, name, id, k, children, inherit);
		subgroups.push(children);
		parents.push(node);
	}
	return new Transition(subgroups, parents, name, id);
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/selection.js
var Selection = selection.prototype.constructor;
function selection_default() {
	return new Selection(this._groups, this._parents);
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/style.js
function styleNull(name, interpolate) {
	var string00, string10, interpolate0;
	return function() {
		var string0 = styleValue(this, name), string1 = (this.style.removeProperty(name), styleValue(this, name));
		return string0 === string1 ? null : string0 === string00 && string1 === string10 ? interpolate0 : interpolate0 = interpolate(string00 = string0, string10 = string1);
	};
}
function styleRemove(name) {
	return function() {
		this.style.removeProperty(name);
	};
}
function styleConstant(name, interpolate, value1) {
	var string00, string1 = value1 + "", interpolate0;
	return function() {
		var string0 = styleValue(this, name);
		return string0 === string1 ? null : string0 === string00 ? interpolate0 : interpolate0 = interpolate(string00 = string0, value1);
	};
}
function styleFunction(name, interpolate, value) {
	var string00, string10, interpolate0;
	return function() {
		var string0 = styleValue(this, name), value1 = value(this), string1 = value1 + "";
		if (value1 == null) string1 = value1 = (this.style.removeProperty(name), styleValue(this, name));
		return string0 === string1 ? null : string0 === string00 && string1 === string10 ? interpolate0 : (string10 = string1, interpolate0 = interpolate(string00 = string0, value1));
	};
}
function styleMaybeRemove(id, name) {
	var on0, on1, listener0, key = "style." + name, event = "end." + key, remove;
	return function() {
		var schedule = set(this, id), on = schedule.on, listener = schedule.value[key] == null ? remove || (remove = styleRemove(name)) : void 0;
		if (on !== on0 || listener0 !== listener) (on1 = (on0 = on).copy()).on(event, listener0 = listener);
		schedule.on = on1;
	};
}
function style_default(name, value, priority) {
	var i = (name += "") === "transform" ? interpolateTransformCss : interpolate_default;
	return value == null ? this.styleTween(name, styleNull(name, i)).on("end.style." + name, styleRemove(name)) : typeof value === "function" ? this.styleTween(name, styleFunction(name, i, tweenValue(this, "style." + name, value))).each(styleMaybeRemove(this._id, name)) : this.styleTween(name, styleConstant(name, i, value), priority).on("end.style." + name, null);
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/styleTween.js
function styleInterpolate(name, i, priority) {
	return function(t) {
		this.style.setProperty(name, i.call(this, t), priority);
	};
}
function styleTween(name, value, priority) {
	var t, i0;
	function tween() {
		var i = value.apply(this, arguments);
		if (i !== i0) t = (i0 = i) && styleInterpolate(name, i, priority);
		return t;
	}
	tween._value = value;
	return tween;
}
function styleTween_default(name, value, priority) {
	var key = "style." + (name += "");
	if (arguments.length < 2) return (key = this.tween(key)) && key._value;
	if (value == null) return this.tween(key, null);
	if (typeof value !== "function") throw new Error();
	return this.tween(key, styleTween(name, value, priority == null ? "" : priority));
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/text.js
function textConstant(value) {
	return function() {
		this.textContent = value;
	};
}
function textFunction(value) {
	return function() {
		var value1 = value(this);
		this.textContent = value1 == null ? "" : value1;
	};
}
function text_default(value) {
	return this.tween("text", typeof value === "function" ? textFunction(tweenValue(this, "text", value)) : textConstant(value == null ? "" : value + ""));
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/textTween.js
function textInterpolate(i) {
	return function(t) {
		this.textContent = i.call(this, t);
	};
}
function textTween(value) {
	var t0, i0;
	function tween() {
		var i = value.apply(this, arguments);
		if (i !== i0) t0 = (i0 = i) && textInterpolate(i);
		return t0;
	}
	tween._value = value;
	return tween;
}
function textTween_default(value) {
	var key = "text";
	if (arguments.length < 1) return (key = this.tween(key)) && key._value;
	if (value == null) return this.tween(key, null);
	if (typeof value !== "function") throw new Error();
	return this.tween(key, textTween(value));
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/transition.js
function transition_default$1() {
	var name = this._name, id0 = this._id, id1 = newId();
	for (var groups = this._groups, m = groups.length, j = 0; j < m; ++j) for (var group = groups[j], n = group.length, node, i = 0; i < n; ++i) if (node = group[i]) {
		var inherit = get(node, id0);
		schedule_default(node, name, id1, i, group, {
			time: inherit.time + inherit.delay + inherit.duration,
			delay: 0,
			duration: inherit.duration,
			ease: inherit.ease
		});
	}
	return new Transition(groups, this._parents, name, id1);
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/end.js
function end_default() {
	var on0, on1, that = this, id = that._id, size = that.size();
	return new Promise(function(resolve, reject) {
		var cancel = { value: reject }, end = { value: function() {
			if (--size === 0) resolve();
		} };
		that.each(function() {
			var schedule = set(this, id), on = schedule.on;
			if (on !== on0) {
				on1 = (on0 = on).copy();
				on1._.cancel.push(cancel);
				on1._.interrupt.push(cancel);
				on1._.end.push(end);
			}
			schedule.on = on1;
		});
		if (size === 0) resolve();
	});
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/transition/index.js
var id = 0;
function Transition(groups, parents, name, id) {
	this._groups = groups;
	this._parents = parents;
	this._name = name;
	this._id = id;
}
function transition(name) {
	return selection().transition(name);
}
function newId() {
	return ++id;
}
var selection_prototype = selection.prototype;
Transition.prototype = transition.prototype = {
	constructor: Transition,
	select: select_default,
	selectAll: selectAll_default,
	selectChild: selection_prototype.selectChild,
	selectChildren: selection_prototype.selectChildren,
	filter: filter_default,
	merge: merge_default,
	selection: selection_default,
	transition: transition_default$1,
	call: selection_prototype.call,
	nodes: selection_prototype.nodes,
	node: selection_prototype.node,
	size: selection_prototype.size,
	empty: selection_prototype.empty,
	each: selection_prototype.each,
	on: on_default,
	attr: attr_default,
	attrTween: attrTween_default,
	style: style_default,
	styleTween: styleTween_default,
	text: text_default,
	textTween: textTween_default,
	remove: remove_default,
	tween: tween_default,
	delay: delay_default,
	duration: duration_default,
	ease: ease_default,
	easeVarying: easeVarying_default,
	end: end_default,
	[Symbol.iterator]: selection_prototype[Symbol.iterator]
};

//#endregion
//#region node_modules/.bun/d3-ease@3.0.1/node_modules/d3-ease/src/cubic.js
function cubicInOut(t) {
	return ((t *= 2) <= 1 ? t * t * t : (t -= 2) * t * t + 2) / 2;
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/selection/transition.js
var defaultTiming = {
	time: null,
	delay: 0,
	duration: 250,
	ease: cubicInOut
};
function inherit(node, id) {
	var timing;
	while (!(timing = node.__transition) || !(timing = timing[id])) if (!(node = node.parentNode)) throw new Error(`transition ${id} not found`);
	return timing;
}
function transition_default(name) {
	var id, timing;
	if (name instanceof Transition) id = name._id, name = name._name;
	else id = newId(), (timing = defaultTiming).time = now(), name = name == null ? null : name + "";
	for (var groups = this._groups, m = groups.length, j = 0; j < m; ++j) for (var group = groups[j], n = group.length, node, i = 0; i < n; ++i) if (node = group[i]) schedule_default(node, name, id, i, group, timing || inherit(node, id));
	return new Transition(groups, this._parents, name, id);
}

//#endregion
//#region node_modules/.bun/d3-transition@3.0.1+ddb27bb92657a88b/node_modules/d3-transition/src/selection/index.js
selection.prototype.interrupt = interrupt_default;
selection.prototype.transition = transition_default;

//#endregion
//#region node_modules/.bun/d3-zoom@3.0.0/node_modules/d3-zoom/src/constant.js
var constant_default = (x) => () => x;

//#endregion
//#region node_modules/.bun/d3-zoom@3.0.0/node_modules/d3-zoom/src/event.js
function ZoomEvent(type, { sourceEvent, target, transform, dispatch }) {
	Object.defineProperties(this, {
		type: {
			value: type,
			enumerable: true,
			configurable: true
		},
		sourceEvent: {
			value: sourceEvent,
			enumerable: true,
			configurable: true
		},
		target: {
			value: target,
			enumerable: true,
			configurable: true
		},
		transform: {
			value: transform,
			enumerable: true,
			configurable: true
		},
		_: { value: dispatch }
	});
}

//#endregion
//#region node_modules/.bun/d3-zoom@3.0.0/node_modules/d3-zoom/src/transform.js
function Transform(k, x, y) {
	this.k = k;
	this.x = x;
	this.y = y;
}
Transform.prototype = {
	constructor: Transform,
	scale: function(k) {
		return k === 1 ? this : new Transform(this.k * k, this.x, this.y);
	},
	translate: function(x, y) {
		return x === 0 & y === 0 ? this : new Transform(this.k, this.x + this.k * x, this.y + this.k * y);
	},
	apply: function(point) {
		return [point[0] * this.k + this.x, point[1] * this.k + this.y];
	},
	applyX: function(x) {
		return x * this.k + this.x;
	},
	applyY: function(y) {
		return y * this.k + this.y;
	},
	invert: function(location) {
		return [(location[0] - this.x) / this.k, (location[1] - this.y) / this.k];
	},
	invertX: function(x) {
		return (x - this.x) / this.k;
	},
	invertY: function(y) {
		return (y - this.y) / this.k;
	},
	rescaleX: function(x) {
		return x.copy().domain(x.range().map(this.invertX, this).map(x.invert, x));
	},
	rescaleY: function(y) {
		return y.copy().domain(y.range().map(this.invertY, this).map(y.invert, y));
	},
	toString: function() {
		return "translate(" + this.x + "," + this.y + ") scale(" + this.k + ")";
	}
};
var identity$1 = new Transform(1, 0, 0);
transform.prototype = Transform.prototype;
function transform(node) {
	while (!node.__zoom) if (!(node = node.parentNode)) return identity$1;
	return node.__zoom;
}

//#endregion
//#region node_modules/.bun/d3-zoom@3.0.0/node_modules/d3-zoom/src/noevent.js
function nopropagation(event) {
	event.stopImmediatePropagation();
}
function noevent_default(event) {
	event.preventDefault();
	event.stopImmediatePropagation();
}

//#endregion
//#region node_modules/.bun/d3-zoom@3.0.0/node_modules/d3-zoom/src/zoom.js
function defaultFilter(event) {
	return (!event.ctrlKey || event.type === "wheel") && !event.button;
}
function defaultExtent() {
	var e = this;
	if (e instanceof SVGElement) {
		e = e.ownerSVGElement || e;
		if (e.hasAttribute("viewBox")) {
			e = e.viewBox.baseVal;
			return [[e.x, e.y], [e.x + e.width, e.y + e.height]];
		}
		return [[0, 0], [e.width.baseVal.value, e.height.baseVal.value]];
	}
	return [[0, 0], [e.clientWidth, e.clientHeight]];
}
function defaultTransform() {
	return this.__zoom || identity$1;
}
function defaultWheelDelta(event) {
	return -event.deltaY * (event.deltaMode === 1 ? .05 : event.deltaMode ? 1 : .002) * (event.ctrlKey ? 10 : 1);
}
function defaultTouchable() {
	return navigator.maxTouchPoints || "ontouchstart" in this;
}
function defaultConstrain(transform, extent, translateExtent) {
	var dx0 = transform.invertX(extent[0][0]) - translateExtent[0][0], dx1 = transform.invertX(extent[1][0]) - translateExtent[1][0], dy0 = transform.invertY(extent[0][1]) - translateExtent[0][1], dy1 = transform.invertY(extent[1][1]) - translateExtent[1][1];
	return transform.translate(dx1 > dx0 ? (dx0 + dx1) / 2 : Math.min(0, dx0) || Math.max(0, dx1), dy1 > dy0 ? (dy0 + dy1) / 2 : Math.min(0, dy0) || Math.max(0, dy1));
}
function zoom_default() {
	var filter = defaultFilter, extent = defaultExtent, constrain = defaultConstrain, wheelDelta = defaultWheelDelta, touchable = defaultTouchable, scaleExtent = [0, Infinity], translateExtent = [[-Infinity, -Infinity], [Infinity, Infinity]], duration = 250, interpolate = zoom_default$1, listeners = dispatch("start", "zoom", "end"), touchstarting, touchfirst, touchending, touchDelay = 500, wheelDelay = 150, clickDistance2 = 0, tapDistance = 10;
	function zoom(selection) {
		selection.property("__zoom", defaultTransform).on("wheel.zoom", wheeled, { passive: false }).on("mousedown.zoom", mousedowned).on("dblclick.zoom", dblclicked).filter(touchable).on("touchstart.zoom", touchstarted).on("touchmove.zoom", touchmoved).on("touchend.zoom touchcancel.zoom", touchended).style("-webkit-tap-highlight-color", "rgba(0,0,0,0)");
	}
	zoom.transform = function(collection, transform, point, event) {
		var selection = collection.selection ? collection.selection() : collection;
		selection.property("__zoom", defaultTransform);
		if (collection !== selection) schedule(collection, transform, point, event);
		else selection.interrupt().each(function() {
			gesture(this, arguments).event(event).start().zoom(null, typeof transform === "function" ? transform.apply(this, arguments) : transform).end();
		});
	};
	zoom.scaleBy = function(selection, k, p, event) {
		zoom.scaleTo(selection, function() {
			return this.__zoom.k * (typeof k === "function" ? k.apply(this, arguments) : k);
		}, p, event);
	};
	zoom.scaleTo = function(selection, k, p, event) {
		zoom.transform(selection, function() {
			var e = extent.apply(this, arguments), t0 = this.__zoom, p0 = p == null ? centroid(e) : typeof p === "function" ? p.apply(this, arguments) : p, p1 = t0.invert(p0), k1 = typeof k === "function" ? k.apply(this, arguments) : k;
			return constrain(translate(scale(t0, k1), p0, p1), e, translateExtent);
		}, p, event);
	};
	zoom.translateBy = function(selection, x, y, event) {
		zoom.transform(selection, function() {
			return constrain(this.__zoom.translate(typeof x === "function" ? x.apply(this, arguments) : x, typeof y === "function" ? y.apply(this, arguments) : y), extent.apply(this, arguments), translateExtent);
		}, null, event);
	};
	zoom.translateTo = function(selection, x, y, p, event) {
		zoom.transform(selection, function() {
			var e = extent.apply(this, arguments), t = this.__zoom, p0 = p == null ? centroid(e) : typeof p === "function" ? p.apply(this, arguments) : p;
			return constrain(identity$1.translate(p0[0], p0[1]).scale(t.k).translate(typeof x === "function" ? -x.apply(this, arguments) : -x, typeof y === "function" ? -y.apply(this, arguments) : -y), e, translateExtent);
		}, p, event);
	};
	function scale(transform, k) {
		k = Math.max(scaleExtent[0], Math.min(scaleExtent[1], k));
		return k === transform.k ? transform : new Transform(k, transform.x, transform.y);
	}
	function translate(transform, p0, p1) {
		var x = p0[0] - p1[0] * transform.k, y = p0[1] - p1[1] * transform.k;
		return x === transform.x && y === transform.y ? transform : new Transform(transform.k, x, y);
	}
	function centroid(extent) {
		return [(+extent[0][0] + +extent[1][0]) / 2, (+extent[0][1] + +extent[1][1]) / 2];
	}
	function schedule(transition, transform, point, event) {
		transition.on("start.zoom", function() {
			gesture(this, arguments).event(event).start();
		}).on("interrupt.zoom end.zoom", function() {
			gesture(this, arguments).event(event).end();
		}).tween("zoom", function() {
			var that = this, args = arguments, g = gesture(that, args).event(event), e = extent.apply(that, args), p = point == null ? centroid(e) : typeof point === "function" ? point.apply(that, args) : point, w = Math.max(e[1][0] - e[0][0], e[1][1] - e[0][1]), a = that.__zoom, b = typeof transform === "function" ? transform.apply(that, args) : transform, i = interpolate(a.invert(p).concat(w / a.k), b.invert(p).concat(w / b.k));
			return function(t) {
				if (t === 1) t = b;
				else {
					var l = i(t), k = w / l[2];
					t = new Transform(k, p[0] - l[0] * k, p[1] - l[1] * k);
				}
				g.zoom(null, t);
			};
		});
	}
	function gesture(that, args, clean) {
		return !clean && that.__zooming || new Gesture(that, args);
	}
	function Gesture(that, args) {
		this.that = that;
		this.args = args;
		this.active = 0;
		this.sourceEvent = null;
		this.extent = extent.apply(that, args);
		this.taps = 0;
	}
	Gesture.prototype = {
		event: function(event) {
			if (event) this.sourceEvent = event;
			return this;
		},
		start: function() {
			if (++this.active === 1) {
				this.that.__zooming = this;
				this.emit("start");
			}
			return this;
		},
		zoom: function(key, transform) {
			if (this.mouse && key !== "mouse") this.mouse[1] = transform.invert(this.mouse[0]);
			if (this.touch0 && key !== "touch") this.touch0[1] = transform.invert(this.touch0[0]);
			if (this.touch1 && key !== "touch") this.touch1[1] = transform.invert(this.touch1[0]);
			this.that.__zoom = transform;
			this.emit("zoom");
			return this;
		},
		end: function() {
			if (--this.active === 0) {
				delete this.that.__zooming;
				this.emit("end");
			}
			return this;
		},
		emit: function(type) {
			var d = select_default$1(this.that).datum();
			listeners.call(type, this.that, new ZoomEvent(type, {
				sourceEvent: this.sourceEvent,
				target: zoom,
				type,
				transform: this.that.__zoom,
				dispatch: listeners
			}), d);
		}
	};
	function wheeled(event, ...args) {
		if (!filter.apply(this, arguments)) return;
		var g = gesture(this, args).event(event), t = this.__zoom, k = Math.max(scaleExtent[0], Math.min(scaleExtent[1], t.k * Math.pow(2, wheelDelta.apply(this, arguments)))), p = pointer_default(event);
		if (g.wheel) {
			if (g.mouse[0][0] !== p[0] || g.mouse[0][1] !== p[1]) g.mouse[1] = t.invert(g.mouse[0] = p);
			clearTimeout(g.wheel);
		} else if (t.k === k) return;
		else {
			g.mouse = [p, t.invert(p)];
			interrupt_default$1(this);
			g.start();
		}
		noevent_default(event);
		g.wheel = setTimeout(wheelidled, wheelDelay);
		g.zoom("mouse", constrain(translate(scale(t, k), g.mouse[0], g.mouse[1]), g.extent, translateExtent));
		function wheelidled() {
			g.wheel = null;
			g.end();
		}
	}
	function mousedowned(event, ...args) {
		if (touchending || !filter.apply(this, arguments)) return;
		var currentTarget = event.currentTarget, g = gesture(this, args, true).event(event), v = select_default$1(event.view).on("mousemove.zoom", mousemoved, true).on("mouseup.zoom", mouseupped, true), p = pointer_default(event, currentTarget), x0 = event.clientX, y0 = event.clientY;
		nodrag_default(event.view);
		nopropagation(event);
		g.mouse = [p, this.__zoom.invert(p)];
		interrupt_default$1(this);
		g.start();
		function mousemoved(event) {
			noevent_default(event);
			if (!g.moved) {
				var dx = event.clientX - x0, dy = event.clientY - y0;
				g.moved = dx * dx + dy * dy > clickDistance2;
			}
			g.event(event).zoom("mouse", constrain(translate(g.that.__zoom, g.mouse[0] = pointer_default(event, currentTarget), g.mouse[1]), g.extent, translateExtent));
		}
		function mouseupped(event) {
			v.on("mousemove.zoom mouseup.zoom", null);
			yesdrag(event.view, g.moved);
			noevent_default(event);
			g.event(event).end();
		}
	}
	function dblclicked(event, ...args) {
		if (!filter.apply(this, arguments)) return;
		var t0 = this.__zoom, p0 = pointer_default(event.changedTouches ? event.changedTouches[0] : event, this), p1 = t0.invert(p0), k1 = t0.k * (event.shiftKey ? .5 : 2), t1 = constrain(translate(scale(t0, k1), p0, p1), extent.apply(this, args), translateExtent);
		noevent_default(event);
		if (duration > 0) select_default$1(this).transition().duration(duration).call(schedule, t1, p0, event);
		else select_default$1(this).call(zoom.transform, t1, p0, event);
	}
	function touchstarted(event, ...args) {
		if (!filter.apply(this, arguments)) return;
		var touches = event.touches, n = touches.length, g = gesture(this, args, event.changedTouches.length === n).event(event), started, i, t, p;
		nopropagation(event);
		for (i = 0; i < n; ++i) {
			t = touches[i], p = pointer_default(t, this);
			p = [
				p,
				this.__zoom.invert(p),
				t.identifier
			];
			if (!g.touch0) g.touch0 = p, started = true, g.taps = 1 + !!touchstarting;
			else if (!g.touch1 && g.touch0[2] !== p[2]) g.touch1 = p, g.taps = 0;
		}
		if (touchstarting) touchstarting = clearTimeout(touchstarting);
		if (started) {
			if (g.taps < 2) touchfirst = p[0], touchstarting = setTimeout(function() {
				touchstarting = null;
			}, touchDelay);
			interrupt_default$1(this);
			g.start();
		}
	}
	function touchmoved(event, ...args) {
		if (!this.__zooming) return;
		var g = gesture(this, args).event(event), touches = event.changedTouches, n = touches.length, i, t, p, l;
		noevent_default(event);
		for (i = 0; i < n; ++i) {
			t = touches[i], p = pointer_default(t, this);
			if (g.touch0 && g.touch0[2] === t.identifier) g.touch0[0] = p;
			else if (g.touch1 && g.touch1[2] === t.identifier) g.touch1[0] = p;
		}
		t = g.that.__zoom;
		if (g.touch1) {
			var p0 = g.touch0[0], l0 = g.touch0[1], p1 = g.touch1[0], l1 = g.touch1[1], dp = (dp = p1[0] - p0[0]) * dp + (dp = p1[1] - p0[1]) * dp, dl = (dl = l1[0] - l0[0]) * dl + (dl = l1[1] - l0[1]) * dl;
			t = scale(t, Math.sqrt(dp / dl));
			p = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
			l = [(l0[0] + l1[0]) / 2, (l0[1] + l1[1]) / 2];
		} else if (g.touch0) p = g.touch0[0], l = g.touch0[1];
		else return;
		g.zoom("touch", constrain(translate(t, p, l), g.extent, translateExtent));
	}
	function touchended(event, ...args) {
		if (!this.__zooming) return;
		var g = gesture(this, args).event(event), touches = event.changedTouches, n = touches.length, i, t;
		nopropagation(event);
		if (touchending) clearTimeout(touchending);
		touchending = setTimeout(function() {
			touchending = null;
		}, touchDelay);
		for (i = 0; i < n; ++i) {
			t = touches[i];
			if (g.touch0 && g.touch0[2] === t.identifier) delete g.touch0;
			else if (g.touch1 && g.touch1[2] === t.identifier) delete g.touch1;
		}
		if (g.touch1 && !g.touch0) g.touch0 = g.touch1, delete g.touch1;
		if (g.touch0) g.touch0[1] = this.__zoom.invert(g.touch0[0]);
		else {
			g.end();
			if (g.taps === 2) {
				t = pointer_default(t, this);
				if (Math.hypot(touchfirst[0] - t[0], touchfirst[1] - t[1]) < tapDistance) {
					var p = select_default$1(this).on("dblclick.zoom");
					if (p) p.apply(this, arguments);
				}
			}
		}
	}
	zoom.wheelDelta = function(_) {
		return arguments.length ? (wheelDelta = typeof _ === "function" ? _ : constant_default(+_), zoom) : wheelDelta;
	};
	zoom.filter = function(_) {
		return arguments.length ? (filter = typeof _ === "function" ? _ : constant_default(!!_), zoom) : filter;
	};
	zoom.touchable = function(_) {
		return arguments.length ? (touchable = typeof _ === "function" ? _ : constant_default(!!_), zoom) : touchable;
	};
	zoom.extent = function(_) {
		return arguments.length ? (extent = typeof _ === "function" ? _ : constant_default([[+_[0][0], +_[0][1]], [+_[1][0], +_[1][1]]]), zoom) : extent;
	};
	zoom.scaleExtent = function(_) {
		return arguments.length ? (scaleExtent[0] = +_[0], scaleExtent[1] = +_[1], zoom) : [scaleExtent[0], scaleExtent[1]];
	};
	zoom.translateExtent = function(_) {
		return arguments.length ? (translateExtent[0][0] = +_[0][0], translateExtent[1][0] = +_[1][0], translateExtent[0][1] = +_[0][1], translateExtent[1][1] = +_[1][1], zoom) : [[translateExtent[0][0], translateExtent[0][1]], [translateExtent[1][0], translateExtent[1][1]]];
	};
	zoom.constrain = function(_) {
		return arguments.length ? (constrain = _, zoom) : constrain;
	};
	zoom.duration = function(_) {
		return arguments.length ? (duration = +_, zoom) : duration;
	};
	zoom.interpolate = function(_) {
		return arguments.length ? (interpolate = _, zoom) : interpolate;
	};
	zoom.on = function() {
		var value = listeners.on.apply(listeners, arguments);
		return value === listeners ? zoom : value;
	};
	zoom.clickDistance = function(_) {
		return arguments.length ? (clickDistance2 = (_ = +_) * _, zoom) : Math.sqrt(clickDistance2);
	};
	zoom.tapDistance = function(_) {
		return arguments.length ? (tapDistance = +_, zoom) : tapDistance;
	};
	return zoom;
}

//#endregion
//#region node_modules/.bun/@xyflow+system@0.0.76/node_modules/@xyflow/system/dist/esm/index.js
const errorMessages = {
	error001: () => "[React Flow]: Seems like you have not used zustand provider as an ancestor. Help: https://reactflow.dev/error#001",
	error002: () => "It looks like you've created a new nodeTypes or edgeTypes object. If this wasn't on purpose please define the nodeTypes/edgeTypes outside of the component or memoize them.",
	error003: (nodeType) => `Node type "${nodeType}" not found. Using fallback type "default".`,
	error004: () => "The React Flow parent container needs a width and a height to render the graph.",
	error005: () => "Only child nodes can use a parent extent.",
	error006: () => "Can't create edge. An edge needs a source and a target.",
	error007: (id) => `The old edge with id=${id} does not exist.`,
	error009: (type) => `Marker type "${type}" doesn't exist.`,
	error008: (handleType, { id, sourceHandle, targetHandle }) => `Couldn't create edge for ${handleType} handle id: "${handleType === "source" ? sourceHandle : targetHandle}", edge id: ${id}.`,
	error010: () => "Handle: No node id found. Make sure to only use a Handle inside a custom Node.",
	error011: (edgeType) => `Edge type "${edgeType}" not found. Using fallback type "default".`,
	error012: (id) => `Node with id "${id}" does not exist, it may have been removed. This can happen when a node is deleted before the "onNodeClick" handler is called.`,
	error013: (lib = "react") => `It seems that you haven't loaded the styles. Please import '@xyflow/${lib}/dist/style.css' or base.css to make sure everything is working properly.`,
	error014: () => "useNodeConnections: No node ID found. Call useNodeConnections inside a custom Node or provide a node ID.",
	error015: () => "It seems that you are trying to drag a node that is not initialized. Please use onNodesChange as explained in the docs."
};
const infiniteExtent = [[Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]];
const elementSelectionKeys = [
	"Enter",
	" ",
	"Escape"
];
const defaultAriaLabelConfig = {
	"node.a11yDescription.default": "Press enter or space to select a node. Press delete to remove it and escape to cancel.",
	"node.a11yDescription.keyboardDisabled": "Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel.",
	"node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) => `Moved selected node ${direction}. New position, x: ${x}, y: ${y}`,
	"edge.a11yDescription.default": "Press enter or space to select an edge. You can then press delete to remove it or escape to cancel.",
	"controls.ariaLabel": "Control Panel",
	"controls.zoomIn.ariaLabel": "Zoom In",
	"controls.zoomOut.ariaLabel": "Zoom Out",
	"controls.fitView.ariaLabel": "Fit View",
	"controls.interactive.ariaLabel": "Toggle Interactivity",
	"minimap.ariaLabel": "Mini Map",
	"handle.ariaLabel": "Handle"
};
/**
* The `ConnectionMode` is used to set the mode of connection between nodes.
* The `Strict` mode is the default one and only allows source to target edges.
* `Loose` mode allows source to source and target to target edges as well.
*
* @public
*/
var ConnectionMode;
(function(ConnectionMode) {
	ConnectionMode["Strict"] = "strict";
	ConnectionMode["Loose"] = "loose";
})(ConnectionMode || (ConnectionMode = {}));
/**
* This enum is used to set the different modes of panning the viewport when the
* user scrolls. The `Free` mode allows the user to pan in any direction by scrolling
* with a device like a trackpad. The `Vertical` and `Horizontal` modes restrict
* scroll panning to only the vertical or horizontal axis, respectively.
*
* @public
*/
var PanOnScrollMode;
(function(PanOnScrollMode) {
	PanOnScrollMode["Free"] = "free";
	PanOnScrollMode["Vertical"] = "vertical";
	PanOnScrollMode["Horizontal"] = "horizontal";
})(PanOnScrollMode || (PanOnScrollMode = {}));
var SelectionMode;
(function(SelectionMode) {
	SelectionMode["Partial"] = "partial";
	SelectionMode["Full"] = "full";
})(SelectionMode || (SelectionMode = {}));
const initialConnection = {
	inProgress: false,
	isValid: null,
	from: null,
	fromHandle: null,
	fromPosition: null,
	fromNode: null,
	to: null,
	toHandle: null,
	toPosition: null,
	toNode: null,
	pointer: null
};
/**
* If you set the `connectionLineType` prop on your [`<ReactFlow />`](/api-reference/react-flow#connection-connectionLineType)
*component, it will dictate the style of connection line rendered when creating
*new edges.
*
* @public
*
* @remarks If you choose to render a custom connection line component, this value will be
*passed to your component as part of its [`ConnectionLineComponentProps`](/api-reference/types/connection-line-component-props).
*/
var ConnectionLineType;
(function(ConnectionLineType) {
	ConnectionLineType["Bezier"] = "default";
	ConnectionLineType["Straight"] = "straight";
	ConnectionLineType["Step"] = "step";
	ConnectionLineType["SmoothStep"] = "smoothstep";
	ConnectionLineType["SimpleBezier"] = "simplebezier";
})(ConnectionLineType || (ConnectionLineType = {}));
/**
* Edges may optionally have a marker on either end. The MarkerType type enumerates
* the options available to you when configuring a given marker.
*
* @public
*/
var MarkerType;
(function(MarkerType) {
	MarkerType["Arrow"] = "arrow";
	MarkerType["ArrowClosed"] = "arrowclosed";
})(MarkerType || (MarkerType = {}));
/**
* While [`PanelPosition`](/api-reference/types/panel-position) can be used to place a
* component in the corners of a container, the `Position` enum is less precise and used
* primarily in relation to edges and handles.
*
* @public
*/
var Position;
(function(Position) {
	Position["Left"] = "left";
	Position["Top"] = "top";
	Position["Right"] = "right";
	Position["Bottom"] = "bottom";
})(Position || (Position = {}));
const oppositePosition = {
	[Position.Left]: Position.Right,
	[Position.Right]: Position.Left,
	[Position.Top]: Position.Bottom,
	[Position.Bottom]: Position.Top
};
function getConnectionStatus(isValid) {
	return isValid === null ? null : isValid ? "valid" : "invalid";
}
/**
* Test whether an object is usable as an Edge
* @public
* @remarks In TypeScript this is a type guard that will narrow the type of whatever you pass in to Edge if it returns true
* @param element - The element to test
* @returns A boolean indicating whether the element is an Edge
*/
const isEdgeBase = (element) => "id" in element && "source" in element && "target" in element;
/**
* Test whether an object is usable as a Node
* @public
* @remarks In TypeScript this is a type guard that will narrow the type of whatever you pass in to Node if it returns true
* @param element - The element to test
* @returns A boolean indicating whether the element is an Node
*/
const isNodeBase = (element) => "id" in element && "position" in element && !("source" in element) && !("target" in element);
const isInternalNodeBase = (element) => "id" in element && "internals" in element && !("source" in element) && !("target" in element);
const getNodePositionWithOrigin = (node, nodeOrigin = [0, 0]) => {
	const { width, height } = getNodeDimensions(node);
	const origin = node.origin ?? nodeOrigin;
	const offsetX = width * origin[0];
	const offsetY = height * origin[1];
	return {
		x: node.position.x - offsetX,
		y: node.position.y - offsetY
	};
};
/**
* Returns the bounding box that contains all the given nodes in an array. This can
* be useful when combined with [`getViewportForBounds`](/api-reference/utils/get-viewport-for-bounds)
* to calculate the correct transform to fit the given nodes in a viewport.
* @public
* @remarks Useful when combined with {@link getViewportForBounds} to calculate the correct transform to fit the given nodes in a viewport.
* @param nodes - Nodes to calculate the bounds for.
* @returns Bounding box enclosing all nodes.
*
* @remarks This function was previously called `getRectOfNodes`
*
* @example
* ```js
*import { getNodesBounds } from '@xyflow/react';
*
*const nodes = [
*  {
*    id: 'a',
*    position: { x: 0, y: 0 },
*    data: { label: 'a' },
*    width: 50,
*    height: 25,
*  },
*  {
*    id: 'b',
*    position: { x: 100, y: 100 },
*    data: { label: 'b' },
*    width: 50,
*    height: 25,
*  },
*];
*
*const bounds = getNodesBounds(nodes);
*```
*/
const getNodesBounds = (nodes, params = { nodeOrigin: [0, 0] }) => {
	if (nodes.length === 0) return {
		x: 0,
		y: 0,
		width: 0,
		height: 0
	};
	return boxToRect(nodes.reduce((currBox, nodeOrId) => {
		const isId = typeof nodeOrId === "string";
		let currentNode = !params.nodeLookup && !isId ? nodeOrId : void 0;
		if (params.nodeLookup) currentNode = isId ? params.nodeLookup.get(nodeOrId) : !isInternalNodeBase(nodeOrId) ? params.nodeLookup.get(nodeOrId.id) : nodeOrId;
		return getBoundsOfBoxes(currBox, currentNode ? nodeToBox(currentNode, params.nodeOrigin) : {
			x: 0,
			y: 0,
			x2: 0,
			y2: 0
		});
	}, {
		x: Infinity,
		y: Infinity,
		x2: -Infinity,
		y2: -Infinity
	}));
};
/**
* Determines a bounding box that contains all given nodes in an array
* @internal
*/
const getInternalNodesBounds = (nodeLookup, params = {}) => {
	let box = {
		x: Infinity,
		y: Infinity,
		x2: -Infinity,
		y2: -Infinity
	};
	let hasVisibleNodes = false;
	nodeLookup.forEach((node) => {
		if (params.filter === void 0 || params.filter(node)) {
			box = getBoundsOfBoxes(box, nodeToBox(node));
			hasVisibleNodes = true;
		}
	});
	return hasVisibleNodes ? boxToRect(box) : {
		x: 0,
		y: 0,
		width: 0,
		height: 0
	};
};
const getNodesInside = (nodes, rect, [tx, ty, tScale] = [
	0,
	0,
	1
], partially = false, excludeNonSelectableNodes = false) => {
	const paneRect = {
		...pointToRendererPoint(rect, [
			tx,
			ty,
			tScale
		]),
		width: rect.width / tScale,
		height: rect.height / tScale
	};
	const visibleNodes = [];
	for (const node of nodes.values()) {
		const { measured, selectable = true, hidden = false } = node;
		if (excludeNonSelectableNodes && !selectable || hidden) continue;
		const width = measured.width ?? node.width ?? node.initialWidth ?? null;
		const height = measured.height ?? node.height ?? node.initialHeight ?? null;
		const overlappingArea = getOverlappingArea(paneRect, nodeToRect(node));
		const area = (width ?? 0) * (height ?? 0);
		const partiallyVisible = partially && overlappingArea > 0;
		if (!node.internals.handleBounds || partiallyVisible || overlappingArea >= area || node.dragging) visibleNodes.push(node);
	}
	return visibleNodes;
};
/**
* This utility filters an array of edges, keeping only those where either the source or target
* node is present in the given array of nodes.
* @public
* @param nodes - Nodes you want to get the connected edges for.
* @param edges - All edges.
* @returns Array of edges that connect any of the given nodes with each other.
*
* @example
* ```js
*import { getConnectedEdges } from '@xyflow/react';
*
*const nodes = [
*  { id: 'a', position: { x: 0, y: 0 } },
*  { id: 'b', position: { x: 100, y: 0 } },
*];
*
*const edges = [
*  { id: 'a->c', source: 'a', target: 'c' },
*  { id: 'c->d', source: 'c', target: 'd' },
*];
*
*const connectedEdges = getConnectedEdges(nodes, edges);
* // => [{ id: 'a->c', source: 'a', target: 'c' }]
*```
*/
const getConnectedEdges = (nodes, edges) => {
	const nodeIds = /* @__PURE__ */ new Set();
	nodes.forEach((node) => {
		nodeIds.add(node.id);
	});
	return edges.filter((edge) => nodeIds.has(edge.source) || nodeIds.has(edge.target));
};
function getFitViewNodes(nodeLookup, options) {
	const fitViewNodes = /* @__PURE__ */ new Map();
	const optionNodeIds = options?.nodes ? new Set(options.nodes.map((node) => node.id)) : null;
	nodeLookup.forEach((n) => {
		if (n.measured.width && n.measured.height && (options?.includeHiddenNodes || !n.hidden) && (!optionNodeIds || optionNodeIds.has(n.id))) fitViewNodes.set(n.id, n);
	});
	return fitViewNodes;
}
async function fitViewport({ nodes, width, height, panZoom, minZoom, maxZoom }, options) {
	if (nodes.size === 0) return Promise.resolve(true);
	const viewport = getViewportForBounds(getInternalNodesBounds(getFitViewNodes(nodes, options)), width, height, options?.minZoom ?? minZoom, options?.maxZoom ?? maxZoom, options?.padding ?? .1);
	await panZoom.setViewport(viewport, {
		duration: options?.duration,
		ease: options?.ease,
		interpolate: options?.interpolate
	});
	return Promise.resolve(true);
}
/**
* This function calculates the next position of a node, taking into account the node's extent, parent node, and origin.
*
* @internal
* @returns position, positionAbsolute
*/
function calculateNodePosition({ nodeId, nextPosition, nodeLookup, nodeOrigin = [0, 0], nodeExtent, onError }) {
	const node = nodeLookup.get(nodeId);
	const parentNode = node.parentId ? nodeLookup.get(node.parentId) : void 0;
	const { x: parentX, y: parentY } = parentNode ? parentNode.internals.positionAbsolute : {
		x: 0,
		y: 0
	};
	const origin = node.origin ?? nodeOrigin;
	let extent = node.extent || nodeExtent;
	if (node.extent === "parent" && !node.expandParent) if (!parentNode) onError?.("005", errorMessages["error005"]());
	else {
		const parentWidth = parentNode.measured.width;
		const parentHeight = parentNode.measured.height;
		if (parentWidth && parentHeight) extent = [[parentX, parentY], [parentX + parentWidth, parentY + parentHeight]];
	}
	else if (parentNode && isCoordinateExtent(node.extent)) extent = [[node.extent[0][0] + parentX, node.extent[0][1] + parentY], [node.extent[1][0] + parentX, node.extent[1][1] + parentY]];
	const positionAbsolute = isCoordinateExtent(extent) ? clampPosition(nextPosition, extent, node.measured) : nextPosition;
	if (node.measured.width === void 0 || node.measured.height === void 0) onError?.("015", errorMessages["error015"]());
	return {
		position: {
			x: positionAbsolute.x - parentX + (node.measured.width ?? 0) * origin[0],
			y: positionAbsolute.y - parentY + (node.measured.height ?? 0) * origin[1]
		},
		positionAbsolute
	};
}
/**
* Pass in nodes & edges to delete, get arrays of nodes and edges that actually can be deleted
* @internal
* @param param.nodesToRemove - The nodes to remove
* @param param.edgesToRemove - The edges to remove
* @param param.nodes - All nodes
* @param param.edges - All edges
* @param param.onBeforeDelete - Callback to check which nodes and edges can be deleted
* @returns nodes: nodes that can be deleted, edges: edges that can be deleted
*/
async function getElementsToRemove({ nodesToRemove = [], edgesToRemove = [], nodes, edges, onBeforeDelete }) {
	const nodeIds = new Set(nodesToRemove.map((node) => node.id));
	const matchingNodes = [];
	for (const node of nodes) {
		if (node.deletable === false) continue;
		const isIncluded = nodeIds.has(node.id);
		const parentHit = !isIncluded && node.parentId && matchingNodes.find((n) => n.id === node.parentId);
		if (isIncluded || parentHit) matchingNodes.push(node);
	}
	const edgeIds = new Set(edgesToRemove.map((edge) => edge.id));
	const deletableEdges = edges.filter((edge) => edge.deletable !== false);
	const matchingEdges = getConnectedEdges(matchingNodes, deletableEdges);
	for (const edge of deletableEdges) if (edgeIds.has(edge.id) && !matchingEdges.find((e) => e.id === edge.id)) matchingEdges.push(edge);
	if (!onBeforeDelete) return {
		edges: matchingEdges,
		nodes: matchingNodes
	};
	const onBeforeDeleteResult = await onBeforeDelete({
		nodes: matchingNodes,
		edges: matchingEdges
	});
	if (typeof onBeforeDeleteResult === "boolean") return onBeforeDeleteResult ? {
		edges: matchingEdges,
		nodes: matchingNodes
	} : {
		edges: [],
		nodes: []
	};
	return onBeforeDeleteResult;
}
const clamp = (val, min = 0, max = 1) => Math.min(Math.max(val, min), max);
const clampPosition = (position = {
	x: 0,
	y: 0
}, extent, dimensions) => ({
	x: clamp(position.x, extent[0][0], extent[1][0] - (dimensions?.width ?? 0)),
	y: clamp(position.y, extent[0][1], extent[1][1] - (dimensions?.height ?? 0))
});
function clampPositionToParent(childPosition, childDimensions, parent) {
	const { width: parentWidth, height: parentHeight } = getNodeDimensions(parent);
	const { x: parentX, y: parentY } = parent.internals.positionAbsolute;
	return clampPosition(childPosition, [[parentX, parentY], [parentX + parentWidth, parentY + parentHeight]], childDimensions);
}
/**
* Calculates the velocity of panning when the mouse is close to the edge of the canvas
* @internal
* @param value - One dimensional poition of the mouse (x or y)
* @param min - Minimal position on canvas before panning starts
* @param max - Maximal position on canvas before panning starts
* @returns - A number between 0 and 1 that represents the velocity of panning
*/
const calcAutoPanVelocity = (value, min, max) => {
	if (value < min) return clamp(Math.abs(value - min), 1, min) / min;
	else if (value > max) return -clamp(Math.abs(value - max), 1, min) / min;
	return 0;
};
const calcAutoPan = (pos, bounds, speed = 15, distance = 40) => {
	return [calcAutoPanVelocity(pos.x, distance, bounds.width - distance) * speed, calcAutoPanVelocity(pos.y, distance, bounds.height - distance) * speed];
};
const getBoundsOfBoxes = (box1, box2) => ({
	x: Math.min(box1.x, box2.x),
	y: Math.min(box1.y, box2.y),
	x2: Math.max(box1.x2, box2.x2),
	y2: Math.max(box1.y2, box2.y2)
});
const rectToBox = ({ x, y, width, height }) => ({
	x,
	y,
	x2: x + width,
	y2: y + height
});
const boxToRect = ({ x, y, x2, y2 }) => ({
	x,
	y,
	width: x2 - x,
	height: y2 - y
});
const nodeToRect = (node, nodeOrigin = [0, 0]) => {
	const { x, y } = isInternalNodeBase(node) ? node.internals.positionAbsolute : getNodePositionWithOrigin(node, nodeOrigin);
	return {
		x,
		y,
		width: node.measured?.width ?? node.width ?? node.initialWidth ?? 0,
		height: node.measured?.height ?? node.height ?? node.initialHeight ?? 0
	};
};
const nodeToBox = (node, nodeOrigin = [0, 0]) => {
	const { x, y } = isInternalNodeBase(node) ? node.internals.positionAbsolute : getNodePositionWithOrigin(node, nodeOrigin);
	return {
		x,
		y,
		x2: x + (node.measured?.width ?? node.width ?? node.initialWidth ?? 0),
		y2: y + (node.measured?.height ?? node.height ?? node.initialHeight ?? 0)
	};
};
const getBoundsOfRects = (rect1, rect2) => boxToRect(getBoundsOfBoxes(rectToBox(rect1), rectToBox(rect2)));
const getOverlappingArea = (rectA, rectB) => {
	const xOverlap = Math.max(0, Math.min(rectA.x + rectA.width, rectB.x + rectB.width) - Math.max(rectA.x, rectB.x));
	const yOverlap = Math.max(0, Math.min(rectA.y + rectA.height, rectB.y + rectB.height) - Math.max(rectA.y, rectB.y));
	return Math.ceil(xOverlap * yOverlap);
};
const isRectObject = (obj) => isNumeric(obj.width) && isNumeric(obj.height) && isNumeric(obj.x) && isNumeric(obj.y);
const isNumeric = (n) => !isNaN(n) && isFinite(n);
const devWarn = (id, message) => {};
const snapPosition = (position, snapGrid = [1, 1]) => {
	return {
		x: snapGrid[0] * Math.round(position.x / snapGrid[0]),
		y: snapGrid[1] * Math.round(position.y / snapGrid[1])
	};
};
const pointToRendererPoint = ({ x, y }, [tx, ty, tScale], snapToGrid = false, snapGrid = [1, 1]) => {
	const position = {
		x: (x - tx) / tScale,
		y: (y - ty) / tScale
	};
	return snapToGrid ? snapPosition(position, snapGrid) : position;
};
const rendererPointToPoint = ({ x, y }, [tx, ty, tScale]) => {
	return {
		x: x * tScale + tx,
		y: y * tScale + ty
	};
};
/**
* Parses a single padding value to a number
* @internal
* @param padding - Padding to parse
* @param viewport - Width or height of the viewport
* @returns The padding in pixels
*/
function parsePadding(padding, viewport) {
	if (typeof padding === "number") return Math.floor((viewport - viewport / (1 + padding)) * .5);
	if (typeof padding === "string" && padding.endsWith("px")) {
		const paddingValue = parseFloat(padding);
		if (!Number.isNaN(paddingValue)) return Math.floor(paddingValue);
	}
	if (typeof padding === "string" && padding.endsWith("%")) {
		const paddingValue = parseFloat(padding);
		if (!Number.isNaN(paddingValue)) return Math.floor(viewport * paddingValue * .01);
	}
	console.error(`[React Flow] The padding value "${padding}" is invalid. Please provide a number or a string with a valid unit (px or %).`);
	return 0;
}
/**
* Parses the paddings to an object with top, right, bottom, left, x and y paddings
* @internal
* @param padding - Padding to parse
* @param width - Width of the viewport
* @param height - Height of the viewport
* @returns An object with the paddings in pixels
*/
function parsePaddings(padding, width, height) {
	if (typeof padding === "string" || typeof padding === "number") {
		const paddingY = parsePadding(padding, height);
		const paddingX = parsePadding(padding, width);
		return {
			top: paddingY,
			right: paddingX,
			bottom: paddingY,
			left: paddingX,
			x: paddingX * 2,
			y: paddingY * 2
		};
	}
	if (typeof padding === "object") {
		const top = parsePadding(padding.top ?? padding.y ?? 0, height);
		const bottom = parsePadding(padding.bottom ?? padding.y ?? 0, height);
		const left = parsePadding(padding.left ?? padding.x ?? 0, width);
		const right = parsePadding(padding.right ?? padding.x ?? 0, width);
		return {
			top,
			right,
			bottom,
			left,
			x: left + right,
			y: top + bottom
		};
	}
	return {
		top: 0,
		right: 0,
		bottom: 0,
		left: 0,
		x: 0,
		y: 0
	};
}
/**
* Calculates the resulting paddings if the new viewport is applied
* @internal
* @param bounds - Bounds to fit inside viewport
* @param x - X position of the viewport
* @param y - Y position of the viewport
* @param zoom - Zoom level of the viewport
* @param width - Width of the viewport
* @param height - Height of the viewport
* @returns An object with the minimum padding required to fit the bounds inside the viewport
*/
function calculateAppliedPaddings(bounds, x, y, zoom, width, height) {
	const { x: left, y: top } = rendererPointToPoint(bounds, [
		x,
		y,
		zoom
	]);
	const { x: boundRight, y: boundBottom } = rendererPointToPoint({
		x: bounds.x + bounds.width,
		y: bounds.y + bounds.height
	}, [
		x,
		y,
		zoom
	]);
	const right = width - boundRight;
	const bottom = height - boundBottom;
	return {
		left: Math.floor(left),
		top: Math.floor(top),
		right: Math.floor(right),
		bottom: Math.floor(bottom)
	};
}
/**
* Returns a viewport that encloses the given bounds with padding.
* @public
* @remarks You can determine bounds of nodes with {@link getNodesBounds} and {@link getBoundsOfRects}
* @param bounds - Bounds to fit inside viewport.
* @param width - Width of the viewport.
* @param height  - Height of the viewport.
* @param minZoom - Minimum zoom level of the resulting viewport.
* @param maxZoom - Maximum zoom level of the resulting viewport.
* @param padding - Padding around the bounds.
* @returns A transformed {@link Viewport} that encloses the given bounds which you can pass to e.g. {@link setViewport}.
* @example
* const { x, y, zoom } = getViewportForBounds(
* { x: 0, y: 0, width: 100, height: 100},
* 1200, 800, 0.5, 2);
*/
const getViewportForBounds = (bounds, width, height, minZoom, maxZoom, padding) => {
	const p = parsePaddings(padding, width, height);
	const xZoom = (width - p.x) / bounds.width;
	const yZoom = (height - p.y) / bounds.height;
	const clampedZoom = clamp(Math.min(xZoom, yZoom), minZoom, maxZoom);
	const boundsCenterX = bounds.x + bounds.width / 2;
	const boundsCenterY = bounds.y + bounds.height / 2;
	const x = width / 2 - boundsCenterX * clampedZoom;
	const y = height / 2 - boundsCenterY * clampedZoom;
	const newPadding = calculateAppliedPaddings(bounds, x, y, clampedZoom, width, height);
	const offset = {
		left: Math.min(newPadding.left - p.left, 0),
		top: Math.min(newPadding.top - p.top, 0),
		right: Math.min(newPadding.right - p.right, 0),
		bottom: Math.min(newPadding.bottom - p.bottom, 0)
	};
	return {
		x: x - offset.left + offset.right,
		y: y - offset.top + offset.bottom,
		zoom: clampedZoom
	};
};
const isMacOs = () => typeof navigator !== "undefined" && navigator?.userAgent?.indexOf("Mac") >= 0;
function isCoordinateExtent(extent) {
	return extent !== void 0 && extent !== null && extent !== "parent";
}
function getNodeDimensions(node) {
	return {
		width: node.measured?.width ?? node.width ?? node.initialWidth ?? 0,
		height: node.measured?.height ?? node.height ?? node.initialHeight ?? 0
	};
}
function nodeHasDimensions(node) {
	return (node.measured?.width ?? node.width ?? node.initialWidth) !== void 0 && (node.measured?.height ?? node.height ?? node.initialHeight) !== void 0;
}
/**
* Convert child position to absolute position
*
* @internal
* @param position
* @param parentId
* @param nodeLookup
* @param nodeOrigin
* @returns an internal node with an absolute position
*/
function evaluateAbsolutePosition(position, dimensions = {
	width: 0,
	height: 0
}, parentId, nodeLookup, nodeOrigin) {
	const positionAbsolute = { ...position };
	const parent = nodeLookup.get(parentId);
	if (parent) {
		const origin = parent.origin || nodeOrigin;
		positionAbsolute.x += parent.internals.positionAbsolute.x - (dimensions.width ?? 0) * origin[0];
		positionAbsolute.y += parent.internals.positionAbsolute.y - (dimensions.height ?? 0) * origin[1];
	}
	return positionAbsolute;
}
function areSetsEqual(a, b) {
	if (a.size !== b.size) return false;
	for (const item of a) if (!b.has(item)) return false;
	return true;
}
/**
* Polyfill for Promise.withResolvers until we can use it in all browsers
* @internal
*/
function withResolvers() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
function mergeAriaLabelConfig(partial) {
	return {
		...defaultAriaLabelConfig,
		...partial || {}
	};
}
function getPointerPosition(event, { snapGrid = [0, 0], snapToGrid = false, transform, containerBounds }) {
	const { x, y } = getEventPosition(event);
	const pointerPos = pointToRendererPoint({
		x: x - (containerBounds?.left ?? 0),
		y: y - (containerBounds?.top ?? 0)
	}, transform);
	const { x: xSnapped, y: ySnapped } = snapToGrid ? snapPosition(pointerPos, snapGrid) : pointerPos;
	return {
		xSnapped,
		ySnapped,
		...pointerPos
	};
}
const getDimensions = (node) => ({
	width: node.offsetWidth,
	height: node.offsetHeight
});
const getHostForElement = (element) => element?.getRootNode?.() || window?.document;
const inputTags = [
	"INPUT",
	"SELECT",
	"TEXTAREA"
];
function isInputDOMNode(event) {
	const target = event.composedPath?.()?.[0] || event.target;
	if (target?.nodeType !== 1) return false;
	return inputTags.includes(target.nodeName) || target.hasAttribute("contenteditable") || !!target.closest(".nokey");
}
const isMouseEvent = (event) => "clientX" in event;
const getEventPosition = (event, bounds) => {
	const isMouse = isMouseEvent(event);
	const evtX = isMouse ? event.clientX : event.touches?.[0].clientX;
	const evtY = isMouse ? event.clientY : event.touches?.[0].clientY;
	return {
		x: evtX - (bounds?.left ?? 0),
		y: evtY - (bounds?.top ?? 0)
	};
};
const getHandleBounds = (type, nodeElement, nodeBounds, zoom, nodeId) => {
	const handles = nodeElement.querySelectorAll(`.${type}`);
	if (!handles || !handles.length) return null;
	return Array.from(handles).map((handle) => {
		const handleBounds = handle.getBoundingClientRect();
		return {
			id: handle.getAttribute("data-handleid"),
			type,
			nodeId,
			position: handle.getAttribute("data-handlepos"),
			x: (handleBounds.left - nodeBounds.left) / zoom,
			y: (handleBounds.top - nodeBounds.top) / zoom,
			...getDimensions(handle)
		};
	});
};
function getBezierEdgeCenter({ sourceX, sourceY, targetX, targetY, sourceControlX, sourceControlY, targetControlX, targetControlY }) {
	const centerX = sourceX * .125 + sourceControlX * .375 + targetControlX * .375 + targetX * .125;
	const centerY = sourceY * .125 + sourceControlY * .375 + targetControlY * .375 + targetY * .125;
	return [
		centerX,
		centerY,
		Math.abs(centerX - sourceX),
		Math.abs(centerY - sourceY)
	];
}
function calculateControlOffset(distance, curvature) {
	if (distance >= 0) return .5 * distance;
	return curvature * 25 * Math.sqrt(-distance);
}
function getControlWithCurvature({ pos, x1, y1, x2, y2, c }) {
	switch (pos) {
		case Position.Left: return [x1 - calculateControlOffset(x1 - x2, c), y1];
		case Position.Right: return [x1 + calculateControlOffset(x2 - x1, c), y1];
		case Position.Top: return [x1, y1 - calculateControlOffset(y1 - y2, c)];
		case Position.Bottom: return [x1, y1 + calculateControlOffset(y2 - y1, c)];
	}
}
/**
* The `getBezierPath` util returns everything you need to render a bezier edge
*between two nodes.
* @public
* @returns A path string you can use in an SVG, the `labelX` and `labelY` position (center of path)
* and `offsetX`, `offsetY` between source handle and label.
* - `path`: the path to use in an SVG `<path>` element.
* - `labelX`: the `x` position you can use to render a label for this edge.
* - `labelY`: the `y` position you can use to render a label for this edge.
* - `offsetX`: the absolute difference between the source `x` position and the `x` position of the
* middle of this path.
* - `offsetY`: the absolute difference between the source `y` position and the `y` position of the
* middle of this path.
* @example
* ```js
*  const source = { x: 0, y: 20 };
*  const target = { x: 150, y: 100 };
*
*  const [path, labelX, labelY, offsetX, offsetY] = getBezierPath({
*    sourceX: source.x,
*    sourceY: source.y,
*    sourcePosition: Position.Right,
*    targetX: target.x,
*    targetY: target.y,
*    targetPosition: Position.Left,
*});
*```
*
* @remarks This function returns a tuple (aka a fixed-size array) to make it easier to
*work with multiple edge paths at once.
*/
function getBezierPath({ sourceX, sourceY, sourcePosition = Position.Bottom, targetX, targetY, targetPosition = Position.Top, curvature = .25 }) {
	const [sourceControlX, sourceControlY] = getControlWithCurvature({
		pos: sourcePosition,
		x1: sourceX,
		y1: sourceY,
		x2: targetX,
		y2: targetY,
		c: curvature
	});
	const [targetControlX, targetControlY] = getControlWithCurvature({
		pos: targetPosition,
		x1: targetX,
		y1: targetY,
		x2: sourceX,
		y2: sourceY,
		c: curvature
	});
	const [labelX, labelY, offsetX, offsetY] = getBezierEdgeCenter({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourceControlX,
		sourceControlY,
		targetControlX,
		targetControlY
	});
	return [
		`M${sourceX},${sourceY} C${sourceControlX},${sourceControlY} ${targetControlX},${targetControlY} ${targetX},${targetY}`,
		labelX,
		labelY,
		offsetX,
		offsetY
	];
}
function getEdgeCenter({ sourceX, sourceY, targetX, targetY }) {
	const xOffset = Math.abs(targetX - sourceX) / 2;
	const centerX = targetX < sourceX ? targetX + xOffset : targetX - xOffset;
	const yOffset = Math.abs(targetY - sourceY) / 2;
	return [
		centerX,
		targetY < sourceY ? targetY + yOffset : targetY - yOffset,
		xOffset,
		yOffset
	];
}
/**
* Returns the z-index for an edge based on the node it connects and whether it is selected.
* By default, edges are rendered below nodes. This behaviour is different for edges that are
* connected to nodes with a parent, as they are rendered above the parent node.
*/
function getElevatedEdgeZIndex({ sourceNode, targetNode, selected = false, zIndex = 0, elevateOnSelect = false, zIndexMode = "basic" }) {
	if (zIndexMode === "manual") return zIndex;
	return (elevateOnSelect && selected ? zIndex + 1e3 : zIndex) + Math.max(sourceNode.parentId || elevateOnSelect && sourceNode.selected ? sourceNode.internals.z : 0, targetNode.parentId || elevateOnSelect && targetNode.selected ? targetNode.internals.z : 0);
}
function isEdgeVisible({ sourceNode, targetNode, width, height, transform }) {
	const edgeBox = getBoundsOfBoxes(nodeToBox(sourceNode), nodeToBox(targetNode));
	if (edgeBox.x === edgeBox.x2) edgeBox.x2 += 1;
	if (edgeBox.y === edgeBox.y2) edgeBox.y2 += 1;
	return getOverlappingArea({
		x: -transform[0] / transform[2],
		y: -transform[1] / transform[2],
		width: width / transform[2],
		height: height / transform[2]
	}, boxToRect(edgeBox)) > 0;
}
/**
* The default edge ID generator function. Generates an ID based on the source, target, and handles.
* @public
* @param params - The connection or edge to generate an ID for.
* @returns The generated edge ID.
*/
const getEdgeId = ({ source, sourceHandle, target, targetHandle }) => `xy-edge__${source}${sourceHandle || ""}-${target}${targetHandle || ""}`;
const connectionExists = (edge, edges) => {
	return edges.some((el) => el.source === edge.source && el.target === edge.target && (el.sourceHandle === edge.sourceHandle || !el.sourceHandle && !edge.sourceHandle) && (el.targetHandle === edge.targetHandle || !el.targetHandle && !edge.targetHandle));
};
/**
* This util is a convenience function to add a new Edge to an array of edges. It also performs some validation to make sure you don't add an invalid edge or duplicate an existing one.
* @public
* @param edgeParams - Either an `Edge` or a `Connection` you want to add.
* @param edges - The array of all current edges.
* @param options - Optional configuration object.
* @returns A new array of edges with the new edge added.
*
* @remarks If an edge with the same `target` and `source` already exists (and the same
*`targetHandle` and `sourceHandle` if those are set), then this util won't add
*a new edge even if the `id` property is different.
*
*/
const addEdge = (edgeParams, edges, options = {}) => {
	if (!edgeParams.source || !edgeParams.target) {
		devWarn("006", errorMessages["error006"]());
		return edges;
	}
	const edgeIdGenerator = options.getEdgeId || getEdgeId;
	let edge;
	if (isEdgeBase(edgeParams)) edge = { ...edgeParams };
	else edge = {
		...edgeParams,
		id: edgeIdGenerator(edgeParams)
	};
	if (connectionExists(edge, edges)) return edges;
	if (edge.sourceHandle === null) delete edge.sourceHandle;
	if (edge.targetHandle === null) delete edge.targetHandle;
	return edges.concat(edge);
};
/**
* Calculates the straight line path between two points.
* @public
* @returns A path string you can use in an SVG, the `labelX` and `labelY` position (center of path)
* and `offsetX`, `offsetY` between source handle and label.
*
* - `path`: the path to use in an SVG `<path>` element.
* - `labelX`: the `x` position you can use to render a label for this edge.
* - `labelY`: the `y` position you can use to render a label for this edge.
* - `offsetX`: the absolute difference between the source `x` position and the `x` position of the
* middle of this path.
* - `offsetY`: the absolute difference between the source `y` position and the `y` position of the
* middle of this path.
* @example
* ```js
*  const source = { x: 0, y: 20 };
*  const target = { x: 150, y: 100 };
*
*  const [path, labelX, labelY, offsetX, offsetY] = getStraightPath({
*    sourceX: source.x,
*    sourceY: source.y,
*    sourcePosition: Position.Right,
*    targetX: target.x,
*    targetY: target.y,
*    targetPosition: Position.Left,
*  });
* ```
* @remarks This function returns a tuple (aka a fixed-size array) to make it easier to work with multiple edge paths at once.
*/
function getStraightPath({ sourceX, sourceY, targetX, targetY }) {
	const [labelX, labelY, offsetX, offsetY] = getEdgeCenter({
		sourceX,
		sourceY,
		targetX,
		targetY
	});
	return [
		`M ${sourceX},${sourceY}L ${targetX},${targetY}`,
		labelX,
		labelY,
		offsetX,
		offsetY
	];
}
const handleDirections = {
	[Position.Left]: {
		x: -1,
		y: 0
	},
	[Position.Right]: {
		x: 1,
		y: 0
	},
	[Position.Top]: {
		x: 0,
		y: -1
	},
	[Position.Bottom]: {
		x: 0,
		y: 1
	}
};
const getDirection = ({ source, sourcePosition = Position.Bottom, target }) => {
	if (sourcePosition === Position.Left || sourcePosition === Position.Right) return source.x < target.x ? {
		x: 1,
		y: 0
	} : {
		x: -1,
		y: 0
	};
	return source.y < target.y ? {
		x: 0,
		y: 1
	} : {
		x: 0,
		y: -1
	};
};
const distance = (a, b) => Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
function getPoints({ source, sourcePosition = Position.Bottom, target, targetPosition = Position.Top, center, offset, stepPosition }) {
	const sourceDir = handleDirections[sourcePosition];
	const targetDir = handleDirections[targetPosition];
	const sourceGapped = {
		x: source.x + sourceDir.x * offset,
		y: source.y + sourceDir.y * offset
	};
	const targetGapped = {
		x: target.x + targetDir.x * offset,
		y: target.y + targetDir.y * offset
	};
	const dir = getDirection({
		source: sourceGapped,
		sourcePosition,
		target: targetGapped
	});
	const dirAccessor = dir.x !== 0 ? "x" : "y";
	const currDir = dir[dirAccessor];
	let points = [];
	let centerX, centerY;
	const sourceGapOffset = {
		x: 0,
		y: 0
	};
	const targetGapOffset = {
		x: 0,
		y: 0
	};
	const [, , defaultOffsetX, defaultOffsetY] = getEdgeCenter({
		sourceX: source.x,
		sourceY: source.y,
		targetX: target.x,
		targetY: target.y
	});
	if (sourceDir[dirAccessor] * targetDir[dirAccessor] === -1) {
		if (dirAccessor === "x") {
			centerX = center.x ?? sourceGapped.x + (targetGapped.x - sourceGapped.x) * stepPosition;
			centerY = center.y ?? (sourceGapped.y + targetGapped.y) / 2;
		} else {
			centerX = center.x ?? (sourceGapped.x + targetGapped.x) / 2;
			centerY = center.y ?? sourceGapped.y + (targetGapped.y - sourceGapped.y) * stepPosition;
		}
		const verticalSplit = [{
			x: centerX,
			y: sourceGapped.y
		}, {
			x: centerX,
			y: targetGapped.y
		}];
		const horizontalSplit = [{
			x: sourceGapped.x,
			y: centerY
		}, {
			x: targetGapped.x,
			y: centerY
		}];
		if (sourceDir[dirAccessor] === currDir) points = dirAccessor === "x" ? verticalSplit : horizontalSplit;
		else points = dirAccessor === "x" ? horizontalSplit : verticalSplit;
	} else {
		const sourceTarget = [{
			x: sourceGapped.x,
			y: targetGapped.y
		}];
		const targetSource = [{
			x: targetGapped.x,
			y: sourceGapped.y
		}];
		if (dirAccessor === "x") points = sourceDir.x === currDir ? targetSource : sourceTarget;
		else points = sourceDir.y === currDir ? sourceTarget : targetSource;
		if (sourcePosition === targetPosition) {
			const diff = Math.abs(source[dirAccessor] - target[dirAccessor]);
			if (diff <= offset) {
				const gapOffset = Math.min(offset - 1, offset - diff);
				if (sourceDir[dirAccessor] === currDir) sourceGapOffset[dirAccessor] = (sourceGapped[dirAccessor] > source[dirAccessor] ? -1 : 1) * gapOffset;
				else targetGapOffset[dirAccessor] = (targetGapped[dirAccessor] > target[dirAccessor] ? -1 : 1) * gapOffset;
			}
		}
		if (sourcePosition !== targetPosition) {
			const dirAccessorOpposite = dirAccessor === "x" ? "y" : "x";
			const isSameDir = sourceDir[dirAccessor] === targetDir[dirAccessorOpposite];
			const sourceGtTargetOppo = sourceGapped[dirAccessorOpposite] > targetGapped[dirAccessorOpposite];
			const sourceLtTargetOppo = sourceGapped[dirAccessorOpposite] < targetGapped[dirAccessorOpposite];
			if (sourceDir[dirAccessor] === 1 && (!isSameDir && sourceGtTargetOppo || isSameDir && sourceLtTargetOppo) || sourceDir[dirAccessor] !== 1 && (!isSameDir && sourceLtTargetOppo || isSameDir && sourceGtTargetOppo)) points = dirAccessor === "x" ? sourceTarget : targetSource;
		}
		const sourceGapPoint = {
			x: sourceGapped.x + sourceGapOffset.x,
			y: sourceGapped.y + sourceGapOffset.y
		};
		const targetGapPoint = {
			x: targetGapped.x + targetGapOffset.x,
			y: targetGapped.y + targetGapOffset.y
		};
		if (Math.max(Math.abs(sourceGapPoint.x - points[0].x), Math.abs(targetGapPoint.x - points[0].x)) >= Math.max(Math.abs(sourceGapPoint.y - points[0].y), Math.abs(targetGapPoint.y - points[0].y))) {
			centerX = (sourceGapPoint.x + targetGapPoint.x) / 2;
			centerY = points[0].y;
		} else {
			centerX = points[0].x;
			centerY = (sourceGapPoint.y + targetGapPoint.y) / 2;
		}
	}
	const gappedSource = {
		x: sourceGapped.x + sourceGapOffset.x,
		y: sourceGapped.y + sourceGapOffset.y
	};
	const gappedTarget = {
		x: targetGapped.x + targetGapOffset.x,
		y: targetGapped.y + targetGapOffset.y
	};
	return [
		[
			source,
			...gappedSource.x !== points[0].x || gappedSource.y !== points[0].y ? [gappedSource] : [],
			...points,
			...gappedTarget.x !== points[points.length - 1].x || gappedTarget.y !== points[points.length - 1].y ? [gappedTarget] : [],
			target
		],
		centerX,
		centerY,
		defaultOffsetX,
		defaultOffsetY
	];
}
function getBend(a, b, c, size) {
	const bendSize = Math.min(distance(a, b) / 2, distance(b, c) / 2, size);
	const { x, y } = b;
	if (a.x === x && x === c.x || a.y === y && y === c.y) return `L${x} ${y}`;
	if (a.y === y) {
		const xDir = a.x < c.x ? -1 : 1;
		const yDir = a.y < c.y ? 1 : -1;
		return `L ${x + bendSize * xDir},${y}Q ${x},${y} ${x},${y + bendSize * yDir}`;
	}
	const xDir = a.x < c.x ? 1 : -1;
	return `L ${x},${y + bendSize * (a.y < c.y ? -1 : 1)}Q ${x},${y} ${x + bendSize * xDir},${y}`;
}
/**
* The `getSmoothStepPath` util returns everything you need to render a stepped path
* between two nodes. The `borderRadius` property can be used to choose how rounded
* the corners of those steps are.
* @public
* @returns A path string you can use in an SVG, the `labelX` and `labelY` position (center of path)
* and `offsetX`, `offsetY` between source handle and label.
*
* - `path`: the path to use in an SVG `<path>` element.
* - `labelX`: the `x` position you can use to render a label for this edge.
* - `labelY`: the `y` position you can use to render a label for this edge.
* - `offsetX`: the absolute difference between the source `x` position and the `x` position of the
* middle of this path.
* - `offsetY`: the absolute difference between the source `y` position and the `y` position of the
* middle of this path.
* @example
* ```js
*  const source = { x: 0, y: 20 };
*  const target = { x: 150, y: 100 };
*
*  const [path, labelX, labelY, offsetX, offsetY] = getSmoothStepPath({
*    sourceX: source.x,
*    sourceY: source.y,
*    sourcePosition: Position.Right,
*    targetX: target.x,
*    targetY: target.y,
*    targetPosition: Position.Left,
*  });
* ```
* @remarks This function returns a tuple (aka a fixed-size array) to make it easier to work with multiple edge paths at once.
*/
function getSmoothStepPath({ sourceX, sourceY, sourcePosition = Position.Bottom, targetX, targetY, targetPosition = Position.Top, borderRadius = 5, centerX, centerY, offset = 20, stepPosition = .5 }) {
	const [points, labelX, labelY, offsetX, offsetY] = getPoints({
		source: {
			x: sourceX,
			y: sourceY
		},
		sourcePosition,
		target: {
			x: targetX,
			y: targetY
		},
		targetPosition,
		center: {
			x: centerX,
			y: centerY
		},
		offset,
		stepPosition
	});
	let path = `M${points[0].x} ${points[0].y}`;
	for (let i = 1; i < points.length - 1; i++) path += getBend(points[i - 1], points[i], points[i + 1], borderRadius);
	path += `L${points[points.length - 1].x} ${points[points.length - 1].y}`;
	return [
		path,
		labelX,
		labelY,
		offsetX,
		offsetY
	];
}
function isNodeInitialized(node) {
	return node && !!(node.internals.handleBounds || node.handles?.length) && !!(node.measured.width || node.width || node.initialWidth);
}
function getEdgePosition(params) {
	const { sourceNode, targetNode } = params;
	if (!isNodeInitialized(sourceNode) || !isNodeInitialized(targetNode)) return null;
	const sourceHandleBounds = sourceNode.internals.handleBounds || toHandleBounds(sourceNode.handles);
	const targetHandleBounds = targetNode.internals.handleBounds || toHandleBounds(targetNode.handles);
	const sourceHandle = getHandle$1(sourceHandleBounds?.source ?? [], params.sourceHandle);
	const targetHandle = getHandle$1(params.connectionMode === ConnectionMode.Strict ? targetHandleBounds?.target ?? [] : (targetHandleBounds?.target ?? []).concat(targetHandleBounds?.source ?? []), params.targetHandle);
	if (!sourceHandle || !targetHandle) {
		params.onError?.("008", errorMessages["error008"](!sourceHandle ? "source" : "target", {
			id: params.id,
			sourceHandle: params.sourceHandle,
			targetHandle: params.targetHandle
		}));
		return null;
	}
	const sourcePosition = sourceHandle?.position || Position.Bottom;
	const targetPosition = targetHandle?.position || Position.Top;
	const source = getHandlePosition(sourceNode, sourceHandle, sourcePosition);
	const target = getHandlePosition(targetNode, targetHandle, targetPosition);
	return {
		sourceX: source.x,
		sourceY: source.y,
		targetX: target.x,
		targetY: target.y,
		sourcePosition,
		targetPosition
	};
}
function toHandleBounds(handles) {
	if (!handles) return null;
	const source = [];
	const target = [];
	for (const handle of handles) {
		handle.width = handle.width ?? 1;
		handle.height = handle.height ?? 1;
		if (handle.type === "source") source.push(handle);
		else if (handle.type === "target") target.push(handle);
	}
	return {
		source,
		target
	};
}
function getHandlePosition(node, handle, fallbackPosition = Position.Left, center = false) {
	const x = (handle?.x ?? 0) + node.internals.positionAbsolute.x;
	const y = (handle?.y ?? 0) + node.internals.positionAbsolute.y;
	const { width, height } = handle ?? getNodeDimensions(node);
	if (center) return {
		x: x + width / 2,
		y: y + height / 2
	};
	switch (handle?.position ?? fallbackPosition) {
		case Position.Top: return {
			x: x + width / 2,
			y
		};
		case Position.Right: return {
			x: x + width,
			y: y + height / 2
		};
		case Position.Bottom: return {
			x: x + width / 2,
			y: y + height
		};
		case Position.Left: return {
			x,
			y: y + height / 2
		};
	}
}
function getHandle$1(bounds, handleId) {
	if (!bounds) return null;
	return (!handleId ? bounds[0] : bounds.find((d) => d.id === handleId)) || null;
}
function getMarkerId(marker, id) {
	if (!marker) return "";
	if (typeof marker === "string") return marker;
	return `${id ? `${id}__` : ""}${Object.keys(marker).sort().map((key) => `${key}=${marker[key]}`).join("&")}`;
}
function createMarkerIds(edges, { id, defaultColor, defaultMarkerStart, defaultMarkerEnd }) {
	const ids = /* @__PURE__ */ new Set();
	return edges.reduce((markers, edge) => {
		[edge.markerStart || defaultMarkerStart, edge.markerEnd || defaultMarkerEnd].forEach((marker) => {
			if (marker && typeof marker === "object") {
				const markerId = getMarkerId(marker, id);
				if (!ids.has(markerId)) {
					markers.push({
						id: markerId,
						color: marker.color || defaultColor,
						...marker
					});
					ids.add(markerId);
				}
			}
		});
		return markers;
	}, []).sort((a, b) => a.id.localeCompare(b.id));
}
const SELECTED_NODE_Z = 1e3;
const ROOT_PARENT_Z_INCREMENT = 10;
const defaultOptions = {
	nodeOrigin: [0, 0],
	nodeExtent: infiniteExtent,
	elevateNodesOnSelect: true,
	zIndexMode: "basic",
	defaults: {}
};
const adoptUserNodesDefaultOptions = {
	...defaultOptions,
	checkEquality: true
};
function mergeObjects(base, incoming) {
	const result = { ...base };
	for (const key in incoming) if (incoming[key] !== void 0) result[key] = incoming[key];
	return result;
}
function updateAbsolutePositions(nodeLookup, parentLookup, options) {
	const _options = mergeObjects(defaultOptions, options);
	for (const node of nodeLookup.values()) if (node.parentId) updateChildNode(node, nodeLookup, parentLookup, _options);
	else {
		const clampedPosition = clampPosition(getNodePositionWithOrigin(node, _options.nodeOrigin), isCoordinateExtent(node.extent) ? node.extent : _options.nodeExtent, getNodeDimensions(node));
		node.internals.positionAbsolute = clampedPosition;
	}
}
function parseHandles(userNode, internalNode) {
	if (!userNode.handles) return !userNode.measured ? void 0 : internalNode?.internals.handleBounds;
	const source = [];
	const target = [];
	for (const handle of userNode.handles) {
		const handleBounds = {
			id: handle.id,
			width: handle.width ?? 1,
			height: handle.height ?? 1,
			nodeId: userNode.id,
			x: handle.x,
			y: handle.y,
			position: handle.position,
			type: handle.type
		};
		if (handle.type === "source") source.push(handleBounds);
		else if (handle.type === "target") target.push(handleBounds);
	}
	return {
		source,
		target
	};
}
function isManualZIndexMode(zIndexMode) {
	return zIndexMode === "manual";
}
function adoptUserNodes(nodes, nodeLookup, parentLookup, options = {}) {
	const _options = mergeObjects(adoptUserNodesDefaultOptions, options);
	const rootParentIndex = { i: 0 };
	const tmpLookup = new Map(nodeLookup);
	const selectedNodeZ = _options?.elevateNodesOnSelect && !isManualZIndexMode(_options.zIndexMode) ? SELECTED_NODE_Z : 0;
	let nodesInitialized = nodes.length > 0;
	let hasSelectedNodes = false;
	nodeLookup.clear();
	parentLookup.clear();
	for (const userNode of nodes) {
		let internalNode = tmpLookup.get(userNode.id);
		if (_options.checkEquality && userNode === internalNode?.internals.userNode) nodeLookup.set(userNode.id, internalNode);
		else {
			const clampedPosition = clampPosition(getNodePositionWithOrigin(userNode, _options.nodeOrigin), isCoordinateExtent(userNode.extent) ? userNode.extent : _options.nodeExtent, getNodeDimensions(userNode));
			internalNode = {
				..._options.defaults,
				...userNode,
				measured: {
					width: userNode.measured?.width,
					height: userNode.measured?.height
				},
				internals: {
					positionAbsolute: clampedPosition,
					handleBounds: parseHandles(userNode, internalNode),
					z: calculateZ(userNode, selectedNodeZ, _options.zIndexMode),
					userNode
				}
			};
			nodeLookup.set(userNode.id, internalNode);
		}
		if ((internalNode.measured === void 0 || internalNode.measured.width === void 0 || internalNode.measured.height === void 0) && !internalNode.hidden) nodesInitialized = false;
		if (userNode.parentId) updateChildNode(internalNode, nodeLookup, parentLookup, options, rootParentIndex);
		hasSelectedNodes ||= userNode.selected ?? false;
	}
	return {
		nodesInitialized,
		hasSelectedNodes
	};
}
function updateParentLookup(node, parentLookup) {
	if (!node.parentId) return;
	const childNodes = parentLookup.get(node.parentId);
	if (childNodes) childNodes.set(node.id, node);
	else parentLookup.set(node.parentId, new Map([[node.id, node]]));
}
/**
* Updates positionAbsolute and zIndex of a child node and the parentLookup.
*/
function updateChildNode(node, nodeLookup, parentLookup, options, rootParentIndex) {
	const { elevateNodesOnSelect, nodeOrigin, nodeExtent, zIndexMode } = mergeObjects(defaultOptions, options);
	const parentId = node.parentId;
	const parentNode = nodeLookup.get(parentId);
	if (!parentNode) {
		console.warn(`Parent node ${parentId} not found. Please make sure that parent nodes are in front of their child nodes in the nodes array.`);
		return;
	}
	updateParentLookup(node, parentLookup);
	if (rootParentIndex && !parentNode.parentId && parentNode.internals.rootParentIndex === void 0 && zIndexMode === "auto") {
		parentNode.internals.rootParentIndex = ++rootParentIndex.i;
		parentNode.internals.z = parentNode.internals.z + rootParentIndex.i * ROOT_PARENT_Z_INCREMENT;
	}
	if (rootParentIndex && parentNode.internals.rootParentIndex !== void 0) rootParentIndex.i = parentNode.internals.rootParentIndex;
	const { x, y, z } = calculateChildXYZ(node, parentNode, nodeOrigin, nodeExtent, elevateNodesOnSelect && !isManualZIndexMode(zIndexMode) ? SELECTED_NODE_Z : 0, zIndexMode);
	const { positionAbsolute } = node.internals;
	const positionChanged = x !== positionAbsolute.x || y !== positionAbsolute.y;
	if (positionChanged || z !== node.internals.z) nodeLookup.set(node.id, {
		...node,
		internals: {
			...node.internals,
			positionAbsolute: positionChanged ? {
				x,
				y
			} : positionAbsolute,
			z
		}
	});
}
function calculateZ(node, selectedNodeZ, zIndexMode) {
	const zIndex = isNumeric(node.zIndex) ? node.zIndex : 0;
	if (isManualZIndexMode(zIndexMode)) return zIndex;
	return zIndex + (node.selected ? selectedNodeZ : 0);
}
function calculateChildXYZ(childNode, parentNode, nodeOrigin, nodeExtent, selectedNodeZ, zIndexMode) {
	const { x: parentX, y: parentY } = parentNode.internals.positionAbsolute;
	const childDimensions = getNodeDimensions(childNode);
	const positionWithOrigin = getNodePositionWithOrigin(childNode, nodeOrigin);
	const clampedPosition = isCoordinateExtent(childNode.extent) ? clampPosition(positionWithOrigin, childNode.extent, childDimensions) : positionWithOrigin;
	let absolutePosition = clampPosition({
		x: parentX + clampedPosition.x,
		y: parentY + clampedPosition.y
	}, nodeExtent, childDimensions);
	if (childNode.extent === "parent") absolutePosition = clampPositionToParent(absolutePosition, childDimensions, parentNode);
	const childZ = calculateZ(childNode, selectedNodeZ, zIndexMode);
	const parentZ = parentNode.internals.z ?? 0;
	return {
		x: absolutePosition.x,
		y: absolutePosition.y,
		z: parentZ >= childZ ? parentZ + 1 : childZ
	};
}
function handleExpandParent(children, nodeLookup, parentLookup, nodeOrigin = [0, 0]) {
	const changes = [];
	const parentExpansions = /* @__PURE__ */ new Map();
	for (const child of children) {
		const parent = nodeLookup.get(child.parentId);
		if (!parent) continue;
		const expandedRect = getBoundsOfRects(parentExpansions.get(child.parentId)?.expandedRect ?? nodeToRect(parent), child.rect);
		parentExpansions.set(child.parentId, {
			expandedRect,
			parent
		});
	}
	if (parentExpansions.size > 0) parentExpansions.forEach(({ expandedRect, parent }, parentId) => {
		const positionAbsolute = parent.internals.positionAbsolute;
		const dimensions = getNodeDimensions(parent);
		const origin = parent.origin ?? nodeOrigin;
		const xChange = expandedRect.x < positionAbsolute.x ? Math.round(Math.abs(positionAbsolute.x - expandedRect.x)) : 0;
		const yChange = expandedRect.y < positionAbsolute.y ? Math.round(Math.abs(positionAbsolute.y - expandedRect.y)) : 0;
		const newWidth = Math.max(dimensions.width, Math.round(expandedRect.width));
		const newHeight = Math.max(dimensions.height, Math.round(expandedRect.height));
		const widthChange = (newWidth - dimensions.width) * origin[0];
		const heightChange = (newHeight - dimensions.height) * origin[1];
		if (xChange > 0 || yChange > 0 || widthChange || heightChange) {
			changes.push({
				id: parentId,
				type: "position",
				position: {
					x: parent.position.x - xChange + widthChange,
					y: parent.position.y - yChange + heightChange
				}
			});
			parentLookup.get(parentId)?.forEach((childNode) => {
				if (!children.some((child) => child.id === childNode.id)) changes.push({
					id: childNode.id,
					type: "position",
					position: {
						x: childNode.position.x + xChange,
						y: childNode.position.y + yChange
					}
				});
			});
		}
		if (dimensions.width < expandedRect.width || dimensions.height < expandedRect.height || xChange || yChange) changes.push({
			id: parentId,
			type: "dimensions",
			setAttributes: true,
			dimensions: {
				width: newWidth + (xChange ? origin[0] * xChange - widthChange : 0),
				height: newHeight + (yChange ? origin[1] * yChange - heightChange : 0)
			}
		});
	});
	return changes;
}
function updateNodeInternals(updates, nodeLookup, parentLookup, domNode, nodeOrigin, nodeExtent, zIndexMode) {
	const viewportNode = domNode?.querySelector(".xyflow__viewport");
	let updatedInternals = false;
	if (!viewportNode) return {
		changes: [],
		updatedInternals
	};
	const changes = [];
	const style = window.getComputedStyle(viewportNode);
	const { m22: zoom } = new window.DOMMatrixReadOnly(style.transform);
	const parentExpandChildren = [];
	for (const update of updates.values()) {
		const node = nodeLookup.get(update.id);
		if (!node) continue;
		if (node.hidden) {
			nodeLookup.set(node.id, {
				...node,
				internals: {
					...node.internals,
					handleBounds: void 0
				}
			});
			updatedInternals = true;
			continue;
		}
		const dimensions = getDimensions(update.nodeElement);
		const dimensionChanged = node.measured.width !== dimensions.width || node.measured.height !== dimensions.height;
		if (!!(dimensions.width && dimensions.height && (dimensionChanged || !node.internals.handleBounds || update.force))) {
			const nodeBounds = update.nodeElement.getBoundingClientRect();
			const extent = isCoordinateExtent(node.extent) ? node.extent : nodeExtent;
			let { positionAbsolute } = node.internals;
			if (node.parentId && node.extent === "parent") positionAbsolute = clampPositionToParent(positionAbsolute, dimensions, nodeLookup.get(node.parentId));
			else if (extent) positionAbsolute = clampPosition(positionAbsolute, extent, dimensions);
			const newNode = {
				...node,
				measured: dimensions,
				internals: {
					...node.internals,
					positionAbsolute,
					handleBounds: {
						source: getHandleBounds("source", update.nodeElement, nodeBounds, zoom, node.id),
						target: getHandleBounds("target", update.nodeElement, nodeBounds, zoom, node.id)
					}
				}
			};
			nodeLookup.set(node.id, newNode);
			if (node.parentId) updateChildNode(newNode, nodeLookup, parentLookup, {
				nodeOrigin,
				zIndexMode
			});
			updatedInternals = true;
			if (dimensionChanged) {
				changes.push({
					id: node.id,
					type: "dimensions",
					dimensions
				});
				if (node.expandParent && node.parentId) parentExpandChildren.push({
					id: node.id,
					parentId: node.parentId,
					rect: nodeToRect(newNode, nodeOrigin)
				});
			}
		}
	}
	if (parentExpandChildren.length > 0) {
		const parentExpandChanges = handleExpandParent(parentExpandChildren, nodeLookup, parentLookup, nodeOrigin);
		changes.push(...parentExpandChanges);
	}
	return {
		changes,
		updatedInternals
	};
}
async function panBy({ delta, panZoom, transform, translateExtent, width, height }) {
	if (!panZoom || !delta.x && !delta.y) return Promise.resolve(false);
	const nextViewport = await panZoom.setViewportConstrained({
		x: transform[0] + delta.x,
		y: transform[1] + delta.y,
		zoom: transform[2]
	}, [[0, 0], [width, height]], translateExtent);
	const transformChanged = !!nextViewport && (nextViewport.x !== transform[0] || nextViewport.y !== transform[1] || nextViewport.k !== transform[2]);
	return Promise.resolve(transformChanged);
}
/**
* this function adds the connection to the connectionLookup
* at the following keys: nodeId-type-handleId, nodeId-type and nodeId
* @param type type of the connection
* @param connection connection that should be added to the lookup
* @param connectionKey at which key the connection should be added
* @param connectionLookup reference to the connection lookup
* @param nodeId nodeId of the connection
* @param handleId handleId of the connection
*/
function addConnectionToLookup(type, connection, connectionKey, connectionLookup, nodeId, handleId) {
	let key = nodeId;
	const nodeMap = connectionLookup.get(key) || /* @__PURE__ */ new Map();
	connectionLookup.set(key, nodeMap.set(connectionKey, connection));
	key = `${nodeId}-${type}`;
	const typeMap = connectionLookup.get(key) || /* @__PURE__ */ new Map();
	connectionLookup.set(key, typeMap.set(connectionKey, connection));
	if (handleId) {
		key = `${nodeId}-${type}-${handleId}`;
		const handleMap = connectionLookup.get(key) || /* @__PURE__ */ new Map();
		connectionLookup.set(key, handleMap.set(connectionKey, connection));
	}
}
function updateConnectionLookup(connectionLookup, edgeLookup, edges) {
	connectionLookup.clear();
	edgeLookup.clear();
	for (const edge of edges) {
		const { source: sourceNode, target: targetNode, sourceHandle = null, targetHandle = null } = edge;
		const connection = {
			edgeId: edge.id,
			source: sourceNode,
			target: targetNode,
			sourceHandle,
			targetHandle
		};
		const sourceKey = `${sourceNode}-${sourceHandle}--${targetNode}-${targetHandle}`;
		addConnectionToLookup("source", connection, `${targetNode}-${targetHandle}--${sourceNode}-${sourceHandle}`, connectionLookup, sourceNode, sourceHandle);
		addConnectionToLookup("target", connection, sourceKey, connectionLookup, targetNode, targetHandle);
		edgeLookup.set(edge.id, edge);
	}
}
function isParentSelected(node, nodeLookup) {
	if (!node.parentId) return false;
	const parentNode = nodeLookup.get(node.parentId);
	if (!parentNode) return false;
	if (parentNode.selected) return true;
	return isParentSelected(parentNode, nodeLookup);
}
function hasSelector(target, selector, domNode) {
	let current = target;
	do {
		if (current?.matches?.(selector)) return true;
		if (current === domNode) return false;
		current = current?.parentElement;
	} while (current);
	return false;
}
function getDragItems(nodeLookup, nodesDraggable, mousePos, nodeId) {
	const dragItems = /* @__PURE__ */ new Map();
	for (const [id, node] of nodeLookup) if ((node.selected || node.id === nodeId) && (!node.parentId || !isParentSelected(node, nodeLookup)) && (node.draggable || nodesDraggable && typeof node.draggable === "undefined")) {
		const internalNode = nodeLookup.get(id);
		if (internalNode) dragItems.set(id, {
			id,
			position: internalNode.position || {
				x: 0,
				y: 0
			},
			distance: {
				x: mousePos.x - internalNode.internals.positionAbsolute.x,
				y: mousePos.y - internalNode.internals.positionAbsolute.y
			},
			extent: internalNode.extent,
			parentId: internalNode.parentId,
			origin: internalNode.origin,
			expandParent: internalNode.expandParent,
			internals: { positionAbsolute: internalNode.internals.positionAbsolute || {
				x: 0,
				y: 0
			} },
			measured: {
				width: internalNode.measured.width ?? 0,
				height: internalNode.measured.height ?? 0
			}
		});
	}
	return dragItems;
}
function getEventHandlerParams({ nodeId, dragItems, nodeLookup, dragging = true }) {
	const nodesFromDragItems = [];
	for (const [id, dragItem] of dragItems) {
		const node = nodeLookup.get(id)?.internals.userNode;
		if (node) nodesFromDragItems.push({
			...node,
			position: dragItem.position,
			dragging
		});
	}
	if (!nodeId) return [nodesFromDragItems[0], nodesFromDragItems];
	const node = nodeLookup.get(nodeId)?.internals.userNode;
	return [!node ? nodesFromDragItems[0] : {
		...node,
		position: dragItems.get(nodeId)?.position || node.position,
		dragging
	}, nodesFromDragItems];
}
/**
* If a selection is being dragged we want to apply the same snap offset to all nodes in the selection.
* This function calculates the snap offset based on the first node in the selection.
*/
function calculateSnapOffset({ dragItems, snapGrid, x, y }) {
	const refDragItem = dragItems.values().next().value;
	if (!refDragItem) return null;
	const refPos = {
		x: x - refDragItem.distance.x,
		y: y - refDragItem.distance.y
	};
	const refPosSnapped = snapPosition(refPos, snapGrid);
	return {
		x: refPosSnapped.x - refPos.x,
		y: refPosSnapped.y - refPos.y
	};
}
function XYDrag({ onNodeMouseDown, getStoreItems, onDragStart, onDrag, onDragStop }) {
	let lastPos = {
		x: null,
		y: null
	};
	let autoPanId = 0;
	let dragItems = /* @__PURE__ */ new Map();
	let autoPanStarted = false;
	let mousePosition = {
		x: 0,
		y: 0
	};
	let containerBounds = null;
	let dragStarted = false;
	let d3Selection = null;
	let abortDrag = false;
	let nodePositionsChanged = false;
	let dragEvent = null;
	function update({ noDragClassName, handleSelector, domNode, isSelectable, nodeId, nodeClickDistance = 0 }) {
		d3Selection = select_default$1(domNode);
		function updateNodes({ x, y }) {
			const { nodeLookup, nodeExtent, snapGrid, snapToGrid, nodeOrigin, onNodeDrag, onSelectionDrag, onError, updateNodePositions } = getStoreItems();
			lastPos = {
				x,
				y
			};
			let hasChange = false;
			const isMultiDrag = dragItems.size > 1;
			const nodesBox = isMultiDrag && nodeExtent ? rectToBox(getInternalNodesBounds(dragItems)) : null;
			const multiDragSnapOffset = isMultiDrag && snapToGrid ? calculateSnapOffset({
				dragItems,
				snapGrid,
				x,
				y
			}) : null;
			for (const [id, dragItem] of dragItems) {
				if (!nodeLookup.has(id)) continue;
				let nextPosition = {
					x: x - dragItem.distance.x,
					y: y - dragItem.distance.y
				};
				if (snapToGrid) nextPosition = multiDragSnapOffset ? {
					x: Math.round(nextPosition.x + multiDragSnapOffset.x),
					y: Math.round(nextPosition.y + multiDragSnapOffset.y)
				} : snapPosition(nextPosition, snapGrid);
				let adjustedNodeExtent = null;
				if (isMultiDrag && nodeExtent && !dragItem.extent && nodesBox) {
					const { positionAbsolute } = dragItem.internals;
					const x1 = positionAbsolute.x - nodesBox.x + nodeExtent[0][0];
					const x2 = positionAbsolute.x + dragItem.measured.width - nodesBox.x2 + nodeExtent[1][0];
					const y1 = positionAbsolute.y - nodesBox.y + nodeExtent[0][1];
					const y2 = positionAbsolute.y + dragItem.measured.height - nodesBox.y2 + nodeExtent[1][1];
					adjustedNodeExtent = [[x1, y1], [x2, y2]];
				}
				const { position, positionAbsolute } = calculateNodePosition({
					nodeId: id,
					nextPosition,
					nodeLookup,
					nodeExtent: adjustedNodeExtent ? adjustedNodeExtent : nodeExtent,
					nodeOrigin,
					onError
				});
				hasChange = hasChange || dragItem.position.x !== position.x || dragItem.position.y !== position.y;
				dragItem.position = position;
				dragItem.internals.positionAbsolute = positionAbsolute;
			}
			nodePositionsChanged = nodePositionsChanged || hasChange;
			if (!hasChange) return;
			updateNodePositions(dragItems, true);
			if (dragEvent && (onDrag || onNodeDrag || !nodeId && onSelectionDrag)) {
				const [currentNode, currentNodes] = getEventHandlerParams({
					nodeId,
					dragItems,
					nodeLookup
				});
				onDrag?.(dragEvent, dragItems, currentNode, currentNodes);
				onNodeDrag?.(dragEvent, currentNode, currentNodes);
				if (!nodeId) onSelectionDrag?.(dragEvent, currentNodes);
			}
		}
		async function autoPan() {
			if (!containerBounds) return;
			const { transform, panBy, autoPanSpeed, autoPanOnNodeDrag } = getStoreItems();
			if (!autoPanOnNodeDrag) {
				autoPanStarted = false;
				cancelAnimationFrame(autoPanId);
				return;
			}
			const [xMovement, yMovement] = calcAutoPan(mousePosition, containerBounds, autoPanSpeed);
			if (xMovement !== 0 || yMovement !== 0) {
				lastPos.x = (lastPos.x ?? 0) - xMovement / transform[2];
				lastPos.y = (lastPos.y ?? 0) - yMovement / transform[2];
				if (await panBy({
					x: xMovement,
					y: yMovement
				})) updateNodes(lastPos);
			}
			autoPanId = requestAnimationFrame(autoPan);
		}
		function startDrag(event) {
			const { nodeLookup, multiSelectionActive, nodesDraggable, transform, snapGrid, snapToGrid, selectNodesOnDrag, onNodeDragStart, onSelectionDragStart, unselectNodesAndEdges } = getStoreItems();
			dragStarted = true;
			if ((!selectNodesOnDrag || !isSelectable) && !multiSelectionActive && nodeId) {
				if (!nodeLookup.get(nodeId)?.selected) unselectNodesAndEdges();
			}
			if (isSelectable && selectNodesOnDrag && nodeId) onNodeMouseDown?.(nodeId);
			const pointerPos = getPointerPosition(event.sourceEvent, {
				transform,
				snapGrid,
				snapToGrid,
				containerBounds
			});
			lastPos = pointerPos;
			dragItems = getDragItems(nodeLookup, nodesDraggable, pointerPos, nodeId);
			if (dragItems.size > 0 && (onDragStart || onNodeDragStart || !nodeId && onSelectionDragStart)) {
				const [currentNode, currentNodes] = getEventHandlerParams({
					nodeId,
					dragItems,
					nodeLookup
				});
				onDragStart?.(event.sourceEvent, dragItems, currentNode, currentNodes);
				onNodeDragStart?.(event.sourceEvent, currentNode, currentNodes);
				if (!nodeId) onSelectionDragStart?.(event.sourceEvent, currentNodes);
			}
		}
		const d3DragInstance = drag_default().clickDistance(nodeClickDistance).on("start", (event) => {
			const { domNode, nodeDragThreshold, transform, snapGrid, snapToGrid } = getStoreItems();
			containerBounds = domNode?.getBoundingClientRect() || null;
			abortDrag = false;
			nodePositionsChanged = false;
			dragEvent = event.sourceEvent;
			if (nodeDragThreshold === 0) startDrag(event);
			lastPos = getPointerPosition(event.sourceEvent, {
				transform,
				snapGrid,
				snapToGrid,
				containerBounds
			});
			mousePosition = getEventPosition(event.sourceEvent, containerBounds);
		}).on("drag", (event) => {
			const { autoPanOnNodeDrag, transform, snapGrid, snapToGrid, nodeDragThreshold, nodeLookup } = getStoreItems();
			const pointerPos = getPointerPosition(event.sourceEvent, {
				transform,
				snapGrid,
				snapToGrid,
				containerBounds
			});
			dragEvent = event.sourceEvent;
			if (event.sourceEvent.type === "touchmove" && event.sourceEvent.touches.length > 1 || nodeId && !nodeLookup.has(nodeId)) abortDrag = true;
			if (abortDrag) return;
			if (!autoPanStarted && autoPanOnNodeDrag && dragStarted) {
				autoPanStarted = true;
				autoPan();
			}
			if (!dragStarted) {
				const currentMousePosition = getEventPosition(event.sourceEvent, containerBounds);
				const x = currentMousePosition.x - mousePosition.x;
				const y = currentMousePosition.y - mousePosition.y;
				if (Math.sqrt(x * x + y * y) > nodeDragThreshold) startDrag(event);
			}
			if ((lastPos.x !== pointerPos.xSnapped || lastPos.y !== pointerPos.ySnapped) && dragItems && dragStarted) {
				mousePosition = getEventPosition(event.sourceEvent, containerBounds);
				updateNodes(pointerPos);
			}
		}).on("end", (event) => {
			if (!dragStarted || abortDrag) return;
			autoPanStarted = false;
			dragStarted = false;
			cancelAnimationFrame(autoPanId);
			if (dragItems.size > 0) {
				const { nodeLookup, updateNodePositions, onNodeDragStop, onSelectionDragStop } = getStoreItems();
				if (nodePositionsChanged) {
					updateNodePositions(dragItems, false);
					nodePositionsChanged = false;
				}
				if (onDragStop || onNodeDragStop || !nodeId && onSelectionDragStop) {
					const [currentNode, currentNodes] = getEventHandlerParams({
						nodeId,
						dragItems,
						nodeLookup,
						dragging: false
					});
					onDragStop?.(event.sourceEvent, dragItems, currentNode, currentNodes);
					onNodeDragStop?.(event.sourceEvent, currentNode, currentNodes);
					if (!nodeId) onSelectionDragStop?.(event.sourceEvent, currentNodes);
				}
			}
		}).filter((event) => {
			const target = event.target;
			return !event.button && (!noDragClassName || !hasSelector(target, `.${noDragClassName}`, domNode)) && (!handleSelector || hasSelector(target, handleSelector, domNode));
		});
		d3Selection.call(d3DragInstance);
	}
	function destroy() {
		d3Selection?.on(".drag", null);
	}
	return {
		update,
		destroy
	};
}
function getNodesWithinDistance(position, nodeLookup, distance) {
	const nodes = [];
	const rect = {
		x: position.x - distance,
		y: position.y - distance,
		width: distance * 2,
		height: distance * 2
	};
	for (const node of nodeLookup.values()) if (getOverlappingArea(rect, nodeToRect(node)) > 0) nodes.push(node);
	return nodes;
}
const ADDITIONAL_DISTANCE = 250;
function getClosestHandle(position, connectionRadius, nodeLookup, fromHandle) {
	let closestHandles = [];
	let minDistance = Infinity;
	const closeNodes = getNodesWithinDistance(position, nodeLookup, connectionRadius + ADDITIONAL_DISTANCE);
	for (const node of closeNodes) {
		const allHandles = [...node.internals.handleBounds?.source ?? [], ...node.internals.handleBounds?.target ?? []];
		for (const handle of allHandles) {
			if (fromHandle.nodeId === handle.nodeId && fromHandle.type === handle.type && fromHandle.id === handle.id) continue;
			const { x, y } = getHandlePosition(node, handle, handle.position, true);
			const distance = Math.sqrt(Math.pow(x - position.x, 2) + Math.pow(y - position.y, 2));
			if (distance > connectionRadius) continue;
			if (distance < minDistance) {
				closestHandles = [{
					...handle,
					x,
					y
				}];
				minDistance = distance;
			} else if (distance === minDistance) closestHandles.push({
				...handle,
				x,
				y
			});
		}
	}
	if (!closestHandles.length) return null;
	if (closestHandles.length > 1) {
		const oppositeHandleType = fromHandle.type === "source" ? "target" : "source";
		return closestHandles.find((handle) => handle.type === oppositeHandleType) ?? closestHandles[0];
	}
	return closestHandles[0];
}
function getHandle(nodeId, handleType, handleId, nodeLookup, connectionMode, withAbsolutePosition = false) {
	const node = nodeLookup.get(nodeId);
	if (!node) return null;
	const handles = connectionMode === "strict" ? node.internals.handleBounds?.[handleType] : [...node.internals.handleBounds?.source ?? [], ...node.internals.handleBounds?.target ?? []];
	const handle = (handleId ? handles?.find((h) => h.id === handleId) : handles?.[0]) ?? null;
	return handle && withAbsolutePosition ? {
		...handle,
		...getHandlePosition(node, handle, handle.position, true)
	} : handle;
}
function getHandleType(edgeUpdaterType, handleDomNode) {
	if (edgeUpdaterType) return edgeUpdaterType;
	else if (handleDomNode?.classList.contains("target")) return "target";
	else if (handleDomNode?.classList.contains("source")) return "source";
	return null;
}
function isConnectionValid(isInsideConnectionRadius, isHandleValid) {
	let isValid = null;
	if (isHandleValid) isValid = true;
	else if (isInsideConnectionRadius && !isHandleValid) isValid = false;
	return isValid;
}
const alwaysValid = () => true;
function onPointerDown(event, { connectionMode, connectionRadius, handleId, nodeId, edgeUpdaterType, isTarget, domNode, nodeLookup, lib, autoPanOnConnect, flowId, panBy, cancelConnection, onConnectStart, onConnect, onConnectEnd, isValidConnection = alwaysValid, onReconnectEnd, updateConnection, getTransform, getFromHandle, autoPanSpeed, dragThreshold = 1, handleDomNode }) {
	const doc = getHostForElement(event.target);
	let autoPanId = 0;
	let closestHandle;
	const { x, y } = getEventPosition(event);
	const handleType = getHandleType(edgeUpdaterType, handleDomNode);
	const containerBounds = domNode?.getBoundingClientRect();
	let connectionStarted = false;
	if (!containerBounds || !handleType) return;
	const fromHandleInternal = getHandle(nodeId, handleType, handleId, nodeLookup, connectionMode);
	if (!fromHandleInternal) return;
	let position = getEventPosition(event, containerBounds);
	let autoPanStarted = false;
	let connection = null;
	let isValid = false;
	let resultHandleDomNode = null;
	function autoPan() {
		if (!autoPanOnConnect || !containerBounds) return;
		const [x, y] = calcAutoPan(position, containerBounds, autoPanSpeed);
		panBy({
			x,
			y
		});
		autoPanId = requestAnimationFrame(autoPan);
	}
	const fromHandle = {
		...fromHandleInternal,
		nodeId,
		type: handleType,
		position: fromHandleInternal.position
	};
	const fromInternalNode = nodeLookup.get(nodeId);
	let previousConnection = {
		inProgress: true,
		isValid: null,
		from: getHandlePosition(fromInternalNode, fromHandle, Position.Left, true),
		fromHandle,
		fromPosition: fromHandle.position,
		fromNode: fromInternalNode,
		to: position,
		toHandle: null,
		toPosition: oppositePosition[fromHandle.position],
		toNode: null,
		pointer: position
	};
	function startConnection() {
		connectionStarted = true;
		updateConnection(previousConnection);
		onConnectStart?.(event, {
			nodeId,
			handleId,
			handleType
		});
	}
	if (dragThreshold === 0) startConnection();
	function onPointerMove(event) {
		if (!connectionStarted) {
			const { x: evtX, y: evtY } = getEventPosition(event);
			const dx = evtX - x;
			const dy = evtY - y;
			if (!(dx * dx + dy * dy > dragThreshold * dragThreshold)) return;
			startConnection();
		}
		if (!getFromHandle() || !fromHandle) {
			onPointerUp(event);
			return;
		}
		const transform = getTransform();
		position = getEventPosition(event, containerBounds);
		closestHandle = getClosestHandle(pointToRendererPoint(position, transform, false, [1, 1]), connectionRadius, nodeLookup, fromHandle);
		if (!autoPanStarted) {
			autoPan();
			autoPanStarted = true;
		}
		const result = isValidHandle(event, {
			handle: closestHandle,
			connectionMode,
			fromNodeId: nodeId,
			fromHandleId: handleId,
			fromType: isTarget ? "target" : "source",
			isValidConnection,
			doc,
			lib,
			flowId,
			nodeLookup
		});
		resultHandleDomNode = result.handleDomNode;
		connection = result.connection;
		isValid = isConnectionValid(!!closestHandle, result.isValid);
		const fromInternalNode = nodeLookup.get(nodeId);
		const from = fromInternalNode ? getHandlePosition(fromInternalNode, fromHandle, Position.Left, true) : previousConnection.from;
		const newConnection = {
			...previousConnection,
			from,
			isValid,
			to: result.toHandle && isValid ? rendererPointToPoint({
				x: result.toHandle.x,
				y: result.toHandle.y
			}, transform) : position,
			toHandle: result.toHandle,
			toPosition: isValid && result.toHandle ? result.toHandle.position : oppositePosition[fromHandle.position],
			toNode: result.toHandle ? nodeLookup.get(result.toHandle.nodeId) : null,
			pointer: position
		};
		updateConnection(newConnection);
		previousConnection = newConnection;
	}
	function onPointerUp(event) {
		if ("touches" in event && event.touches.length > 0) return;
		if (connectionStarted) {
			if ((closestHandle || resultHandleDomNode) && connection && isValid) onConnect?.(connection);
			const { inProgress, ...connectionState } = previousConnection;
			const finalConnectionState = {
				...connectionState,
				toPosition: previousConnection.toHandle ? previousConnection.toPosition : null
			};
			onConnectEnd?.(event, finalConnectionState);
			if (edgeUpdaterType) onReconnectEnd?.(event, finalConnectionState);
		}
		cancelConnection();
		cancelAnimationFrame(autoPanId);
		autoPanStarted = false;
		isValid = false;
		connection = null;
		resultHandleDomNode = null;
		doc.removeEventListener("mousemove", onPointerMove);
		doc.removeEventListener("mouseup", onPointerUp);
		doc.removeEventListener("touchmove", onPointerMove);
		doc.removeEventListener("touchend", onPointerUp);
	}
	doc.addEventListener("mousemove", onPointerMove);
	doc.addEventListener("mouseup", onPointerUp);
	doc.addEventListener("touchmove", onPointerMove);
	doc.addEventListener("touchend", onPointerUp);
}
function isValidHandle(event, { handle, connectionMode, fromNodeId, fromHandleId, fromType, doc, lib, flowId, isValidConnection = alwaysValid, nodeLookup }) {
	const isTarget = fromType === "target";
	const handleDomNode = handle ? doc.querySelector(`.${lib}-flow__handle[data-id="${flowId}-${handle?.nodeId}-${handle?.id}-${handle?.type}"]`) : null;
	const { x, y } = getEventPosition(event);
	const handleBelow = doc.elementFromPoint(x, y);
	const handleToCheck = handleBelow?.classList.contains(`${lib}-flow__handle`) ? handleBelow : handleDomNode;
	const result = {
		handleDomNode: handleToCheck,
		isValid: false,
		connection: null,
		toHandle: null
	};
	if (handleToCheck) {
		const handleType = getHandleType(void 0, handleToCheck);
		const handleNodeId = handleToCheck.getAttribute("data-nodeid");
		const handleId = handleToCheck.getAttribute("data-handleid");
		const connectable = handleToCheck.classList.contains("connectable");
		const connectableEnd = handleToCheck.classList.contains("connectableend");
		if (!handleNodeId || !handleType) return result;
		const connection = {
			source: isTarget ? handleNodeId : fromNodeId,
			sourceHandle: isTarget ? handleId : fromHandleId,
			target: isTarget ? fromNodeId : handleNodeId,
			targetHandle: isTarget ? fromHandleId : handleId
		};
		result.connection = connection;
		result.isValid = connectable && connectableEnd && (connectionMode === ConnectionMode.Strict ? isTarget && handleType === "source" || !isTarget && handleType === "target" : handleNodeId !== fromNodeId || handleId !== fromHandleId) && isValidConnection(connection);
		result.toHandle = getHandle(handleNodeId, handleType, handleId, nodeLookup, connectionMode, true);
	}
	return result;
}
const XYHandle = {
	onPointerDown,
	isValid: isValidHandle
};
function XYMinimap({ domNode, panZoom, getTransform, getViewScale }) {
	const selection = select_default$1(domNode);
	function update({ translateExtent, width, height, zoomStep = 1, pannable = true, zoomable = true, inversePan = false }) {
		const zoomHandler = (event) => {
			if (event.sourceEvent.type !== "wheel" || !panZoom) return;
			const transform = getTransform();
			const factor = event.sourceEvent.ctrlKey && isMacOs() ? 10 : 1;
			const pinchDelta = -event.sourceEvent.deltaY * (event.sourceEvent.deltaMode === 1 ? .05 : event.sourceEvent.deltaMode ? 1 : .002) * zoomStep;
			const nextZoom = transform[2] * Math.pow(2, pinchDelta * factor);
			panZoom.scaleTo(nextZoom);
		};
		let panStart = [0, 0];
		const panStartHandler = (event) => {
			if (event.sourceEvent.type === "mousedown" || event.sourceEvent.type === "touchstart") panStart = [event.sourceEvent.clientX ?? event.sourceEvent.touches[0].clientX, event.sourceEvent.clientY ?? event.sourceEvent.touches[0].clientY];
		};
		const panHandler = (event) => {
			const transform = getTransform();
			if (event.sourceEvent.type !== "mousemove" && event.sourceEvent.type !== "touchmove" || !panZoom) return;
			const panCurrent = [event.sourceEvent.clientX ?? event.sourceEvent.touches[0].clientX, event.sourceEvent.clientY ?? event.sourceEvent.touches[0].clientY];
			const panDelta = [panCurrent[0] - panStart[0], panCurrent[1] - panStart[1]];
			panStart = panCurrent;
			const moveScale = getViewScale() * Math.max(transform[2], Math.log(transform[2])) * (inversePan ? -1 : 1);
			const position = {
				x: transform[0] - panDelta[0] * moveScale,
				y: transform[1] - panDelta[1] * moveScale
			};
			const extent = [[0, 0], [width, height]];
			panZoom.setViewportConstrained({
				x: position.x,
				y: position.y,
				zoom: transform[2]
			}, extent, translateExtent);
		};
		const zoomAndPanHandler = zoom_default().on("start", panStartHandler).on("zoom", pannable ? panHandler : null).on("zoom.wheel", zoomable ? zoomHandler : null);
		selection.call(zoomAndPanHandler, {});
	}
	function destroy() {
		selection.on("zoom", null);
	}
	return {
		update,
		destroy,
		pointer: pointer_default
	};
}
const transformToViewport = (transform) => ({
	x: transform.x,
	y: transform.y,
	zoom: transform.k
});
const viewportToTransform = ({ x, y, zoom }) => identity$1.translate(x, y).scale(zoom);
const isWrappedWithClass = (event, className) => event.target.closest(`.${className}`);
const isRightClickPan = (panOnDrag, usedButton) => usedButton === 2 && Array.isArray(panOnDrag) && panOnDrag.includes(2);
const defaultEase = (t) => ((t *= 2) <= 1 ? t * t * t : (t -= 2) * t * t + 2) / 2;
const getD3Transition = (selection, duration = 0, ease = defaultEase, onEnd = () => {}) => {
	const hasDuration = typeof duration === "number" && duration > 0;
	if (!hasDuration) onEnd();
	return hasDuration ? selection.transition().duration(duration).ease(ease).on("end", onEnd) : selection;
};
const wheelDelta = (event) => {
	const factor = event.ctrlKey && isMacOs() ? 10 : 1;
	return -event.deltaY * (event.deltaMode === 1 ? .05 : event.deltaMode ? 1 : .002) * factor;
};
function createPanOnScrollHandler({ zoomPanValues, noWheelClassName, d3Selection, d3Zoom, panOnScrollMode, panOnScrollSpeed, zoomOnPinch, onPanZoomStart, onPanZoom, onPanZoomEnd }) {
	return (event) => {
		if (isWrappedWithClass(event, noWheelClassName)) {
			if (event.ctrlKey) event.preventDefault();
			return false;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
		const currentZoom = d3Selection.property("__zoom").k || 1;
		if (event.ctrlKey && zoomOnPinch) {
			const point = pointer_default(event);
			const pinchDelta = wheelDelta(event);
			const zoom = currentZoom * Math.pow(2, pinchDelta);
			d3Zoom.scaleTo(d3Selection, zoom, point, event);
			return;
		}
		const deltaNormalize = event.deltaMode === 1 ? 20 : 1;
		let deltaX = panOnScrollMode === PanOnScrollMode.Vertical ? 0 : event.deltaX * deltaNormalize;
		let deltaY = panOnScrollMode === PanOnScrollMode.Horizontal ? 0 : event.deltaY * deltaNormalize;
		if (!isMacOs() && event.shiftKey && panOnScrollMode !== PanOnScrollMode.Vertical) {
			deltaX = event.deltaY * deltaNormalize;
			deltaY = 0;
		}
		d3Zoom.translateBy(d3Selection, -(deltaX / currentZoom) * panOnScrollSpeed, -(deltaY / currentZoom) * panOnScrollSpeed, { internal: true });
		const nextViewport = transformToViewport(d3Selection.property("__zoom"));
		clearTimeout(zoomPanValues.panScrollTimeout);
		if (!zoomPanValues.isPanScrolling) {
			zoomPanValues.isPanScrolling = true;
			onPanZoomStart?.(event, nextViewport);
		} else {
			onPanZoom?.(event, nextViewport);
			zoomPanValues.panScrollTimeout = setTimeout(() => {
				onPanZoomEnd?.(event, nextViewport);
				zoomPanValues.isPanScrolling = false;
			}, 150);
		}
	};
}
function createZoomOnScrollHandler({ noWheelClassName, preventScrolling, d3ZoomHandler }) {
	return function(event, d) {
		const isWheel = event.type === "wheel";
		const preventZoom = !preventScrolling && isWheel && !event.ctrlKey;
		const hasNoWheelClass = isWrappedWithClass(event, noWheelClassName);
		if (event.ctrlKey && isWheel && hasNoWheelClass) event.preventDefault();
		if (preventZoom || hasNoWheelClass) return null;
		event.preventDefault();
		d3ZoomHandler.call(this, event, d);
	};
}
function createPanZoomStartHandler({ zoomPanValues, onDraggingChange, onPanZoomStart }) {
	return (event) => {
		if (event.sourceEvent?.internal) return;
		const viewport = transformToViewport(event.transform);
		zoomPanValues.mouseButton = event.sourceEvent?.button || 0;
		zoomPanValues.isZoomingOrPanning = true;
		zoomPanValues.prevViewport = viewport;
		if (event.sourceEvent?.type === "mousedown") onDraggingChange(true);
		if (onPanZoomStart) onPanZoomStart?.(event.sourceEvent, viewport);
	};
}
function createPanZoomHandler({ zoomPanValues, panOnDrag, onPaneContextMenu, onTransformChange, onPanZoom }) {
	return (event) => {
		zoomPanValues.usedRightMouseButton = !!(onPaneContextMenu && isRightClickPan(panOnDrag, zoomPanValues.mouseButton ?? 0));
		if (!event.sourceEvent?.sync) onTransformChange([
			event.transform.x,
			event.transform.y,
			event.transform.k
		]);
		if (onPanZoom && !event.sourceEvent?.internal) onPanZoom?.(event.sourceEvent, transformToViewport(event.transform));
	};
}
function createPanZoomEndHandler({ zoomPanValues, panOnDrag, panOnScroll, onDraggingChange, onPanZoomEnd, onPaneContextMenu }) {
	return (event) => {
		if (event.sourceEvent?.internal) return;
		zoomPanValues.isZoomingOrPanning = false;
		if (onPaneContextMenu && isRightClickPan(panOnDrag, zoomPanValues.mouseButton ?? 0) && !zoomPanValues.usedRightMouseButton && event.sourceEvent) onPaneContextMenu(event.sourceEvent);
		zoomPanValues.usedRightMouseButton = false;
		onDraggingChange(false);
		if (onPanZoomEnd) {
			const viewport = transformToViewport(event.transform);
			zoomPanValues.prevViewport = viewport;
			clearTimeout(zoomPanValues.timerId);
			zoomPanValues.timerId = setTimeout(() => {
				onPanZoomEnd?.(event.sourceEvent, viewport);
			}, panOnScroll ? 150 : 0);
		}
	};
}
function createFilter({ zoomActivationKeyPressed, zoomOnScroll, zoomOnPinch, panOnDrag, panOnScroll, zoomOnDoubleClick, userSelectionActive, noWheelClassName, noPanClassName, lib, connectionInProgress }) {
	return (event) => {
		const zoomScroll = zoomActivationKeyPressed || zoomOnScroll;
		const pinchZoom = zoomOnPinch && event.ctrlKey;
		const isWheelEvent = event.type === "wheel";
		if (event.button === 1 && event.type === "mousedown" && (isWrappedWithClass(event, `${lib}-flow__node`) || isWrappedWithClass(event, `${lib}-flow__edge`))) return true;
		if (!panOnDrag && !zoomScroll && !panOnScroll && !zoomOnDoubleClick && !zoomOnPinch) return false;
		if (userSelectionActive) return false;
		if (connectionInProgress && !isWheelEvent) return false;
		if (isWrappedWithClass(event, noWheelClassName) && isWheelEvent) return false;
		if (isWrappedWithClass(event, noPanClassName) && (!isWheelEvent || panOnScroll && isWheelEvent && !zoomActivationKeyPressed)) return false;
		if (!zoomOnPinch && event.ctrlKey && isWheelEvent) return false;
		if (!zoomOnPinch && event.type === "touchstart" && event.touches?.length > 1) {
			event.preventDefault();
			return false;
		}
		if (!zoomScroll && !panOnScroll && !pinchZoom && isWheelEvent) return false;
		if (!panOnDrag && (event.type === "mousedown" || event.type === "touchstart")) return false;
		if (Array.isArray(panOnDrag) && !panOnDrag.includes(event.button) && event.type === "mousedown") return false;
		const buttonAllowed = Array.isArray(panOnDrag) && panOnDrag.includes(event.button) || !event.button || event.button <= 1;
		return (!event.ctrlKey || isWheelEvent) && buttonAllowed;
	};
}
function XYPanZoom({ domNode, minZoom, maxZoom, translateExtent, viewport, onPanZoom, onPanZoomStart, onPanZoomEnd, onDraggingChange }) {
	const zoomPanValues = {
		isZoomingOrPanning: false,
		usedRightMouseButton: false,
		prevViewport: {
			x: 0,
			y: 0,
			zoom: 0
		},
		mouseButton: 0,
		timerId: void 0,
		panScrollTimeout: void 0,
		isPanScrolling: false
	};
	const bbox = domNode.getBoundingClientRect();
	const d3ZoomInstance = zoom_default().scaleExtent([minZoom, maxZoom]).translateExtent(translateExtent);
	const d3Selection = select_default$1(domNode).call(d3ZoomInstance);
	setViewportConstrained({
		x: viewport.x,
		y: viewport.y,
		zoom: clamp(viewport.zoom, minZoom, maxZoom)
	}, [[0, 0], [bbox.width, bbox.height]], translateExtent);
	const d3ZoomHandler = d3Selection.on("wheel.zoom");
	const d3DblClickZoomHandler = d3Selection.on("dblclick.zoom");
	d3ZoomInstance.wheelDelta(wheelDelta);
	function setTransform(transform, options) {
		if (d3Selection) return new Promise((resolve) => {
			d3ZoomInstance?.interpolate(options?.interpolate === "linear" ? value_default : zoom_default$1).transform(getD3Transition(d3Selection, options?.duration, options?.ease, () => resolve(true)), transform);
		});
		return Promise.resolve(false);
	}
	function update({ noWheelClassName, noPanClassName, onPaneContextMenu, userSelectionActive, panOnScroll, panOnDrag, panOnScrollMode, panOnScrollSpeed, preventScrolling, zoomOnPinch, zoomOnScroll, zoomOnDoubleClick, zoomActivationKeyPressed, lib, onTransformChange, connectionInProgress, paneClickDistance, selectionOnDrag }) {
		if (userSelectionActive && !zoomPanValues.isZoomingOrPanning) destroy();
		const isPanOnScroll = panOnScroll && !zoomActivationKeyPressed && !userSelectionActive;
		d3ZoomInstance.clickDistance(selectionOnDrag ? Infinity : !isNumeric(paneClickDistance) || paneClickDistance < 0 ? 0 : paneClickDistance);
		const wheelHandler = isPanOnScroll ? createPanOnScrollHandler({
			zoomPanValues,
			noWheelClassName,
			d3Selection,
			d3Zoom: d3ZoomInstance,
			panOnScrollMode,
			panOnScrollSpeed,
			zoomOnPinch,
			onPanZoomStart,
			onPanZoom,
			onPanZoomEnd
		}) : createZoomOnScrollHandler({
			noWheelClassName,
			preventScrolling,
			d3ZoomHandler
		});
		d3Selection.on("wheel.zoom", wheelHandler, { passive: false });
		if (!userSelectionActive) {
			const startHandler = createPanZoomStartHandler({
				zoomPanValues,
				onDraggingChange,
				onPanZoomStart
			});
			d3ZoomInstance.on("start", startHandler);
			const panZoomHandler = createPanZoomHandler({
				zoomPanValues,
				panOnDrag,
				onPaneContextMenu: !!onPaneContextMenu,
				onPanZoom,
				onTransformChange
			});
			d3ZoomInstance.on("zoom", panZoomHandler);
			const panZoomEndHandler = createPanZoomEndHandler({
				zoomPanValues,
				panOnDrag,
				panOnScroll,
				onPaneContextMenu,
				onPanZoomEnd,
				onDraggingChange
			});
			d3ZoomInstance.on("end", panZoomEndHandler);
		}
		const filter = createFilter({
			zoomActivationKeyPressed,
			panOnDrag,
			zoomOnScroll,
			panOnScroll,
			zoomOnDoubleClick,
			zoomOnPinch,
			userSelectionActive,
			noPanClassName,
			noWheelClassName,
			lib,
			connectionInProgress
		});
		d3ZoomInstance.filter(filter);
		if (zoomOnDoubleClick) d3Selection.on("dblclick.zoom", d3DblClickZoomHandler);
		else d3Selection.on("dblclick.zoom", null);
	}
	function destroy() {
		d3ZoomInstance.on("zoom", null);
	}
	async function setViewportConstrained(viewport, extent, translateExtent) {
		const nextTransform = viewportToTransform(viewport);
		const contrainedTransform = d3ZoomInstance?.constrain()(nextTransform, extent, translateExtent);
		if (contrainedTransform) await setTransform(contrainedTransform);
		return new Promise((resolve) => resolve(contrainedTransform));
	}
	async function setViewport(viewport, options) {
		const nextTransform = viewportToTransform(viewport);
		await setTransform(nextTransform, options);
		return new Promise((resolve) => resolve(nextTransform));
	}
	function syncViewport(viewport) {
		if (d3Selection) {
			const nextTransform = viewportToTransform(viewport);
			const currentTransform = d3Selection.property("__zoom");
			if (currentTransform.k !== viewport.zoom || currentTransform.x !== viewport.x || currentTransform.y !== viewport.y) d3ZoomInstance?.transform(d3Selection, nextTransform, null, { sync: true });
		}
	}
	function getViewport() {
		const transform$1 = d3Selection ? transform(d3Selection.node()) : {
			x: 0,
			y: 0,
			k: 1
		};
		return {
			x: transform$1.x,
			y: transform$1.y,
			zoom: transform$1.k
		};
	}
	function scaleTo(zoom, options) {
		if (d3Selection) return new Promise((resolve) => {
			d3ZoomInstance?.interpolate(options?.interpolate === "linear" ? value_default : zoom_default$1).scaleTo(getD3Transition(d3Selection, options?.duration, options?.ease, () => resolve(true)), zoom);
		});
		return Promise.resolve(false);
	}
	function scaleBy(factor, options) {
		if (d3Selection) return new Promise((resolve) => {
			d3ZoomInstance?.interpolate(options?.interpolate === "linear" ? value_default : zoom_default$1).scaleBy(getD3Transition(d3Selection, options?.duration, options?.ease, () => resolve(true)), factor);
		});
		return Promise.resolve(false);
	}
	function setScaleExtent(scaleExtent) {
		d3ZoomInstance?.scaleExtent(scaleExtent);
	}
	function setTranslateExtent(translateExtent) {
		d3ZoomInstance?.translateExtent(translateExtent);
	}
	function setClickDistance(distance) {
		const validDistance = !isNumeric(distance) || distance < 0 ? 0 : distance;
		d3ZoomInstance?.clickDistance(validDistance);
	}
	return {
		update,
		destroy,
		setViewport,
		setViewportConstrained,
		getViewport,
		scaleTo,
		scaleBy,
		setScaleExtent,
		setTranslateExtent,
		syncViewport,
		setClickDistance
	};
}
/**
* Used to determine the variant of the resize control
*
* @public
*/
var ResizeControlVariant;
(function(ResizeControlVariant) {
	ResizeControlVariant["Line"] = "line";
	ResizeControlVariant["Handle"] = "handle";
})(ResizeControlVariant || (ResizeControlVariant = {}));
/**
* Get all connecting edges for a given set of nodes
* @param width - new width of the node
* @param prevWidth - previous width of the node
* @param height - new height of the node
* @param prevHeight - previous height of the node
* @param affectsX - whether to invert the resize direction for the x axis
* @param affectsY - whether to invert the resize direction for the y axis
* @returns array of two numbers representing the direction of the resize for each axis, 0 = no change, 1 = increase, -1 = decrease
*/
function getResizeDirection({ width, prevWidth, height, prevHeight, affectsX, affectsY }) {
	const deltaWidth = width - prevWidth;
	const deltaHeight = height - prevHeight;
	const direction = [deltaWidth > 0 ? 1 : deltaWidth < 0 ? -1 : 0, deltaHeight > 0 ? 1 : deltaHeight < 0 ? -1 : 0];
	if (deltaWidth && affectsX) direction[0] = direction[0] * -1;
	if (deltaHeight && affectsY) direction[1] = direction[1] * -1;
	return direction;
}
/**
* Parses the control position that is being dragged to dimensions that are being resized
* @param controlPosition - position of the control that is being dragged
* @returns isHorizontal, isVertical, affectsX, affectsY,
*/
function getControlDirection(controlPosition) {
	return {
		isHorizontal: controlPosition.includes("right") || controlPosition.includes("left"),
		isVertical: controlPosition.includes("bottom") || controlPosition.includes("top"),
		affectsX: controlPosition.includes("left"),
		affectsY: controlPosition.includes("top")
	};
}
function getLowerExtentClamp(lowerExtent, lowerBound) {
	return Math.max(0, lowerBound - lowerExtent);
}
function getUpperExtentClamp(upperExtent, upperBound) {
	return Math.max(0, upperExtent - upperBound);
}
function getSizeClamp(size, minSize, maxSize) {
	return Math.max(0, minSize - size, size - maxSize);
}
function xor(a, b) {
	return a ? !b : b;
}
/**
* Calculates new width & height and x & y of node after resize based on pointer position
* @description - Buckle up, this is a chunky one... If you want to determine the new dimensions of a node after a resize,
* you have to account for all possible restrictions: min/max width/height of the node, the maximum extent the node is allowed
* to move in (in this case: resize into) determined by the parent node, the minimal extent determined by child nodes
* with expandParent or extent: 'parent' set and oh yeah, these things also have to work with keepAspectRatio!
* The way this is done is by determining how much each of these restricting actually restricts the resize and then applying the
* strongest restriction. Because the resize affects x, y and width, height and width, height of a opposing side with keepAspectRatio,
* the resize amount is always kept in distX & distY amount (the distance in mouse movement)
* Instead of clamping each value, we first calculate the biggest 'clamp' (for the lack of a better name) and then apply it to all values.
* To complicate things nodeOrigin has to be taken into account as well. This is done by offsetting the nodes as if their origin is [0, 0],
* then calculating the restrictions as usual
* @param startValues - starting values of resize
* @param controlDirection - dimensions affected by the resize
* @param pointerPosition - the current pointer position corrected for snapping
* @param boundaries - minimum and maximum dimensions of the node
* @param keepAspectRatio - prevent changes of asprect ratio
* @returns x, y, width and height of the node after resize
*/
function getDimensionsAfterResize(startValues, controlDirection, pointerPosition, boundaries, keepAspectRatio, nodeOrigin, extent, childExtent) {
	let { affectsX, affectsY } = controlDirection;
	const { isHorizontal, isVertical } = controlDirection;
	const isDiagonal = isHorizontal && isVertical;
	const { xSnapped, ySnapped } = pointerPosition;
	const { minWidth, maxWidth, minHeight, maxHeight } = boundaries;
	const { x: startX, y: startY, width: startWidth, height: startHeight, aspectRatio } = startValues;
	let distX = Math.floor(isHorizontal ? xSnapped - startValues.pointerX : 0);
	let distY = Math.floor(isVertical ? ySnapped - startValues.pointerY : 0);
	const newWidth = startWidth + (affectsX ? -distX : distX);
	const newHeight = startHeight + (affectsY ? -distY : distY);
	const originOffsetX = -nodeOrigin[0] * startWidth;
	const originOffsetY = -nodeOrigin[1] * startHeight;
	let clampX = getSizeClamp(newWidth, minWidth, maxWidth);
	let clampY = getSizeClamp(newHeight, minHeight, maxHeight);
	if (extent) {
		let xExtentClamp = 0;
		let yExtentClamp = 0;
		if (affectsX && distX < 0) xExtentClamp = getLowerExtentClamp(startX + distX + originOffsetX, extent[0][0]);
		else if (!affectsX && distX > 0) xExtentClamp = getUpperExtentClamp(startX + newWidth + originOffsetX, extent[1][0]);
		if (affectsY && distY < 0) yExtentClamp = getLowerExtentClamp(startY + distY + originOffsetY, extent[0][1]);
		else if (!affectsY && distY > 0) yExtentClamp = getUpperExtentClamp(startY + newHeight + originOffsetY, extent[1][1]);
		clampX = Math.max(clampX, xExtentClamp);
		clampY = Math.max(clampY, yExtentClamp);
	}
	if (childExtent) {
		let xExtentClamp = 0;
		let yExtentClamp = 0;
		if (affectsX && distX > 0) xExtentClamp = getUpperExtentClamp(startX + distX, childExtent[0][0]);
		else if (!affectsX && distX < 0) xExtentClamp = getLowerExtentClamp(startX + newWidth, childExtent[1][0]);
		if (affectsY && distY > 0) yExtentClamp = getUpperExtentClamp(startY + distY, childExtent[0][1]);
		else if (!affectsY && distY < 0) yExtentClamp = getLowerExtentClamp(startY + newHeight, childExtent[1][1]);
		clampX = Math.max(clampX, xExtentClamp);
		clampY = Math.max(clampY, yExtentClamp);
	}
	if (keepAspectRatio) {
		if (isHorizontal) {
			const aspectHeightClamp = getSizeClamp(newWidth / aspectRatio, minHeight, maxHeight) * aspectRatio;
			clampX = Math.max(clampX, aspectHeightClamp);
			if (extent) {
				let aspectExtentClamp = 0;
				if (!affectsX && !affectsY || affectsX && !affectsY && isDiagonal) aspectExtentClamp = getUpperExtentClamp(startY + originOffsetY + newWidth / aspectRatio, extent[1][1]) * aspectRatio;
				else aspectExtentClamp = getLowerExtentClamp(startY + originOffsetY + (affectsX ? distX : -distX) / aspectRatio, extent[0][1]) * aspectRatio;
				clampX = Math.max(clampX, aspectExtentClamp);
			}
			if (childExtent) {
				let aspectExtentClamp = 0;
				if (!affectsX && !affectsY || affectsX && !affectsY && isDiagonal) aspectExtentClamp = getLowerExtentClamp(startY + newWidth / aspectRatio, childExtent[1][1]) * aspectRatio;
				else aspectExtentClamp = getUpperExtentClamp(startY + (affectsX ? distX : -distX) / aspectRatio, childExtent[0][1]) * aspectRatio;
				clampX = Math.max(clampX, aspectExtentClamp);
			}
		}
		if (isVertical) {
			const aspectWidthClamp = getSizeClamp(newHeight * aspectRatio, minWidth, maxWidth) / aspectRatio;
			clampY = Math.max(clampY, aspectWidthClamp);
			if (extent) {
				let aspectExtentClamp = 0;
				if (!affectsX && !affectsY || affectsY && !affectsX && isDiagonal) aspectExtentClamp = getUpperExtentClamp(startX + newHeight * aspectRatio + originOffsetX, extent[1][0]) / aspectRatio;
				else aspectExtentClamp = getLowerExtentClamp(startX + (affectsY ? distY : -distY) * aspectRatio + originOffsetX, extent[0][0]) / aspectRatio;
				clampY = Math.max(clampY, aspectExtentClamp);
			}
			if (childExtent) {
				let aspectExtentClamp = 0;
				if (!affectsX && !affectsY || affectsY && !affectsX && isDiagonal) aspectExtentClamp = getLowerExtentClamp(startX + newHeight * aspectRatio, childExtent[1][0]) / aspectRatio;
				else aspectExtentClamp = getUpperExtentClamp(startX + (affectsY ? distY : -distY) * aspectRatio, childExtent[0][0]) / aspectRatio;
				clampY = Math.max(clampY, aspectExtentClamp);
			}
		}
	}
	distY = distY + (distY < 0 ? clampY : -clampY);
	distX = distX + (distX < 0 ? clampX : -clampX);
	if (keepAspectRatio) if (isDiagonal) if (newWidth > newHeight * aspectRatio) distY = (xor(affectsX, affectsY) ? -distX : distX) / aspectRatio;
	else distX = (xor(affectsX, affectsY) ? -distY : distY) * aspectRatio;
	else if (isHorizontal) {
		distY = distX / aspectRatio;
		affectsY = affectsX;
	} else {
		distX = distY * aspectRatio;
		affectsX = affectsY;
	}
	const x = affectsX ? startX + distX : startX;
	const y = affectsY ? startY + distY : startY;
	return {
		width: startWidth + (affectsX ? -distX : distX),
		height: startHeight + (affectsY ? -distY : distY),
		x: nodeOrigin[0] * distX * (!affectsX ? 1 : -1) + x,
		y: nodeOrigin[1] * distY * (!affectsY ? 1 : -1) + y
	};
}
const initPrevValues$1 = {
	width: 0,
	height: 0,
	x: 0,
	y: 0
};
const initStartValues = {
	...initPrevValues$1,
	pointerX: 0,
	pointerY: 0,
	aspectRatio: 1
};
function nodeToParentExtent(node) {
	return [[0, 0], [node.measured.width, node.measured.height]];
}
function nodeToChildExtent(child, parent, nodeOrigin) {
	const x = parent.position.x + child.position.x;
	const y = parent.position.y + child.position.y;
	const width = child.measured.width ?? 0;
	const height = child.measured.height ?? 0;
	const originOffsetX = nodeOrigin[0] * width;
	const originOffsetY = nodeOrigin[1] * height;
	return [[x - originOffsetX, y - originOffsetY], [x + width - originOffsetX, y + height - originOffsetY]];
}
function XYResizer({ domNode, nodeId, getStoreItems, onChange, onEnd }) {
	const selection = select_default$1(domNode);
	let params = {
		controlDirection: getControlDirection("bottom-right"),
		boundaries: {
			minWidth: 0,
			minHeight: 0,
			maxWidth: Number.MAX_VALUE,
			maxHeight: Number.MAX_VALUE
		},
		resizeDirection: void 0,
		keepAspectRatio: false
	};
	function update({ controlPosition, boundaries, keepAspectRatio, resizeDirection, onResizeStart, onResize, onResizeEnd, shouldResize }) {
		let prevValues = { ...initPrevValues$1 };
		let startValues = { ...initStartValues };
		params = {
			boundaries,
			resizeDirection,
			keepAspectRatio,
			controlDirection: getControlDirection(controlPosition)
		};
		let node = void 0;
		let containerBounds = null;
		let childNodes = [];
		let parentNode = void 0;
		let parentExtent = void 0;
		let childExtent = void 0;
		let resizeDetected = false;
		const dragHandler = drag_default().on("start", (event) => {
			const { nodeLookup, transform, snapGrid, snapToGrid, nodeOrigin, paneDomNode } = getStoreItems();
			node = nodeLookup.get(nodeId);
			if (!node) return;
			containerBounds = paneDomNode?.getBoundingClientRect() ?? null;
			const { xSnapped, ySnapped } = getPointerPosition(event.sourceEvent, {
				transform,
				snapGrid,
				snapToGrid,
				containerBounds
			});
			prevValues = {
				width: node.measured.width ?? 0,
				height: node.measured.height ?? 0,
				x: node.position.x ?? 0,
				y: node.position.y ?? 0
			};
			startValues = {
				...prevValues,
				pointerX: xSnapped,
				pointerY: ySnapped,
				aspectRatio: prevValues.width / prevValues.height
			};
			parentNode = void 0;
			if (node.parentId && (node.extent === "parent" || node.expandParent)) {
				parentNode = nodeLookup.get(node.parentId);
				parentExtent = parentNode && node.extent === "parent" ? nodeToParentExtent(parentNode) : void 0;
			}
			childNodes = [];
			childExtent = void 0;
			for (const [childId, child] of nodeLookup) if (child.parentId === nodeId) {
				childNodes.push({
					id: childId,
					position: { ...child.position },
					extent: child.extent
				});
				if (child.extent === "parent" || child.expandParent) {
					const extent = nodeToChildExtent(child, node, child.origin ?? nodeOrigin);
					if (childExtent) childExtent = [[Math.min(extent[0][0], childExtent[0][0]), Math.min(extent[0][1], childExtent[0][1])], [Math.max(extent[1][0], childExtent[1][0]), Math.max(extent[1][1], childExtent[1][1])]];
					else childExtent = extent;
				}
			}
			onResizeStart?.(event, { ...prevValues });
		}).on("drag", (event) => {
			const { transform, snapGrid, snapToGrid, nodeOrigin: storeNodeOrigin } = getStoreItems();
			const pointerPosition = getPointerPosition(event.sourceEvent, {
				transform,
				snapGrid,
				snapToGrid,
				containerBounds
			});
			const childChanges = [];
			if (!node) return;
			const { x: prevX, y: prevY, width: prevWidth, height: prevHeight } = prevValues;
			const change = {};
			const nodeOrigin = node.origin ?? storeNodeOrigin;
			const { width, height, x, y } = getDimensionsAfterResize(startValues, params.controlDirection, pointerPosition, params.boundaries, params.keepAspectRatio, nodeOrigin, parentExtent, childExtent);
			const isWidthChange = width !== prevWidth;
			const isHeightChange = height !== prevHeight;
			const isXPosChange = x !== prevX && isWidthChange;
			const isYPosChange = y !== prevY && isHeightChange;
			if (!isXPosChange && !isYPosChange && !isWidthChange && !isHeightChange) return;
			if (isXPosChange || isYPosChange || nodeOrigin[0] === 1 || nodeOrigin[1] === 1) {
				change.x = isXPosChange ? x : prevValues.x;
				change.y = isYPosChange ? y : prevValues.y;
				prevValues.x = change.x;
				prevValues.y = change.y;
				if (childNodes.length > 0) {
					const xChange = x - prevX;
					const yChange = y - prevY;
					for (const childNode of childNodes) {
						childNode.position = {
							x: childNode.position.x - xChange + nodeOrigin[0] * (width - prevWidth),
							y: childNode.position.y - yChange + nodeOrigin[1] * (height - prevHeight)
						};
						childChanges.push(childNode);
					}
				}
			}
			if (isWidthChange || isHeightChange) {
				change.width = isWidthChange && (!params.resizeDirection || params.resizeDirection === "horizontal") ? width : prevValues.width;
				change.height = isHeightChange && (!params.resizeDirection || params.resizeDirection === "vertical") ? height : prevValues.height;
				prevValues.width = change.width;
				prevValues.height = change.height;
			}
			if (parentNode && node.expandParent) {
				const xLimit = nodeOrigin[0] * (change.width ?? 0);
				if (change.x && change.x < xLimit) {
					prevValues.x = xLimit;
					startValues.x = startValues.x - (change.x - xLimit);
				}
				const yLimit = nodeOrigin[1] * (change.height ?? 0);
				if (change.y && change.y < yLimit) {
					prevValues.y = yLimit;
					startValues.y = startValues.y - (change.y - yLimit);
				}
			}
			const direction = getResizeDirection({
				width: prevValues.width,
				prevWidth,
				height: prevValues.height,
				prevHeight,
				affectsX: params.controlDirection.affectsX,
				affectsY: params.controlDirection.affectsY
			});
			const nextValues = {
				...prevValues,
				direction
			};
			if (shouldResize?.(event, nextValues) === false) return;
			resizeDetected = true;
			onResize?.(event, nextValues);
			onChange(change, childChanges);
		}).on("end", (event) => {
			if (!resizeDetected) return;
			onResizeEnd?.(event, { ...prevValues });
			onEnd?.({ ...prevValues });
			resizeDetected = false;
		});
		selection.call(dragHandler);
	}
	function destroy() {
		selection.on(".drag", null);
	}
	return {
		update,
		destroy
	};
}

//#endregion
//#region node_modules/.bun/use-sync-external-store@1.6.0+d86b59289c1a13ae/node_modules/use-sync-external-store/cjs/use-sync-external-store-shim.production.js
/**
* @license React
* use-sync-external-store-shim.production.js
*
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
var require_use_sync_external_store_shim_production = /* @__PURE__ */ __commonJSMin(((exports) => {
	var React$2 = __require("react");
	function is(x, y) {
		return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
	}
	var objectIs = "function" === typeof Object.is ? Object.is : is, useState = React$2.useState, useEffect = React$2.useEffect, useLayoutEffect = React$2.useLayoutEffect, useDebugValue = React$2.useDebugValue;
	function useSyncExternalStore$2(subscribe, getSnapshot) {
		var value = getSnapshot(), _useState = useState({ inst: {
			value,
			getSnapshot
		} }), inst = _useState[0].inst, forceUpdate = _useState[1];
		useLayoutEffect(function() {
			inst.value = value;
			inst.getSnapshot = getSnapshot;
			checkIfSnapshotChanged(inst) && forceUpdate({ inst });
		}, [
			subscribe,
			value,
			getSnapshot
		]);
		useEffect(function() {
			checkIfSnapshotChanged(inst) && forceUpdate({ inst });
			return subscribe(function() {
				checkIfSnapshotChanged(inst) && forceUpdate({ inst });
			});
		}, [subscribe]);
		useDebugValue(value);
		return value;
	}
	function checkIfSnapshotChanged(inst) {
		var latestGetSnapshot = inst.getSnapshot;
		inst = inst.value;
		try {
			var nextValue = latestGetSnapshot();
			return !objectIs(inst, nextValue);
		} catch (error) {
			return !0;
		}
	}
	function useSyncExternalStore$1(subscribe, getSnapshot) {
		return getSnapshot();
	}
	var shim = "undefined" === typeof window || "undefined" === typeof window.document || "undefined" === typeof window.document.createElement ? useSyncExternalStore$1 : useSyncExternalStore$2;
	exports.useSyncExternalStore = void 0 !== React$2.useSyncExternalStore ? React$2.useSyncExternalStore : shim;
}));

//#endregion
//#region node_modules/.bun/use-sync-external-store@1.6.0+d86b59289c1a13ae/node_modules/use-sync-external-store/shim/index.js
var require_shim = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_use_sync_external_store_shim_production();
}));

//#endregion
//#region node_modules/.bun/use-sync-external-store@1.6.0+d86b59289c1a13ae/node_modules/use-sync-external-store/cjs/use-sync-external-store-shim/with-selector.production.js
/**
* @license React
* use-sync-external-store-shim/with-selector.production.js
*
* Copyright (c) Meta Platforms, Inc. and affiliates.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/
var require_with_selector_production = /* @__PURE__ */ __commonJSMin(((exports) => {
	var React$1 = __require("react"), shim = require_shim();
	function is(x, y) {
		return x === y && (0 !== x || 1 / x === 1 / y) || x !== x && y !== y;
	}
	var objectIs = "function" === typeof Object.is ? Object.is : is, useSyncExternalStore = shim.useSyncExternalStore, useRef = React$1.useRef, useEffect = React$1.useEffect, useMemo = React$1.useMemo, useDebugValue = React$1.useDebugValue;
	exports.useSyncExternalStoreWithSelector = function(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
		var instRef = useRef(null);
		if (null === instRef.current) {
			var inst = {
				hasValue: !1,
				value: null
			};
			instRef.current = inst;
		} else inst = instRef.current;
		instRef = useMemo(function() {
			function memoizedSelector(nextSnapshot) {
				if (!hasMemo) {
					hasMemo = !0;
					memoizedSnapshot = nextSnapshot;
					nextSnapshot = selector(nextSnapshot);
					if (void 0 !== isEqual && inst.hasValue) {
						var currentSelection = inst.value;
						if (isEqual(currentSelection, nextSnapshot)) return memoizedSelection = currentSelection;
					}
					return memoizedSelection = nextSnapshot;
				}
				currentSelection = memoizedSelection;
				if (objectIs(memoizedSnapshot, nextSnapshot)) return currentSelection;
				var nextSelection = selector(nextSnapshot);
				if (void 0 !== isEqual && isEqual(currentSelection, nextSelection)) return memoizedSnapshot = nextSnapshot, currentSelection;
				memoizedSnapshot = nextSnapshot;
				return memoizedSelection = nextSelection;
			}
			var hasMemo = !1, memoizedSnapshot, memoizedSelection, maybeGetServerSnapshot = void 0 === getServerSnapshot ? null : getServerSnapshot;
			return [function() {
				return memoizedSelector(getSnapshot());
			}, null === maybeGetServerSnapshot ? void 0 : function() {
				return memoizedSelector(maybeGetServerSnapshot());
			}];
		}, [
			getSnapshot,
			getServerSnapshot,
			selector,
			isEqual
		]);
		var value = useSyncExternalStore(subscribe, instRef[0], instRef[1]);
		useEffect(function() {
			inst.hasValue = !0;
			inst.value = value;
		}, [value]);
		useDebugValue(value);
		return value;
	};
}));

//#endregion
//#region node_modules/.bun/use-sync-external-store@1.6.0+d86b59289c1a13ae/node_modules/use-sync-external-store/shim/with-selector.js
var require_with_selector = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_with_selector_production();
}));

//#endregion
//#region node_modules/.bun/zustand@4.5.7+bf264c7668a20073/node_modules/zustand/esm/vanilla.mjs
const createStoreImpl = (createState) => {
	let state;
	const listeners = /* @__PURE__ */ new Set();
	const setState = (partial, replace) => {
		const nextState = typeof partial === "function" ? partial(state) : partial;
		if (!Object.is(nextState, state)) {
			const previousState = state;
			state = (replace != null ? replace : typeof nextState !== "object" || nextState === null) ? nextState : Object.assign({}, state, nextState);
			listeners.forEach((listener) => listener(state, previousState));
		}
	};
	const getState = () => state;
	const getInitialState = () => initialState;
	const subscribe = (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const destroy = () => {
		if ((import.meta.env ? import.meta.env.MODE : void 0) !== "production") console.warn("[DEPRECATED] The `destroy` method will be unsupported in a future version. Instead use unsubscribe function returned by subscribe. Everything will be garbage-collected if store is garbage-collected.");
		listeners.clear();
	};
	const api = {
		setState,
		getState,
		getInitialState,
		subscribe,
		destroy
	};
	const initialState = state = createState(setState, getState, api);
	return api;
};
const createStore$1 = (createState) => createState ? createStoreImpl(createState) : createStoreImpl;

//#endregion
//#region node_modules/.bun/zustand@4.5.7+bf264c7668a20073/node_modules/zustand/esm/traditional.mjs
var import_with_selector = /* @__PURE__ */ __toESM(require_with_selector(), 1);
const { useDebugValue } = React;
const { useSyncExternalStoreWithSelector } = import_with_selector.default;
const identity = (arg) => arg;
function useStoreWithEqualityFn(api, selector = identity, equalityFn) {
	const slice = useSyncExternalStoreWithSelector(api.subscribe, api.getState, api.getServerState || api.getInitialState, selector, equalityFn);
	useDebugValue(slice);
	return slice;
}
const createWithEqualityFnImpl = (createState, defaultEqualityFn) => {
	const api = createStore$1(createState);
	const useBoundStoreWithEqualityFn = (selector, equalityFn = defaultEqualityFn) => useStoreWithEqualityFn(api, selector, equalityFn);
	Object.assign(useBoundStoreWithEqualityFn, api);
	return useBoundStoreWithEqualityFn;
};
const createWithEqualityFn = (createState, defaultEqualityFn) => createState ? createWithEqualityFnImpl(createState, defaultEqualityFn) : createWithEqualityFnImpl;

//#endregion
//#region node_modules/.bun/zustand@4.5.7+bf264c7668a20073/node_modules/zustand/esm/shallow.mjs
function shallow$1(objA, objB) {
	if (Object.is(objA, objB)) return true;
	if (typeof objA !== "object" || objA === null || typeof objB !== "object" || objB === null) return false;
	if (objA instanceof Map && objB instanceof Map) {
		if (objA.size !== objB.size) return false;
		for (const [key, value] of objA) if (!Object.is(value, objB.get(key))) return false;
		return true;
	}
	if (objA instanceof Set && objB instanceof Set) {
		if (objA.size !== objB.size) return false;
		for (const value of objA) if (!objB.has(value)) return false;
		return true;
	}
	const keysA = Object.keys(objA);
	if (keysA.length !== Object.keys(objB).length) return false;
	for (const keyA of keysA) if (!Object.prototype.hasOwnProperty.call(objB, keyA) || !Object.is(objA[keyA], objB[keyA])) return false;
	return true;
}

//#endregion
//#region node_modules/.bun/@xyflow+react@12.10.2+90fc049aeea155b6/node_modules/@xyflow/react/dist/esm/index.js
const StoreContext = createContext(null);
const Provider$1 = StoreContext.Provider;
const zustandErrorMessage = errorMessages["error001"]();
/**
* This hook can be used to subscribe to internal state changes of the React Flow
* component. The `useStore` hook is re-exported from the [Zustand](https://github.com/pmndrs/zustand)
* state management library, so you should check out their docs for more details.
*
* @public
* @param selector - A selector function that returns a slice of the flow's internal state.
* Extracting or transforming just the state you need is a good practice to avoid unnecessary
* re-renders.
* @param equalityFn - A function to compare the previous and next value. This is incredibly useful
* for preventing unnecessary re-renders. Good sensible defaults are using `Object.is` or importing
* `zustand/shallow`, but you can be as granular as you like.
* @returns The selected state slice.
*
* @example
* ```ts
* const nodes = useStore((state) => state.nodes);
* ```
*
* @remarks This hook should only be used if there is no other way to access the internal
* state. For many of the common use cases, there are dedicated hooks available
* such as {@link useReactFlow}, {@link useViewport}, etc.
*/
function useStore(selector, equalityFn) {
	const store = useContext(StoreContext);
	if (store === null) throw new Error(zustandErrorMessage);
	return useStoreWithEqualityFn(store, selector, equalityFn);
}
/**
* In some cases, you might need to access the store directly. This hook returns the store object which can be used on demand to access the state or dispatch actions.
*
* @returns The store object.
* @example
* ```ts
* const store = useStoreApi();
* ```
*
* @remarks This hook should only be used if there is no other way to access the internal
* state. For many of the common use cases, there are dedicated hooks available
* such as {@link useReactFlow}, {@link useViewport}, etc.
*/
function useStoreApi() {
	const store = useContext(StoreContext);
	if (store === null) throw new Error(zustandErrorMessage);
	return useMemo(() => ({
		getState: store.getState,
		setState: store.setState,
		subscribe: store.subscribe
	}), [store]);
}
const style = { display: "none" };
const ariaLiveStyle = {
	position: "absolute",
	width: 1,
	height: 1,
	margin: -1,
	border: 0,
	padding: 0,
	overflow: "hidden",
	clip: "rect(0px, 0px, 0px, 0px)",
	clipPath: "inset(100%)"
};
const ARIA_NODE_DESC_KEY = "react-flow__node-desc";
const ARIA_EDGE_DESC_KEY = "react-flow__edge-desc";
const ARIA_LIVE_MESSAGE = "react-flow__aria-live";
const ariaLiveSelector = (s) => s.ariaLiveMessage;
const ariaLabelConfigSelector = (s) => s.ariaLabelConfig;
function AriaLiveMessage({ rfId }) {
	const ariaLiveMessage = useStore(ariaLiveSelector);
	return (0, import_jsx_runtime.jsx)("div", {
		id: `${ARIA_LIVE_MESSAGE}-${rfId}`,
		"aria-live": "assertive",
		"aria-atomic": "true",
		style: ariaLiveStyle,
		children: ariaLiveMessage
	});
}
function A11yDescriptions({ rfId, disableKeyboardA11y }) {
	const ariaLabelConfig = useStore(ariaLabelConfigSelector);
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		(0, import_jsx_runtime.jsx)("div", {
			id: `${ARIA_NODE_DESC_KEY}-${rfId}`,
			style,
			children: disableKeyboardA11y ? ariaLabelConfig["node.a11yDescription.default"] : ariaLabelConfig["node.a11yDescription.keyboardDisabled"]
		}),
		(0, import_jsx_runtime.jsx)("div", {
			id: `${ARIA_EDGE_DESC_KEY}-${rfId}`,
			style,
			children: ariaLabelConfig["edge.a11yDescription.default"]
		}),
		!disableKeyboardA11y && (0, import_jsx_runtime.jsx)(AriaLiveMessage, { rfId })
	] });
}
/**
* The `<Panel />` component helps you position content above the viewport.
* It is used internally by the [`<MiniMap />`](/api-reference/components/minimap)
* and [`<Controls />`](/api-reference/components/controls) components.
*
* @public
*
* @example
* ```jsx
*import { ReactFlow, Background, Panel } from '@xyflow/react';
*
*export default function Flow() {
*  return (
*    <ReactFlow nodes={[]} fitView>
*      <Panel position="top-left">top-left</Panel>
*      <Panel position="top-center">top-center</Panel>
*      <Panel position="top-right">top-right</Panel>
*      <Panel position="bottom-left">bottom-left</Panel>
*      <Panel position="bottom-center">bottom-center</Panel>
*      <Panel position="bottom-right">bottom-right</Panel>
*    </ReactFlow>
*  );
*}
*```
*/
const Panel = forwardRef(({ position = "top-left", children, className, style, ...rest }, ref) => {
	return (0, import_jsx_runtime.jsx)("div", {
		className: cc([
			"react-flow__panel",
			className,
			...`${position}`.split("-")
		]),
		style,
		ref,
		...rest,
		children
	});
});
Panel.displayName = "Panel";
function Attribution({ proOptions, position = "bottom-right" }) {
	if (proOptions?.hideAttribution) return null;
	return (0, import_jsx_runtime.jsx)(Panel, {
		position,
		className: "react-flow__attribution",
		"data-message": "Please only hide this attribution when you are subscribed to React Flow Pro: https://pro.reactflow.dev",
		children: (0, import_jsx_runtime.jsx)("a", {
			href: "https://reactflow.dev",
			target: "_blank",
			rel: "noopener noreferrer",
			"aria-label": "React Flow attribution",
			children: "React Flow"
		})
	});
}
const selector$m = (s) => {
	const selectedNodes = [];
	const selectedEdges = [];
	for (const [, node] of s.nodeLookup) if (node.selected) selectedNodes.push(node.internals.userNode);
	for (const [, edge] of s.edgeLookup) if (edge.selected) selectedEdges.push(edge);
	return {
		selectedNodes,
		selectedEdges
	};
};
const selectId = (obj) => obj.id;
function areEqual(a, b) {
	return shallow$1(a.selectedNodes.map(selectId), b.selectedNodes.map(selectId)) && shallow$1(a.selectedEdges.map(selectId), b.selectedEdges.map(selectId));
}
function SelectionListenerInner({ onSelectionChange }) {
	const store = useStoreApi();
	const { selectedNodes, selectedEdges } = useStore(selector$m, areEqual);
	useEffect(() => {
		const params = {
			nodes: selectedNodes,
			edges: selectedEdges
		};
		onSelectionChange?.(params);
		store.getState().onSelectionChangeHandlers.forEach((fn) => fn(params));
	}, [
		selectedNodes,
		selectedEdges,
		onSelectionChange
	]);
	return null;
}
const changeSelector = (s) => !!s.onSelectionChangeHandlers;
function SelectionListener({ onSelectionChange }) {
	const storeHasSelectionChangeHandlers = useStore(changeSelector);
	if (onSelectionChange || storeHasSelectionChangeHandlers) return (0, import_jsx_runtime.jsx)(SelectionListenerInner, { onSelectionChange });
	return null;
}
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const defaultNodeOrigin = [0, 0];
const defaultViewport = {
	x: 0,
	y: 0,
	zoom: 1
};
const fieldsToTrack = [...[
	"nodes",
	"edges",
	"defaultNodes",
	"defaultEdges",
	"onConnect",
	"onConnectStart",
	"onConnectEnd",
	"onClickConnectStart",
	"onClickConnectEnd",
	"nodesDraggable",
	"autoPanOnNodeFocus",
	"nodesConnectable",
	"nodesFocusable",
	"edgesFocusable",
	"edgesReconnectable",
	"elevateNodesOnSelect",
	"elevateEdgesOnSelect",
	"minZoom",
	"maxZoom",
	"nodeExtent",
	"onNodesChange",
	"onEdgesChange",
	"elementsSelectable",
	"connectionMode",
	"snapGrid",
	"snapToGrid",
	"translateExtent",
	"connectOnClick",
	"defaultEdgeOptions",
	"fitView",
	"fitViewOptions",
	"onNodesDelete",
	"onEdgesDelete",
	"onDelete",
	"onNodeDrag",
	"onNodeDragStart",
	"onNodeDragStop",
	"onSelectionDrag",
	"onSelectionDragStart",
	"onSelectionDragStop",
	"onMoveStart",
	"onMove",
	"onMoveEnd",
	"noPanClassName",
	"nodeOrigin",
	"autoPanOnConnect",
	"autoPanOnNodeDrag",
	"onError",
	"connectionRadius",
	"isValidConnection",
	"selectNodesOnDrag",
	"nodeDragThreshold",
	"connectionDragThreshold",
	"onBeforeDelete",
	"debug",
	"autoPanSpeed",
	"ariaLabelConfig",
	"zIndexMode"
], "rfId"];
const selector$l = (s) => ({
	setNodes: s.setNodes,
	setEdges: s.setEdges,
	setMinZoom: s.setMinZoom,
	setMaxZoom: s.setMaxZoom,
	setTranslateExtent: s.setTranslateExtent,
	setNodeExtent: s.setNodeExtent,
	reset: s.reset,
	setDefaultNodesAndEdges: s.setDefaultNodesAndEdges
});
const initPrevValues = {
	translateExtent: infiniteExtent,
	nodeOrigin: defaultNodeOrigin,
	minZoom: .5,
	maxZoom: 2,
	elementsSelectable: true,
	noPanClassName: "nopan",
	rfId: "1"
};
function StoreUpdater(props) {
	const { setNodes, setEdges, setMinZoom, setMaxZoom, setTranslateExtent, setNodeExtent, reset, setDefaultNodesAndEdges } = useStore(selector$l, shallow$1);
	const store = useStoreApi();
	useIsomorphicLayoutEffect(() => {
		setDefaultNodesAndEdges(props.defaultNodes, props.defaultEdges);
		return () => {
			previousFields.current = initPrevValues;
			reset();
		};
	}, []);
	const previousFields = useRef(initPrevValues);
	useIsomorphicLayoutEffect(() => {
		for (const fieldName of fieldsToTrack) {
			const fieldValue = props[fieldName];
			if (fieldValue === previousFields.current[fieldName]) continue;
			if (typeof props[fieldName] === "undefined") continue;
			if (fieldName === "nodes") setNodes(fieldValue);
			else if (fieldName === "edges") setEdges(fieldValue);
			else if (fieldName === "minZoom") setMinZoom(fieldValue);
			else if (fieldName === "maxZoom") setMaxZoom(fieldValue);
			else if (fieldName === "translateExtent") setTranslateExtent(fieldValue);
			else if (fieldName === "nodeExtent") setNodeExtent(fieldValue);
			else if (fieldName === "ariaLabelConfig") store.setState({ ariaLabelConfig: mergeAriaLabelConfig(fieldValue) });
			else if (fieldName === "fitView") store.setState({ fitViewQueued: fieldValue });
			else if (fieldName === "fitViewOptions") store.setState({ fitViewOptions: fieldValue });
			else store.setState({ [fieldName]: fieldValue });
		}
		previousFields.current = props;
	}, fieldsToTrack.map((fieldName) => props[fieldName]));
	return null;
}
function getMediaQuery() {
	if (typeof window === "undefined" || !window.matchMedia) return null;
	return window.matchMedia("(prefers-color-scheme: dark)");
}
/**
* Hook for receiving the current color mode class 'dark' or 'light'.
*
* @internal
* @param colorMode - The color mode to use ('dark', 'light' or 'system')
*/
function useColorModeClass(colorMode) {
	const [colorModeClass, setColorModeClass] = useState(colorMode === "system" ? null : colorMode);
	useEffect(() => {
		if (colorMode !== "system") {
			setColorModeClass(colorMode);
			return;
		}
		const mediaQuery = getMediaQuery();
		const updateColorModeClass = () => setColorModeClass(mediaQuery?.matches ? "dark" : "light");
		updateColorModeClass();
		mediaQuery?.addEventListener("change", updateColorModeClass);
		return () => {
			mediaQuery?.removeEventListener("change", updateColorModeClass);
		};
	}, [colorMode]);
	return colorModeClass !== null ? colorModeClass : getMediaQuery()?.matches ? "dark" : "light";
}
const defaultDoc = typeof document !== "undefined" ? document : null;
/**
* This hook lets you listen for specific key codes and tells you whether they are
* currently pressed or not.
*
* @public
* @param options - Options
*
* @example
* ```tsx
*import { useKeyPress } from '@xyflow/react';
*
*export default function () {
*  const spacePressed = useKeyPress('Space');
*  const cmdAndSPressed = useKeyPress(['Meta+s', 'Strg+s']);
*
*  return (
*    <div>
*     {spacePressed && <p>Space pressed!</p>}
*     {cmdAndSPressed && <p>Cmd + S pressed!</p>}
*    </div>
*  );
*}
*```
*/
function useKeyPress(keyCode = null, options = {
	target: defaultDoc,
	actInsideInputWithModifier: true
}) {
	const [keyPressed, setKeyPressed] = useState(false);
	const modifierPressed = useRef(false);
	const pressedKeys = useRef(/* @__PURE__ */ new Set([]));
	const [keyCodes, keysToWatch] = useMemo(() => {
		if (keyCode !== null) {
			const keys = (Array.isArray(keyCode) ? keyCode : [keyCode]).filter((kc) => typeof kc === "string").map((kc) => kc.replace("+", "\n").replace("\n\n", "\n+").split("\n"));
			return [keys, keys.reduce((res, item) => res.concat(...item), [])];
		}
		return [[], []];
	}, [keyCode]);
	useEffect(() => {
		const target = options?.target ?? defaultDoc;
		const actInsideInputWithModifier = options?.actInsideInputWithModifier ?? true;
		if (keyCode !== null) {
			const downHandler = (event) => {
				modifierPressed.current = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
				if ((!modifierPressed.current || modifierPressed.current && !actInsideInputWithModifier) && isInputDOMNode(event)) return false;
				const keyOrCode = useKeyOrCode(event.code, keysToWatch);
				pressedKeys.current.add(event[keyOrCode]);
				if (isMatchingKey(keyCodes, pressedKeys.current, false)) {
					const target = event.composedPath?.()?.[0] || event.target;
					const isInteractiveElement = target?.nodeName === "BUTTON" || target?.nodeName === "A";
					if (options.preventDefault !== false && (modifierPressed.current || !isInteractiveElement)) event.preventDefault();
					setKeyPressed(true);
				}
			};
			const upHandler = (event) => {
				const keyOrCode = useKeyOrCode(event.code, keysToWatch);
				if (isMatchingKey(keyCodes, pressedKeys.current, true)) {
					setKeyPressed(false);
					pressedKeys.current.clear();
				} else pressedKeys.current.delete(event[keyOrCode]);
				if (event.key === "Meta") pressedKeys.current.clear();
				modifierPressed.current = false;
			};
			const resetHandler = () => {
				pressedKeys.current.clear();
				setKeyPressed(false);
			};
			target?.addEventListener("keydown", downHandler);
			target?.addEventListener("keyup", upHandler);
			window.addEventListener("blur", resetHandler);
			window.addEventListener("contextmenu", resetHandler);
			return () => {
				target?.removeEventListener("keydown", downHandler);
				target?.removeEventListener("keyup", upHandler);
				window.removeEventListener("blur", resetHandler);
				window.removeEventListener("contextmenu", resetHandler);
			};
		}
	}, [keyCode, setKeyPressed]);
	return keyPressed;
}
function isMatchingKey(keyCodes, pressedKeys, isUp) {
	return keyCodes.filter((keys) => isUp || keys.length === pressedKeys.size).some((keys) => keys.every((k) => pressedKeys.has(k)));
}
function useKeyOrCode(eventCode, keysToWatch) {
	return keysToWatch.includes(eventCode) ? "code" : "key";
}
/**
* Hook for getting viewport helper functions.
*
* @internal
* @returns viewport helper functions
*/
const useViewportHelper = () => {
	const store = useStoreApi();
	return useMemo(() => {
		return {
			zoomIn: (options) => {
				const { panZoom } = store.getState();
				return panZoom ? panZoom.scaleBy(1.2, options) : Promise.resolve(false);
			},
			zoomOut: (options) => {
				const { panZoom } = store.getState();
				return panZoom ? panZoom.scaleBy(1 / 1.2, options) : Promise.resolve(false);
			},
			zoomTo: (zoomLevel, options) => {
				const { panZoom } = store.getState();
				return panZoom ? panZoom.scaleTo(zoomLevel, options) : Promise.resolve(false);
			},
			getZoom: () => store.getState().transform[2],
			setViewport: async (viewport, options) => {
				const { transform: [tX, tY, tZoom], panZoom } = store.getState();
				if (!panZoom) return Promise.resolve(false);
				await panZoom.setViewport({
					x: viewport.x ?? tX,
					y: viewport.y ?? tY,
					zoom: viewport.zoom ?? tZoom
				}, options);
				return Promise.resolve(true);
			},
			getViewport: () => {
				const [x, y, zoom] = store.getState().transform;
				return {
					x,
					y,
					zoom
				};
			},
			setCenter: async (x, y, options) => {
				return store.getState().setCenter(x, y, options);
			},
			fitBounds: async (bounds, options) => {
				const { width, height, minZoom, maxZoom, panZoom } = store.getState();
				const viewport = getViewportForBounds(bounds, width, height, minZoom, maxZoom, options?.padding ?? .1);
				if (!panZoom) return Promise.resolve(false);
				await panZoom.setViewport(viewport, {
					duration: options?.duration,
					ease: options?.ease,
					interpolate: options?.interpolate
				});
				return Promise.resolve(true);
			},
			screenToFlowPosition: (clientPosition, options = {}) => {
				const { transform, snapGrid, snapToGrid, domNode } = store.getState();
				if (!domNode) return clientPosition;
				const { x: domX, y: domY } = domNode.getBoundingClientRect();
				const correctedPosition = {
					x: clientPosition.x - domX,
					y: clientPosition.y - domY
				};
				const _snapGrid = options.snapGrid ?? snapGrid;
				return pointToRendererPoint(correctedPosition, transform, options.snapToGrid ?? snapToGrid, _snapGrid);
			},
			flowToScreenPosition: (flowPosition) => {
				const { transform, domNode } = store.getState();
				if (!domNode) return flowPosition;
				const { x: domX, y: domY } = domNode.getBoundingClientRect();
				const rendererPosition = rendererPointToPoint(flowPosition, transform);
				return {
					x: rendererPosition.x + domX,
					y: rendererPosition.y + domY
				};
			}
		};
	}, []);
};
function applyChanges(changes, elements) {
	const updatedElements = [];
	const changesMap = /* @__PURE__ */ new Map();
	const addItemChanges = [];
	for (const change of changes) if (change.type === "add") {
		addItemChanges.push(change);
		continue;
	} else if (change.type === "remove" || change.type === "replace") changesMap.set(change.id, [change]);
	else {
		const elementChanges = changesMap.get(change.id);
		if (elementChanges) elementChanges.push(change);
		else changesMap.set(change.id, [change]);
	}
	for (const element of elements) {
		const changes = changesMap.get(element.id);
		if (!changes) {
			updatedElements.push(element);
			continue;
		}
		if (changes[0].type === "remove") continue;
		if (changes[0].type === "replace") {
			updatedElements.push({ ...changes[0].item });
			continue;
		}
		/**
		* For other types of changes, we want to start with a shallow copy of the
		* object so React knows this element has changed. Sequential changes will
		* each _mutate_ this object, so there's only ever one copy.
		*/
		const updatedElement = { ...element };
		for (const change of changes) applyChange(change, updatedElement);
		updatedElements.push(updatedElement);
	}
	if (addItemChanges.length) addItemChanges.forEach((change) => {
		if (change.index !== void 0) updatedElements.splice(change.index, 0, { ...change.item });
		else updatedElements.push({ ...change.item });
	});
	return updatedElements;
}
function applyChange(change, element) {
	switch (change.type) {
		case "select":
			element.selected = change.selected;
			break;
		case "position":
			if (typeof change.position !== "undefined") element.position = change.position;
			if (typeof change.dragging !== "undefined") element.dragging = change.dragging;
			break;
		case "dimensions":
			if (typeof change.dimensions !== "undefined") {
				element.measured = { ...change.dimensions };
				if (change.setAttributes) {
					if (change.setAttributes === true || change.setAttributes === "width") element.width = change.dimensions.width;
					if (change.setAttributes === true || change.setAttributes === "height") element.height = change.dimensions.height;
				}
			}
			if (typeof change.resizing === "boolean") element.resizing = change.resizing;
			break;
	}
}
/**
* Drop in function that applies node changes to an array of nodes.
* @public
* @param changes - Array of changes to apply.
* @param nodes - Array of nodes to apply the changes to.
* @returns Array of updated nodes.
* @example
*```tsx
*import { useState, useCallback } from 'react';
*import { ReactFlow, applyNodeChanges, type Node, type Edge, type OnNodesChange } from '@xyflow/react';
*
*export default function Flow() {
*  const [nodes, setNodes] = useState<Node[]>([]);
*  const [edges, setEdges] = useState<Edge[]>([]);
*  const onNodesChange: OnNodesChange = useCallback(
*    (changes) => {
*      setNodes((oldNodes) => applyNodeChanges(changes, oldNodes));
*    },
*    [setNodes],
*  );
*
*  return (
*    <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} />
*  );
*}
*```
* @remarks Various events on the <ReactFlow /> component can produce an {@link NodeChange}
* that describes how to update the edges of your flow in some way.
* If you don't need any custom behaviour, this util can be used to take an array
* of these changes and apply them to your edges.
*/
function applyNodeChanges(changes, nodes) {
	return applyChanges(changes, nodes);
}
/**
* Drop in function that applies edge changes to an array of edges.
* @public
* @param changes - Array of changes to apply.
* @param edges - Array of edge to apply the changes to.
* @returns Array of updated edges.
* @example
* ```tsx
*import { useState, useCallback } from 'react';
*import { ReactFlow, applyEdgeChanges } from '@xyflow/react';
*
*export default function Flow() {
*  const [nodes, setNodes] = useState([]);
*  const [edges, setEdges] = useState([]);
*  const onEdgesChange = useCallback(
*    (changes) => {
*      setEdges((oldEdges) => applyEdgeChanges(changes, oldEdges));
*    },
*    [setEdges],
*  );
*
*  return (
*    <ReactFlow nodes={nodes} edges={edges} onEdgesChange={onEdgesChange} />
*  );
*}
*```
* @remarks Various events on the <ReactFlow /> component can produce an {@link EdgeChange}
* that describes how to update the edges of your flow in some way.
* If you don't need any custom behaviour, this util can be used to take an array
* of these changes and apply them to your edges.
*/
function applyEdgeChanges(changes, edges) {
	return applyChanges(changes, edges);
}
function createSelectionChange(id, selected) {
	return {
		id,
		type: "select",
		selected
	};
}
function getSelectionChanges(items, selectedIds = /* @__PURE__ */ new Set(), mutateItem = false) {
	const changes = [];
	for (const [id, item] of items) {
		const willBeSelected = selectedIds.has(id);
		if (!(item.selected === void 0 && !willBeSelected) && item.selected !== willBeSelected) {
			if (mutateItem) item.selected = willBeSelected;
			changes.push(createSelectionChange(item.id, willBeSelected));
		}
	}
	return changes;
}
function getElementsDiffChanges({ items = [], lookup }) {
	const changes = [];
	const itemsLookup = new Map(items.map((item) => [item.id, item]));
	for (const [index, item] of items.entries()) {
		const lookupItem = lookup.get(item.id);
		const storeItem = lookupItem?.internals?.userNode ?? lookupItem;
		if (storeItem !== void 0 && storeItem !== item) changes.push({
			id: item.id,
			item,
			type: "replace"
		});
		if (storeItem === void 0) changes.push({
			item,
			type: "add",
			index
		});
	}
	for (const [id] of lookup) if (itemsLookup.get(id) === void 0) changes.push({
		id,
		type: "remove"
	});
	return changes;
}
function elementToRemoveChange(item) {
	return {
		id: item.id,
		type: "remove"
	};
}
/**
* Test whether an object is usable as an [`Node`](/api-reference/types/node).
* In TypeScript this is a type guard that will narrow the type of whatever you pass in to
* [`Node`](/api-reference/types/node) if it returns `true`.
*
* @public
* @remarks In TypeScript this is a type guard that will narrow the type of whatever you pass in to Node if it returns true
* @param element - The element to test.
* @returns Tests whether the provided value can be used as a `Node`. If you're using TypeScript,
* this function acts as a type guard and will narrow the type of the value to `Node` if it returns
* `true`.
*
* @example
* ```js
*import { isNode } from '@xyflow/react';
*
*if (isNode(node)) {
* // ...
*}
*```
*/
const isNode = (element) => isNodeBase(element);
/**
* Test whether an object is usable as an [`Edge`](/api-reference/types/edge).
* In TypeScript this is a type guard that will narrow the type of whatever you pass in to
* [`Edge`](/api-reference/types/edge) if it returns `true`.
*
* @public
* @remarks In TypeScript this is a type guard that will narrow the type of whatever you pass in to Edge if it returns true
* @param element - The element to test
* @returns Tests whether the provided value can be used as an `Edge`. If you're using TypeScript,
* this function acts as a type guard and will narrow the type of the value to `Edge` if it returns
* `true`.
*
* @example
* ```js
*import { isEdge } from '@xyflow/react';
*
*if (isEdge(edge)) {
* // ...
*}
*```
*/
const isEdge = (element) => isEdgeBase(element);
function fixedForwardRef(render) {
	return forwardRef(render);
}
/**
* This hook returns a queue that can be used to batch updates.
*
* @param runQueue - a function that gets called when the queue is flushed
* @internal
*
* @returns a Queue object
*/
function useQueue(runQueue) {
	const [serial, setSerial] = useState(BigInt(0));
	const [queue] = useState(() => createQueue(() => setSerial((n) => n + BigInt(1))));
	useIsomorphicLayoutEffect(() => {
		const queueItems = queue.get();
		if (queueItems.length) {
			runQueue(queueItems);
			queue.reset();
		}
	}, [serial]);
	return queue;
}
function createQueue(cb) {
	let queue = [];
	return {
		get: () => queue,
		reset: () => {
			queue = [];
		},
		push: (item) => {
			queue.push(item);
			cb();
		}
	};
}
const BatchContext = createContext(null);
/**
* This is a context provider that holds and processes the node and edge update queues
* that are needed to handle setNodes, addNodes, setEdges and addEdges.
*
* @internal
*/
function BatchProvider({ children }) {
	const store = useStoreApi();
	const nodeQueue = useQueue(useCallback((queueItems) => {
		const { nodes = [], setNodes, hasDefaultNodes, onNodesChange, nodeLookup, fitViewQueued, onNodesChangeMiddlewareMap } = store.getState();
		let next = nodes;
		for (const payload of queueItems) next = typeof payload === "function" ? payload(next) : payload;
		let changes = getElementsDiffChanges({
			items: next,
			lookup: nodeLookup
		});
		for (const middleware of onNodesChangeMiddlewareMap.values()) changes = middleware(changes);
		if (hasDefaultNodes) setNodes(next);
		if (changes.length > 0) onNodesChange?.(changes);
		else if (fitViewQueued) window.requestAnimationFrame(() => {
			const { fitViewQueued, nodes, setNodes } = store.getState();
			if (fitViewQueued) setNodes(nodes);
		});
	}, []));
	const edgeQueue = useQueue(useCallback((queueItems) => {
		const { edges = [], setEdges, hasDefaultEdges, onEdgesChange, edgeLookup } = store.getState();
		let next = edges;
		for (const payload of queueItems) next = typeof payload === "function" ? payload(next) : payload;
		if (hasDefaultEdges) setEdges(next);
		else if (onEdgesChange) onEdgesChange(getElementsDiffChanges({
			items: next,
			lookup: edgeLookup
		}));
	}, []));
	const value = useMemo(() => ({
		nodeQueue,
		edgeQueue
	}), []);
	return (0, import_jsx_runtime.jsx)(BatchContext.Provider, {
		value,
		children
	});
}
function useBatchContext() {
	const batchContext = useContext(BatchContext);
	if (!batchContext) throw new Error("useBatchContext must be used within a BatchProvider");
	return batchContext;
}
const selector$k = (s) => !!s.panZoom;
/**
* This hook returns a ReactFlowInstance that can be used to update nodes and edges, manipulate the viewport, or query the current state of the flow.
*
* @public
* @example
* ```jsx
*import { useCallback, useState } from 'react';
*import { useReactFlow } from '@xyflow/react';
*
*export function NodeCounter() {
*  const reactFlow = useReactFlow();
*  const [count, setCount] = useState(0);
*  const countNodes = useCallback(() => {
*    setCount(reactFlow.getNodes().length);
*    // you need to pass it as a dependency if you are using it with useEffect or useCallback
*    // because at the first render, it's not initialized yet and some functions might not work.
*  }, [reactFlow]);
*
*  return (
*    <div>
*      <button onClick={countNodes}>Update count</button>
*      <p>There are {count} nodes in the flow.</p>
*    </div>
*  );
*}
*```
*/
function useReactFlow() {
	const viewportHelper = useViewportHelper();
	const store = useStoreApi();
	const batchContext = useBatchContext();
	const viewportInitialized = useStore(selector$k);
	const generalHelper = useMemo(() => {
		const getInternalNode = (id) => store.getState().nodeLookup.get(id);
		const setNodes = (payload) => {
			batchContext.nodeQueue.push(payload);
		};
		const setEdges = (payload) => {
			batchContext.edgeQueue.push(payload);
		};
		const getNodeRect = (node) => {
			const { nodeLookup, nodeOrigin } = store.getState();
			const nodeToUse = isNode(node) ? node : nodeLookup.get(node.id);
			const position = nodeToUse.parentId ? evaluateAbsolutePosition(nodeToUse.position, nodeToUse.measured, nodeToUse.parentId, nodeLookup, nodeOrigin) : nodeToUse.position;
			return nodeToRect({
				...nodeToUse,
				position,
				width: nodeToUse.measured?.width ?? nodeToUse.width,
				height: nodeToUse.measured?.height ?? nodeToUse.height
			});
		};
		const updateNode = (id, nodeUpdate, options = { replace: false }) => {
			setNodes((prevNodes) => prevNodes.map((node) => {
				if (node.id === id) {
					const nextNode = typeof nodeUpdate === "function" ? nodeUpdate(node) : nodeUpdate;
					return options.replace && isNode(nextNode) ? nextNode : {
						...node,
						...nextNode
					};
				}
				return node;
			}));
		};
		const updateEdge = (id, edgeUpdate, options = { replace: false }) => {
			setEdges((prevEdges) => prevEdges.map((edge) => {
				if (edge.id === id) {
					const nextEdge = typeof edgeUpdate === "function" ? edgeUpdate(edge) : edgeUpdate;
					return options.replace && isEdge(nextEdge) ? nextEdge : {
						...edge,
						...nextEdge
					};
				}
				return edge;
			}));
		};
		return {
			getNodes: () => store.getState().nodes.map((n) => ({ ...n })),
			getNode: (id) => getInternalNode(id)?.internals.userNode,
			getInternalNode,
			getEdges: () => {
				const { edges = [] } = store.getState();
				return edges.map((e) => ({ ...e }));
			},
			getEdge: (id) => store.getState().edgeLookup.get(id),
			setNodes,
			setEdges,
			addNodes: (payload) => {
				const newNodes = Array.isArray(payload) ? payload : [payload];
				batchContext.nodeQueue.push((nodes) => [...nodes, ...newNodes]);
			},
			addEdges: (payload) => {
				const newEdges = Array.isArray(payload) ? payload : [payload];
				batchContext.edgeQueue.push((edges) => [...edges, ...newEdges]);
			},
			toObject: () => {
				const { nodes = [], edges = [], transform } = store.getState();
				const [x, y, zoom] = transform;
				return {
					nodes: nodes.map((n) => ({ ...n })),
					edges: edges.map((e) => ({ ...e })),
					viewport: {
						x,
						y,
						zoom
					}
				};
			},
			deleteElements: async ({ nodes: nodesToRemove = [], edges: edgesToRemove = [] }) => {
				const { nodes, edges, onNodesDelete, onEdgesDelete, triggerNodeChanges, triggerEdgeChanges, onDelete, onBeforeDelete } = store.getState();
				const { nodes: matchingNodes, edges: matchingEdges } = await getElementsToRemove({
					nodesToRemove,
					edgesToRemove,
					nodes,
					edges,
					onBeforeDelete
				});
				const hasMatchingEdges = matchingEdges.length > 0;
				const hasMatchingNodes = matchingNodes.length > 0;
				if (hasMatchingEdges) {
					const edgeChanges = matchingEdges.map(elementToRemoveChange);
					onEdgesDelete?.(matchingEdges);
					triggerEdgeChanges(edgeChanges);
				}
				if (hasMatchingNodes) {
					const nodeChanges = matchingNodes.map(elementToRemoveChange);
					onNodesDelete?.(matchingNodes);
					triggerNodeChanges(nodeChanges);
				}
				if (hasMatchingNodes || hasMatchingEdges) onDelete?.({
					nodes: matchingNodes,
					edges: matchingEdges
				});
				return {
					deletedNodes: matchingNodes,
					deletedEdges: matchingEdges
				};
			},
			getIntersectingNodes: (nodeOrRect, partially = true, nodes) => {
				const isRect = isRectObject(nodeOrRect);
				const nodeRect = isRect ? nodeOrRect : getNodeRect(nodeOrRect);
				const hasNodesOption = nodes !== void 0;
				if (!nodeRect) return [];
				return (nodes || store.getState().nodes).filter((n) => {
					const internalNode = store.getState().nodeLookup.get(n.id);
					if (internalNode && !isRect && (n.id === nodeOrRect.id || !internalNode.internals.positionAbsolute)) return false;
					const currNodeRect = nodeToRect(hasNodesOption ? n : internalNode);
					const overlappingArea = getOverlappingArea(currNodeRect, nodeRect);
					return partially && overlappingArea > 0 || overlappingArea >= currNodeRect.width * currNodeRect.height || overlappingArea >= nodeRect.width * nodeRect.height;
				});
			},
			isNodeIntersecting: (nodeOrRect, area, partially = true) => {
				const nodeRect = isRectObject(nodeOrRect) ? nodeOrRect : getNodeRect(nodeOrRect);
				if (!nodeRect) return false;
				const overlappingArea = getOverlappingArea(nodeRect, area);
				return partially && overlappingArea > 0 || overlappingArea >= area.width * area.height || overlappingArea >= nodeRect.width * nodeRect.height;
			},
			updateNode,
			updateNodeData: (id, dataUpdate, options = { replace: false }) => {
				updateNode(id, (node) => {
					const nextData = typeof dataUpdate === "function" ? dataUpdate(node) : dataUpdate;
					return options.replace ? {
						...node,
						data: nextData
					} : {
						...node,
						data: {
							...node.data,
							...nextData
						}
					};
				}, options);
			},
			updateEdge,
			updateEdgeData: (id, dataUpdate, options = { replace: false }) => {
				updateEdge(id, (edge) => {
					const nextData = typeof dataUpdate === "function" ? dataUpdate(edge) : dataUpdate;
					return options.replace ? {
						...edge,
						data: nextData
					} : {
						...edge,
						data: {
							...edge.data,
							...nextData
						}
					};
				}, options);
			},
			getNodesBounds: (nodes) => {
				const { nodeLookup, nodeOrigin } = store.getState();
				return getNodesBounds(nodes, {
					nodeLookup,
					nodeOrigin
				});
			},
			getHandleConnections: ({ type, id, nodeId }) => Array.from(store.getState().connectionLookup.get(`${nodeId}-${type}${id ? `-${id}` : ""}`)?.values() ?? []),
			getNodeConnections: ({ type, handleId, nodeId }) => Array.from(store.getState().connectionLookup.get(`${nodeId}${type ? handleId ? `-${type}-${handleId}` : `-${type}` : ""}`)?.values() ?? []),
			fitView: async (options) => {
				const fitViewResolver = store.getState().fitViewResolver ?? withResolvers();
				store.setState({
					fitViewQueued: true,
					fitViewOptions: options,
					fitViewResolver
				});
				batchContext.nodeQueue.push((nodes) => [...nodes]);
				return fitViewResolver.promise;
			}
		};
	}, []);
	return useMemo(() => {
		return {
			...generalHelper,
			...viewportHelper,
			viewportInitialized
		};
	}, [viewportInitialized]);
}
const selected = (item) => item.selected;
const win$1 = typeof window !== "undefined" ? window : void 0;
/**
* Hook for handling global key events.
*
* @internal
*/
function useGlobalKeyHandler({ deleteKeyCode, multiSelectionKeyCode }) {
	const store = useStoreApi();
	const { deleteElements } = useReactFlow();
	const deleteKeyPressed = useKeyPress(deleteKeyCode, { actInsideInputWithModifier: false });
	const multiSelectionKeyPressed = useKeyPress(multiSelectionKeyCode, { target: win$1 });
	useEffect(() => {
		if (deleteKeyPressed) {
			const { edges, nodes } = store.getState();
			deleteElements({
				nodes: nodes.filter(selected),
				edges: edges.filter(selected)
			});
			store.setState({ nodesSelectionActive: false });
		}
	}, [deleteKeyPressed]);
	useEffect(() => {
		store.setState({ multiSelectionActive: multiSelectionKeyPressed });
	}, [multiSelectionKeyPressed]);
}
/**
* Hook for handling resize events.
*
* @internal
*/
function useResizeHandler(domNode) {
	const store = useStoreApi();
	useEffect(() => {
		const updateDimensions = () => {
			if (!domNode.current || !(domNode.current.checkVisibility?.() ?? true)) return false;
			const size = getDimensions(domNode.current);
			if (size.height === 0 || size.width === 0) store.getState().onError?.("004", errorMessages["error004"]());
			store.setState({
				width: size.width || 500,
				height: size.height || 500
			});
		};
		if (domNode.current) {
			updateDimensions();
			window.addEventListener("resize", updateDimensions);
			const resizeObserver = new ResizeObserver(() => updateDimensions());
			resizeObserver.observe(domNode.current);
			return () => {
				window.removeEventListener("resize", updateDimensions);
				if (resizeObserver && domNode.current) resizeObserver.unobserve(domNode.current);
			};
		}
	}, []);
}
const containerStyle = {
	position: "absolute",
	width: "100%",
	height: "100%",
	top: 0,
	left: 0
};
const selector$j = (s) => ({
	userSelectionActive: s.userSelectionActive,
	lib: s.lib,
	connectionInProgress: s.connection.inProgress
});
function ZoomPane({ onPaneContextMenu, zoomOnScroll = true, zoomOnPinch = true, panOnScroll = false, panOnScrollSpeed = .5, panOnScrollMode = PanOnScrollMode.Free, zoomOnDoubleClick = true, panOnDrag = true, defaultViewport, translateExtent, minZoom, maxZoom, zoomActivationKeyCode, preventScrolling = true, children, noWheelClassName, noPanClassName, onViewportChange, isControlledViewport, paneClickDistance, selectionOnDrag }) {
	const store = useStoreApi();
	const zoomPane = useRef(null);
	const { userSelectionActive, lib, connectionInProgress } = useStore(selector$j, shallow$1);
	const zoomActivationKeyPressed = useKeyPress(zoomActivationKeyCode);
	const panZoom = useRef();
	useResizeHandler(zoomPane);
	const onTransformChange = useCallback((transform) => {
		onViewportChange?.({
			x: transform[0],
			y: transform[1],
			zoom: transform[2]
		});
		if (!isControlledViewport) store.setState({ transform });
	}, [onViewportChange, isControlledViewport]);
	useEffect(() => {
		if (zoomPane.current) {
			panZoom.current = XYPanZoom({
				domNode: zoomPane.current,
				minZoom,
				maxZoom,
				translateExtent,
				viewport: defaultViewport,
				onDraggingChange: (paneDragging) => store.setState((prevState) => prevState.paneDragging === paneDragging ? prevState : { paneDragging }),
				onPanZoomStart: (event, vp) => {
					const { onViewportChangeStart, onMoveStart } = store.getState();
					onMoveStart?.(event, vp);
					onViewportChangeStart?.(vp);
				},
				onPanZoom: (event, vp) => {
					const { onViewportChange, onMove } = store.getState();
					onMove?.(event, vp);
					onViewportChange?.(vp);
				},
				onPanZoomEnd: (event, vp) => {
					const { onViewportChangeEnd, onMoveEnd } = store.getState();
					onMoveEnd?.(event, vp);
					onViewportChangeEnd?.(vp);
				}
			});
			const { x, y, zoom } = panZoom.current.getViewport();
			store.setState({
				panZoom: panZoom.current,
				transform: [
					x,
					y,
					zoom
				],
				domNode: zoomPane.current.closest(".react-flow")
			});
			return () => {
				panZoom.current?.destroy();
			};
		}
	}, []);
	useEffect(() => {
		panZoom.current?.update({
			onPaneContextMenu,
			zoomOnScroll,
			zoomOnPinch,
			panOnScroll,
			panOnScrollSpeed,
			panOnScrollMode,
			zoomOnDoubleClick,
			panOnDrag,
			zoomActivationKeyPressed,
			preventScrolling,
			noPanClassName,
			userSelectionActive,
			noWheelClassName,
			lib,
			onTransformChange,
			connectionInProgress,
			selectionOnDrag,
			paneClickDistance
		});
	}, [
		onPaneContextMenu,
		zoomOnScroll,
		zoomOnPinch,
		panOnScroll,
		panOnScrollSpeed,
		panOnScrollMode,
		zoomOnDoubleClick,
		panOnDrag,
		zoomActivationKeyPressed,
		preventScrolling,
		noPanClassName,
		userSelectionActive,
		noWheelClassName,
		lib,
		onTransformChange,
		connectionInProgress,
		selectionOnDrag,
		paneClickDistance
	]);
	return (0, import_jsx_runtime.jsx)("div", {
		className: "react-flow__renderer",
		ref: zoomPane,
		style: containerStyle,
		children
	});
}
const selector$i = (s) => ({
	userSelectionActive: s.userSelectionActive,
	userSelectionRect: s.userSelectionRect
});
function UserSelection() {
	const { userSelectionActive, userSelectionRect } = useStore(selector$i, shallow$1);
	if (!(userSelectionActive && userSelectionRect)) return null;
	return (0, import_jsx_runtime.jsx)("div", {
		className: "react-flow__selection react-flow__container",
		style: {
			width: userSelectionRect.width,
			height: userSelectionRect.height,
			transform: `translate(${userSelectionRect.x}px, ${userSelectionRect.y}px)`
		}
	});
}
const wrapHandler = (handler, containerRef) => {
	return (event) => {
		if (event.target !== containerRef.current) return;
		handler?.(event);
	};
};
const selector$h = (s) => ({
	userSelectionActive: s.userSelectionActive,
	elementsSelectable: s.elementsSelectable,
	connectionInProgress: s.connection.inProgress,
	dragging: s.paneDragging
});
function Pane({ isSelecting, selectionKeyPressed, selectionMode = SelectionMode.Full, panOnDrag, paneClickDistance, selectionOnDrag, onSelectionStart, onSelectionEnd, onPaneClick, onPaneContextMenu, onPaneScroll, onPaneMouseEnter, onPaneMouseMove, onPaneMouseLeave, children }) {
	const store = useStoreApi();
	const { userSelectionActive, elementsSelectable, dragging, connectionInProgress } = useStore(selector$h, shallow$1);
	const isSelectionEnabled = elementsSelectable && (isSelecting || userSelectionActive);
	const container = useRef(null);
	const containerBounds = useRef();
	const selectedNodeIds = useRef(/* @__PURE__ */ new Set());
	const selectedEdgeIds = useRef(/* @__PURE__ */ new Set());
	const selectionInProgress = useRef(false);
	const onClick = (event) => {
		if (selectionInProgress.current || connectionInProgress) {
			selectionInProgress.current = false;
			return;
		}
		onPaneClick?.(event);
		store.getState().resetSelectedElements();
		store.setState({ nodesSelectionActive: false });
	};
	const onContextMenu = (event) => {
		if (Array.isArray(panOnDrag) && panOnDrag?.includes(2)) {
			event.preventDefault();
			return;
		}
		onPaneContextMenu?.(event);
	};
	const onWheel = onPaneScroll ? (event) => onPaneScroll(event) : void 0;
	const onClickCapture = (event) => {
		if (selectionInProgress.current) {
			event.stopPropagation();
			selectionInProgress.current = false;
		}
	};
	const onPointerDownCapture = (event) => {
		const { domNode } = store.getState();
		containerBounds.current = domNode?.getBoundingClientRect();
		if (!containerBounds.current) return;
		const eventTargetIsContainer = event.target === container.current;
		if (!eventTargetIsContainer && !!event.target.closest(".nokey") || !isSelecting || !(selectionOnDrag && eventTargetIsContainer || selectionKeyPressed) || event.button !== 0 || !event.isPrimary) return;
		event.target?.setPointerCapture?.(event.pointerId);
		selectionInProgress.current = false;
		const { x, y } = getEventPosition(event.nativeEvent, containerBounds.current);
		store.setState({ userSelectionRect: {
			width: 0,
			height: 0,
			startX: x,
			startY: y,
			x,
			y
		} });
		if (!eventTargetIsContainer) {
			event.stopPropagation();
			event.preventDefault();
		}
	};
	const onPointerMove = (event) => {
		const { userSelectionRect, transform, nodeLookup, edgeLookup, connectionLookup, triggerNodeChanges, triggerEdgeChanges, defaultEdgeOptions, resetSelectedElements } = store.getState();
		if (!containerBounds.current || !userSelectionRect) return;
		const { x: mouseX, y: mouseY } = getEventPosition(event.nativeEvent, containerBounds.current);
		const { startX, startY } = userSelectionRect;
		if (!selectionInProgress.current) {
			const requiredDistance = selectionKeyPressed ? 0 : paneClickDistance;
			if (Math.hypot(mouseX - startX, mouseY - startY) <= requiredDistance) return;
			resetSelectedElements();
			onSelectionStart?.(event);
		}
		selectionInProgress.current = true;
		const nextUserSelectRect = {
			startX,
			startY,
			x: mouseX < startX ? mouseX : startX,
			y: mouseY < startY ? mouseY : startY,
			width: Math.abs(mouseX - startX),
			height: Math.abs(mouseY - startY)
		};
		const prevSelectedNodeIds = selectedNodeIds.current;
		const prevSelectedEdgeIds = selectedEdgeIds.current;
		selectedNodeIds.current = new Set(getNodesInside(nodeLookup, nextUserSelectRect, transform, selectionMode === SelectionMode.Partial, true).map((node) => node.id));
		selectedEdgeIds.current = /* @__PURE__ */ new Set();
		const edgesSelectable = defaultEdgeOptions?.selectable ?? true;
		for (const nodeId of selectedNodeIds.current) {
			const connections = connectionLookup.get(nodeId);
			if (!connections) continue;
			for (const { edgeId } of connections.values()) {
				const edge = edgeLookup.get(edgeId);
				if (edge && (edge.selectable ?? edgesSelectable)) selectedEdgeIds.current.add(edgeId);
			}
		}
		if (!areSetsEqual(prevSelectedNodeIds, selectedNodeIds.current)) triggerNodeChanges(getSelectionChanges(nodeLookup, selectedNodeIds.current, true));
		if (!areSetsEqual(prevSelectedEdgeIds, selectedEdgeIds.current)) triggerEdgeChanges(getSelectionChanges(edgeLookup, selectedEdgeIds.current));
		store.setState({
			userSelectionRect: nextUserSelectRect,
			userSelectionActive: true,
			nodesSelectionActive: false
		});
	};
	const onPointerUp = (event) => {
		if (event.button !== 0) return;
		event.target?.releasePointerCapture?.(event.pointerId);
		if (!userSelectionActive && event.target === container.current && store.getState().userSelectionRect) onClick?.(event);
		store.setState({
			userSelectionActive: false,
			userSelectionRect: null
		});
		if (selectionInProgress.current) {
			onSelectionEnd?.(event);
			store.setState({ nodesSelectionActive: selectedNodeIds.current.size > 0 });
		}
	};
	return (0, import_jsx_runtime.jsxs)("div", {
		className: cc(["react-flow__pane", {
			draggable: panOnDrag === true || Array.isArray(panOnDrag) && panOnDrag.includes(0),
			dragging,
			selection: isSelecting
		}]),
		onClick: isSelectionEnabled ? void 0 : wrapHandler(onClick, container),
		onContextMenu: wrapHandler(onContextMenu, container),
		onWheel: wrapHandler(onWheel, container),
		onPointerEnter: isSelectionEnabled ? void 0 : onPaneMouseEnter,
		onPointerMove: isSelectionEnabled ? onPointerMove : onPaneMouseMove,
		onPointerUp: isSelectionEnabled ? onPointerUp : void 0,
		onPointerDownCapture: isSelectionEnabled ? onPointerDownCapture : void 0,
		onClickCapture: isSelectionEnabled ? onClickCapture : void 0,
		onPointerLeave: onPaneMouseLeave,
		ref: container,
		style: containerStyle,
		children: [children, (0, import_jsx_runtime.jsx)(UserSelection, {})]
	});
}
function handleNodeClick({ id, store, unselect = false, nodeRef }) {
	const { addSelectedNodes, unselectNodesAndEdges, multiSelectionActive, nodeLookup, onError } = store.getState();
	const node = nodeLookup.get(id);
	if (!node) {
		onError?.("012", errorMessages["error012"](id));
		return;
	}
	store.setState({ nodesSelectionActive: false });
	if (!node.selected) addSelectedNodes([id]);
	else if (unselect || node.selected && multiSelectionActive) {
		unselectNodesAndEdges({
			nodes: [node],
			edges: []
		});
		requestAnimationFrame(() => nodeRef?.current?.blur());
	}
}
/**
* Hook for calling XYDrag helper from @xyflow/system.
*
* @internal
*/
function useDrag({ nodeRef, disabled = false, noDragClassName, handleSelector, nodeId, isSelectable, nodeClickDistance }) {
	const store = useStoreApi();
	const [dragging, setDragging] = useState(false);
	const xyDrag = useRef();
	useEffect(() => {
		xyDrag.current = XYDrag({
			getStoreItems: () => store.getState(),
			onNodeMouseDown: (id) => {
				handleNodeClick({
					id,
					store,
					nodeRef
				});
			},
			onDragStart: () => {
				setDragging(true);
			},
			onDragStop: () => {
				setDragging(false);
			}
		});
	}, []);
	useEffect(() => {
		if (disabled || !nodeRef.current || !xyDrag.current) return;
		xyDrag.current.update({
			noDragClassName,
			handleSelector,
			domNode: nodeRef.current,
			isSelectable,
			nodeId,
			nodeClickDistance
		});
		return () => {
			xyDrag.current?.destroy();
		};
	}, [
		noDragClassName,
		handleSelector,
		disabled,
		isSelectable,
		nodeRef,
		nodeId,
		nodeClickDistance
	]);
	return dragging;
}
const selectedAndDraggable = (nodesDraggable) => (n) => n.selected && (n.draggable || nodesDraggable && typeof n.draggable === "undefined");
/**
* Hook for updating node positions by passing a direction and factor
*
* @internal
* @returns function for updating node positions
*/
function useMoveSelectedNodes() {
	const store = useStoreApi();
	return useCallback((params) => {
		const { nodeExtent, snapToGrid, snapGrid, nodesDraggable, onError, updateNodePositions, nodeLookup, nodeOrigin } = store.getState();
		const nodeUpdates = /* @__PURE__ */ new Map();
		const isSelected = selectedAndDraggable(nodesDraggable);
		const xVelo = snapToGrid ? snapGrid[0] : 5;
		const yVelo = snapToGrid ? snapGrid[1] : 5;
		const xDiff = params.direction.x * xVelo * params.factor;
		const yDiff = params.direction.y * yVelo * params.factor;
		for (const [, node] of nodeLookup) {
			if (!isSelected(node)) continue;
			let nextPosition = {
				x: node.internals.positionAbsolute.x + xDiff,
				y: node.internals.positionAbsolute.y + yDiff
			};
			if (snapToGrid) nextPosition = snapPosition(nextPosition, snapGrid);
			const { position, positionAbsolute } = calculateNodePosition({
				nodeId: node.id,
				nextPosition,
				nodeLookup,
				nodeExtent,
				nodeOrigin,
				onError
			});
			node.position = position;
			node.internals.positionAbsolute = positionAbsolute;
			nodeUpdates.set(node.id, node);
		}
		updateNodePositions(nodeUpdates);
	}, []);
}
const NodeIdContext = createContext(null);
const Provider = NodeIdContext.Provider;
NodeIdContext.Consumer;
/**
* You can use this hook to get the id of the node it is used inside. It is useful
* if you need the node's id deeper in the render tree but don't want to manually
* drill down the id as a prop.
*
* @public
* @returns The id for a node in the flow.
*
* @example
*```jsx
*import { useNodeId } from '@xyflow/react';
*
*export default function CustomNode() {
*  return (
*    <div>
*      <span>This node has an id of </span>
*      <NodeIdDisplay />
*    </div>
*  );
*}
*
*function NodeIdDisplay() {
*  const nodeId = useNodeId();
*
*  return <span>{nodeId}</span>;
*}
*```
*/
const useNodeId = () => {
	return useContext(NodeIdContext);
};
const selector$g = (s) => ({
	connectOnClick: s.connectOnClick,
	noPanClassName: s.noPanClassName,
	rfId: s.rfId
});
const connectingSelector = (nodeId, handleId, type) => (state) => {
	const { connectionClickStartHandle: clickHandle, connectionMode, connection } = state;
	const { fromHandle, toHandle, isValid } = connection;
	const connectingTo = toHandle?.nodeId === nodeId && toHandle?.id === handleId && toHandle?.type === type;
	return {
		connectingFrom: fromHandle?.nodeId === nodeId && fromHandle?.id === handleId && fromHandle?.type === type,
		connectingTo,
		clickConnecting: clickHandle?.nodeId === nodeId && clickHandle?.id === handleId && clickHandle?.type === type,
		isPossibleEndHandle: connectionMode === ConnectionMode.Strict ? fromHandle?.type !== type : nodeId !== fromHandle?.nodeId || handleId !== fromHandle?.id,
		connectionInProcess: !!fromHandle,
		clickConnectionInProcess: !!clickHandle,
		valid: connectingTo && isValid
	};
};
function HandleComponent({ type = "source", position = Position.Top, isValidConnection, isConnectable = true, isConnectableStart = true, isConnectableEnd = true, id, onConnect, children, className, onMouseDown, onTouchStart, ...rest }, ref) {
	const handleId = id || null;
	const isTarget = type === "target";
	const store = useStoreApi();
	const nodeId = useNodeId();
	const { connectOnClick, noPanClassName, rfId } = useStore(selector$g, shallow$1);
	const { connectingFrom, connectingTo, clickConnecting, isPossibleEndHandle, connectionInProcess, clickConnectionInProcess, valid } = useStore(connectingSelector(nodeId, handleId, type), shallow$1);
	if (!nodeId) store.getState().onError?.("010", errorMessages["error010"]());
	const onConnectExtended = (params) => {
		const { defaultEdgeOptions, onConnect: onConnectAction, hasDefaultEdges } = store.getState();
		const edgeParams = {
			...defaultEdgeOptions,
			...params
		};
		if (hasDefaultEdges) {
			const { edges, setEdges } = store.getState();
			setEdges(addEdge(edgeParams, edges));
		}
		onConnectAction?.(edgeParams);
		onConnect?.(edgeParams);
	};
	const onPointerDown = (event) => {
		if (!nodeId) return;
		const isMouseTriggered = isMouseEvent(event.nativeEvent);
		if (isConnectableStart && (isMouseTriggered && event.button === 0 || !isMouseTriggered)) {
			const currentStore = store.getState();
			XYHandle.onPointerDown(event.nativeEvent, {
				handleDomNode: event.currentTarget,
				autoPanOnConnect: currentStore.autoPanOnConnect,
				connectionMode: currentStore.connectionMode,
				connectionRadius: currentStore.connectionRadius,
				domNode: currentStore.domNode,
				nodeLookup: currentStore.nodeLookup,
				lib: currentStore.lib,
				isTarget,
				handleId,
				nodeId,
				flowId: currentStore.rfId,
				panBy: currentStore.panBy,
				cancelConnection: currentStore.cancelConnection,
				onConnectStart: currentStore.onConnectStart,
				onConnectEnd: (...args) => store.getState().onConnectEnd?.(...args),
				updateConnection: currentStore.updateConnection,
				onConnect: onConnectExtended,
				isValidConnection: isValidConnection || ((...args) => store.getState().isValidConnection?.(...args) ?? true),
				getTransform: () => store.getState().transform,
				getFromHandle: () => store.getState().connection.fromHandle,
				autoPanSpeed: currentStore.autoPanSpeed,
				dragThreshold: currentStore.connectionDragThreshold
			});
		}
		if (isMouseTriggered) onMouseDown?.(event);
		else onTouchStart?.(event);
	};
	const onClick = (event) => {
		const { onClickConnectStart, onClickConnectEnd, connectionClickStartHandle, connectionMode, isValidConnection: isValidConnectionStore, lib, rfId: flowId, nodeLookup, connection: connectionState } = store.getState();
		if (!nodeId || !connectionClickStartHandle && !isConnectableStart) return;
		if (!connectionClickStartHandle) {
			onClickConnectStart?.(event.nativeEvent, {
				nodeId,
				handleId,
				handleType: type
			});
			store.setState({ connectionClickStartHandle: {
				nodeId,
				type,
				id: handleId
			} });
			return;
		}
		const doc = getHostForElement(event.target);
		const isValidConnectionHandler = isValidConnection || isValidConnectionStore;
		const { connection, isValid } = XYHandle.isValid(event.nativeEvent, {
			handle: {
				nodeId,
				id: handleId,
				type
			},
			connectionMode,
			fromNodeId: connectionClickStartHandle.nodeId,
			fromHandleId: connectionClickStartHandle.id || null,
			fromType: connectionClickStartHandle.type,
			isValidConnection: isValidConnectionHandler,
			flowId,
			doc,
			lib,
			nodeLookup
		});
		if (isValid && connection) onConnectExtended(connection);
		const connectionClone = structuredClone(connectionState);
		delete connectionClone.inProgress;
		connectionClone.toPosition = connectionClone.toHandle ? connectionClone.toHandle.position : null;
		onClickConnectEnd?.(event, connectionClone);
		store.setState({ connectionClickStartHandle: null });
	};
	return (0, import_jsx_runtime.jsx)("div", {
		"data-handleid": handleId,
		"data-nodeid": nodeId,
		"data-handlepos": position,
		"data-id": `${rfId}-${nodeId}-${handleId}-${type}`,
		className: cc([
			"react-flow__handle",
			`react-flow__handle-${position}`,
			"nodrag",
			noPanClassName,
			className,
			{
				source: !isTarget,
				target: isTarget,
				connectable: isConnectable,
				connectablestart: isConnectableStart,
				connectableend: isConnectableEnd,
				clickconnecting: clickConnecting,
				connectingfrom: connectingFrom,
				connectingto: connectingTo,
				valid,
				connectionindicator: isConnectable && (!connectionInProcess || isPossibleEndHandle) && (connectionInProcess || clickConnectionInProcess ? isConnectableEnd : isConnectableStart)
			}
		]),
		onMouseDown: onPointerDown,
		onTouchStart: onPointerDown,
		onClick: connectOnClick ? onClick : void 0,
		ref,
		...rest,
		children
	});
}
/**
* The `<Handle />` component is used in your [custom nodes](/learn/customization/custom-nodes)
* to define connection points.
*
*@public
*
*@example
*
*```jsx
*import { Handle, Position } from '@xyflow/react';
*
*export function CustomNode({ data }) {
*  return (
*    <>
*      <div style={{ padding: '10px 20px' }}>
*        {data.label}
*      </div>
*
*      <Handle type="target" position={Position.Left} />
*      <Handle type="source" position={Position.Right} />
*    </>
*  );
*};
*```
*/
const Handle = memo(fixedForwardRef(HandleComponent));
function InputNode({ data, isConnectable, sourcePosition = Position.Bottom }) {
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [data?.label, (0, import_jsx_runtime.jsx)(Handle, {
		type: "source",
		position: sourcePosition,
		isConnectable
	})] });
}
function DefaultNode({ data, isConnectable, targetPosition = Position.Top, sourcePosition = Position.Bottom }) {
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		(0, import_jsx_runtime.jsx)(Handle, {
			type: "target",
			position: targetPosition,
			isConnectable
		}),
		data?.label,
		(0, import_jsx_runtime.jsx)(Handle, {
			type: "source",
			position: sourcePosition,
			isConnectable
		})
	] });
}
function GroupNode() {
	return null;
}
function OutputNode({ data, isConnectable, targetPosition = Position.Top }) {
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(Handle, {
		type: "target",
		position: targetPosition,
		isConnectable
	}), data?.label] });
}
const arrowKeyDiffs = {
	ArrowUp: {
		x: 0,
		y: -1
	},
	ArrowDown: {
		x: 0,
		y: 1
	},
	ArrowLeft: {
		x: -1,
		y: 0
	},
	ArrowRight: {
		x: 1,
		y: 0
	}
};
const builtinNodeTypes = {
	input: InputNode,
	default: DefaultNode,
	output: OutputNode,
	group: GroupNode
};
function getNodeInlineStyleDimensions(node) {
	if (node.internals.handleBounds === void 0) return {
		width: node.width ?? node.initialWidth ?? node.style?.width,
		height: node.height ?? node.initialHeight ?? node.style?.height
	};
	return {
		width: node.width ?? node.style?.width,
		height: node.height ?? node.style?.height
	};
}
const selector$f = (s) => {
	const { width, height, x, y } = getInternalNodesBounds(s.nodeLookup, { filter: (node) => !!node.selected });
	return {
		width: isNumeric(width) ? width : null,
		height: isNumeric(height) ? height : null,
		userSelectionActive: s.userSelectionActive,
		transformString: `translate(${s.transform[0]}px,${s.transform[1]}px) scale(${s.transform[2]}) translate(${x}px,${y}px)`
	};
};
function NodesSelection({ onSelectionContextMenu, noPanClassName, disableKeyboardA11y }) {
	const store = useStoreApi();
	const { width, height, transformString, userSelectionActive } = useStore(selector$f, shallow$1);
	const moveSelectedNodes = useMoveSelectedNodes();
	const nodeRef = useRef(null);
	useEffect(() => {
		if (!disableKeyboardA11y) nodeRef.current?.focus({ preventScroll: true });
	}, [disableKeyboardA11y]);
	const shouldRender = !userSelectionActive && width !== null && height !== null;
	useDrag({
		nodeRef,
		disabled: !shouldRender
	});
	if (!shouldRender) return null;
	const onContextMenu = onSelectionContextMenu ? (event) => {
		onSelectionContextMenu(event, store.getState().nodes.filter((n) => n.selected));
	} : void 0;
	const onKeyDown = (event) => {
		if (Object.prototype.hasOwnProperty.call(arrowKeyDiffs, event.key)) {
			event.preventDefault();
			moveSelectedNodes({
				direction: arrowKeyDiffs[event.key],
				factor: event.shiftKey ? 4 : 1
			});
		}
	};
	return (0, import_jsx_runtime.jsx)("div", {
		className: cc([
			"react-flow__nodesselection",
			"react-flow__container",
			noPanClassName
		]),
		style: { transform: transformString },
		children: (0, import_jsx_runtime.jsx)("div", {
			ref: nodeRef,
			className: "react-flow__nodesselection-rect",
			onContextMenu,
			tabIndex: disableKeyboardA11y ? void 0 : -1,
			onKeyDown: disableKeyboardA11y ? void 0 : onKeyDown,
			style: {
				width,
				height
			}
		})
	});
}
const win = typeof window !== "undefined" ? window : void 0;
const selector$e = (s) => {
	return {
		nodesSelectionActive: s.nodesSelectionActive,
		userSelectionActive: s.userSelectionActive
	};
};
function FlowRendererComponent({ children, onPaneClick, onPaneMouseEnter, onPaneMouseMove, onPaneMouseLeave, onPaneContextMenu, onPaneScroll, paneClickDistance, deleteKeyCode, selectionKeyCode, selectionOnDrag, selectionMode, onSelectionStart, onSelectionEnd, multiSelectionKeyCode, panActivationKeyCode, zoomActivationKeyCode, elementsSelectable, zoomOnScroll, zoomOnPinch, panOnScroll: _panOnScroll, panOnScrollSpeed, panOnScrollMode, zoomOnDoubleClick, panOnDrag: _panOnDrag, defaultViewport, translateExtent, minZoom, maxZoom, preventScrolling, onSelectionContextMenu, noWheelClassName, noPanClassName, disableKeyboardA11y, onViewportChange, isControlledViewport }) {
	const { nodesSelectionActive, userSelectionActive } = useStore(selector$e, shallow$1);
	const selectionKeyPressed = useKeyPress(selectionKeyCode, { target: win });
	const panActivationKeyPressed = useKeyPress(panActivationKeyCode, { target: win });
	const panOnDrag = panActivationKeyPressed || _panOnDrag;
	const panOnScroll = panActivationKeyPressed || _panOnScroll;
	const _selectionOnDrag = selectionOnDrag && panOnDrag !== true;
	const isSelecting = selectionKeyPressed || userSelectionActive || _selectionOnDrag;
	useGlobalKeyHandler({
		deleteKeyCode,
		multiSelectionKeyCode
	});
	return (0, import_jsx_runtime.jsx)(ZoomPane, {
		onPaneContextMenu,
		elementsSelectable,
		zoomOnScroll,
		zoomOnPinch,
		panOnScroll,
		panOnScrollSpeed,
		panOnScrollMode,
		zoomOnDoubleClick,
		panOnDrag: !selectionKeyPressed && panOnDrag,
		defaultViewport,
		translateExtent,
		minZoom,
		maxZoom,
		zoomActivationKeyCode,
		preventScrolling,
		noWheelClassName,
		noPanClassName,
		onViewportChange,
		isControlledViewport,
		paneClickDistance,
		selectionOnDrag: _selectionOnDrag,
		children: (0, import_jsx_runtime.jsxs)(Pane, {
			onSelectionStart,
			onSelectionEnd,
			onPaneClick,
			onPaneMouseEnter,
			onPaneMouseMove,
			onPaneMouseLeave,
			onPaneContextMenu,
			onPaneScroll,
			panOnDrag,
			isSelecting: !!isSelecting,
			selectionMode,
			selectionKeyPressed,
			paneClickDistance,
			selectionOnDrag: _selectionOnDrag,
			children: [children, nodesSelectionActive && (0, import_jsx_runtime.jsx)(NodesSelection, {
				onSelectionContextMenu,
				noPanClassName,
				disableKeyboardA11y
			})]
		})
	});
}
FlowRendererComponent.displayName = "FlowRenderer";
const FlowRenderer = memo(FlowRendererComponent);
const selector$d = (onlyRenderVisible) => (s) => {
	return onlyRenderVisible ? getNodesInside(s.nodeLookup, {
		x: 0,
		y: 0,
		width: s.width,
		height: s.height
	}, s.transform, true).map((node) => node.id) : Array.from(s.nodeLookup.keys());
};
/**
* Hook for getting the visible node ids from the store.
*
* @internal
* @param onlyRenderVisible
* @returns array with visible node ids
*/
function useVisibleNodeIds(onlyRenderVisible) {
	return useStore(useCallback(selector$d(onlyRenderVisible), [onlyRenderVisible]), shallow$1);
}
const selector$c = (s) => s.updateNodeInternals;
function useResizeObserver() {
	const updateNodeInternals = useStore(selector$c);
	const [resizeObserver] = useState(() => {
		if (typeof ResizeObserver === "undefined") return null;
		return new ResizeObserver((entries) => {
			const updates = /* @__PURE__ */ new Map();
			entries.forEach((entry) => {
				const id = entry.target.getAttribute("data-id");
				updates.set(id, {
					id,
					nodeElement: entry.target,
					force: true
				});
			});
			updateNodeInternals(updates);
		});
	});
	useEffect(() => {
		return () => {
			resizeObserver?.disconnect();
		};
	}, [resizeObserver]);
	return resizeObserver;
}
/**
* Hook to handle the resize observation + internal updates for the passed node.
*
* @internal
* @returns nodeRef - reference to the node element
*/
function useNodeObserver({ node, nodeType, hasDimensions, resizeObserver }) {
	const store = useStoreApi();
	const nodeRef = useRef(null);
	const observedNode = useRef(null);
	const prevSourcePosition = useRef(node.sourcePosition);
	const prevTargetPosition = useRef(node.targetPosition);
	const prevType = useRef(nodeType);
	const isInitialized = hasDimensions && !!node.internals.handleBounds;
	useEffect(() => {
		if (nodeRef.current && !node.hidden && (!isInitialized || observedNode.current !== nodeRef.current)) {
			if (observedNode.current) resizeObserver?.unobserve(observedNode.current);
			resizeObserver?.observe(nodeRef.current);
			observedNode.current = nodeRef.current;
		}
	}, [isInitialized, node.hidden]);
	useEffect(() => {
		return () => {
			if (observedNode.current) {
				resizeObserver?.unobserve(observedNode.current);
				observedNode.current = null;
			}
		};
	}, []);
	useEffect(() => {
		if (nodeRef.current) {
			const typeChanged = prevType.current !== nodeType;
			const sourcePosChanged = prevSourcePosition.current !== node.sourcePosition;
			const targetPosChanged = prevTargetPosition.current !== node.targetPosition;
			if (typeChanged || sourcePosChanged || targetPosChanged) {
				prevType.current = nodeType;
				prevSourcePosition.current = node.sourcePosition;
				prevTargetPosition.current = node.targetPosition;
				store.getState().updateNodeInternals(new Map([[node.id, {
					id: node.id,
					nodeElement: nodeRef.current,
					force: true
				}]]));
			}
		}
	}, [
		node.id,
		nodeType,
		node.sourcePosition,
		node.targetPosition
	]);
	return nodeRef;
}
function NodeWrapper({ id, onClick, onMouseEnter, onMouseMove, onMouseLeave, onContextMenu, onDoubleClick, nodesDraggable, elementsSelectable, nodesConnectable, nodesFocusable, resizeObserver, noDragClassName, noPanClassName, disableKeyboardA11y, rfId, nodeTypes, nodeClickDistance, onError }) {
	const { node, internals, isParent } = useStore((s) => {
		const node = s.nodeLookup.get(id);
		const isParent = s.parentLookup.has(id);
		return {
			node,
			internals: node.internals,
			isParent
		};
	}, shallow$1);
	let nodeType = node.type || "default";
	let NodeComponent = nodeTypes?.[nodeType] || builtinNodeTypes[nodeType];
	if (NodeComponent === void 0) {
		onError?.("003", errorMessages["error003"](nodeType));
		nodeType = "default";
		NodeComponent = nodeTypes?.["default"] || builtinNodeTypes.default;
	}
	const isDraggable = !!(node.draggable || nodesDraggable && typeof node.draggable === "undefined");
	const isSelectable = !!(node.selectable || elementsSelectable && typeof node.selectable === "undefined");
	const isConnectable = !!(node.connectable || nodesConnectable && typeof node.connectable === "undefined");
	const isFocusable = !!(node.focusable || nodesFocusable && typeof node.focusable === "undefined");
	const store = useStoreApi();
	const hasDimensions = nodeHasDimensions(node);
	const nodeRef = useNodeObserver({
		node,
		nodeType,
		hasDimensions,
		resizeObserver
	});
	const dragging = useDrag({
		nodeRef,
		disabled: node.hidden || !isDraggable,
		noDragClassName,
		handleSelector: node.dragHandle,
		nodeId: id,
		isSelectable,
		nodeClickDistance
	});
	const moveSelectedNodes = useMoveSelectedNodes();
	if (node.hidden) return null;
	const nodeDimensions = getNodeDimensions(node);
	const inlineDimensions = getNodeInlineStyleDimensions(node);
	const hasPointerEvents = isSelectable || isDraggable || onClick || onMouseEnter || onMouseMove || onMouseLeave;
	const onMouseEnterHandler = onMouseEnter ? (event) => onMouseEnter(event, { ...internals.userNode }) : void 0;
	const onMouseMoveHandler = onMouseMove ? (event) => onMouseMove(event, { ...internals.userNode }) : void 0;
	const onMouseLeaveHandler = onMouseLeave ? (event) => onMouseLeave(event, { ...internals.userNode }) : void 0;
	const onContextMenuHandler = onContextMenu ? (event) => onContextMenu(event, { ...internals.userNode }) : void 0;
	const onDoubleClickHandler = onDoubleClick ? (event) => onDoubleClick(event, { ...internals.userNode }) : void 0;
	const onSelectNodeHandler = (event) => {
		const { selectNodesOnDrag, nodeDragThreshold } = store.getState();
		if (isSelectable && (!selectNodesOnDrag || !isDraggable || nodeDragThreshold > 0)) handleNodeClick({
			id,
			store,
			nodeRef
		});
		if (onClick) onClick(event, { ...internals.userNode });
	};
	const onKeyDown = (event) => {
		if (isInputDOMNode(event.nativeEvent) || disableKeyboardA11y) return;
		if (elementSelectionKeys.includes(event.key) && isSelectable) handleNodeClick({
			id,
			store,
			unselect: event.key === "Escape",
			nodeRef
		});
		else if (isDraggable && node.selected && Object.prototype.hasOwnProperty.call(arrowKeyDiffs, event.key)) {
			event.preventDefault();
			const { ariaLabelConfig } = store.getState();
			store.setState({ ariaLiveMessage: ariaLabelConfig["node.a11yDescription.ariaLiveMessage"]({
				direction: event.key.replace("Arrow", "").toLowerCase(),
				x: ~~internals.positionAbsolute.x,
				y: ~~internals.positionAbsolute.y
			}) });
			moveSelectedNodes({
				direction: arrowKeyDiffs[event.key],
				factor: event.shiftKey ? 4 : 1
			});
		}
	};
	const onFocus = () => {
		if (disableKeyboardA11y || !nodeRef.current?.matches(":focus-visible")) return;
		const { transform, width, height, autoPanOnNodeFocus, setCenter } = store.getState();
		if (!autoPanOnNodeFocus) return;
		if (!(getNodesInside(new Map([[id, node]]), {
			x: 0,
			y: 0,
			width,
			height
		}, transform, true).length > 0)) setCenter(node.position.x + nodeDimensions.width / 2, node.position.y + nodeDimensions.height / 2, { zoom: transform[2] });
	};
	return (0, import_jsx_runtime.jsx)("div", {
		className: cc([
			"react-flow__node",
			`react-flow__node-${nodeType}`,
			{ [noPanClassName]: isDraggable },
			node.className,
			{
				selected: node.selected,
				selectable: isSelectable,
				parent: isParent,
				draggable: isDraggable,
				dragging
			}
		]),
		ref: nodeRef,
		style: {
			zIndex: internals.z,
			transform: `translate(${internals.positionAbsolute.x}px,${internals.positionAbsolute.y}px)`,
			pointerEvents: hasPointerEvents ? "all" : "none",
			visibility: hasDimensions ? "visible" : "hidden",
			...node.style,
			...inlineDimensions
		},
		"data-id": id,
		"data-testid": `rf__node-${id}`,
		onMouseEnter: onMouseEnterHandler,
		onMouseMove: onMouseMoveHandler,
		onMouseLeave: onMouseLeaveHandler,
		onContextMenu: onContextMenuHandler,
		onClick: onSelectNodeHandler,
		onDoubleClick: onDoubleClickHandler,
		onKeyDown: isFocusable ? onKeyDown : void 0,
		tabIndex: isFocusable ? 0 : void 0,
		onFocus: isFocusable ? onFocus : void 0,
		role: node.ariaRole ?? (isFocusable ? "group" : void 0),
		"aria-roledescription": "node",
		"aria-describedby": disableKeyboardA11y ? void 0 : `${ARIA_NODE_DESC_KEY}-${rfId}`,
		"aria-label": node.ariaLabel,
		...node.domAttributes,
		children: (0, import_jsx_runtime.jsx)(Provider, {
			value: id,
			children: (0, import_jsx_runtime.jsx)(NodeComponent, {
				id,
				data: node.data,
				type: nodeType,
				positionAbsoluteX: internals.positionAbsolute.x,
				positionAbsoluteY: internals.positionAbsolute.y,
				selected: node.selected ?? false,
				selectable: isSelectable,
				draggable: isDraggable,
				deletable: node.deletable ?? true,
				isConnectable,
				sourcePosition: node.sourcePosition,
				targetPosition: node.targetPosition,
				dragging,
				dragHandle: node.dragHandle,
				zIndex: internals.z,
				parentId: node.parentId,
				...nodeDimensions
			})
		})
	});
}
var NodeWrapper$1 = memo(NodeWrapper);
const selector$b = (s) => ({
	nodesDraggable: s.nodesDraggable,
	nodesConnectable: s.nodesConnectable,
	nodesFocusable: s.nodesFocusable,
	elementsSelectable: s.elementsSelectable,
	onError: s.onError
});
function NodeRendererComponent(props) {
	const { nodesDraggable, nodesConnectable, nodesFocusable, elementsSelectable, onError } = useStore(selector$b, shallow$1);
	const nodeIds = useVisibleNodeIds(props.onlyRenderVisibleElements);
	const resizeObserver = useResizeObserver();
	return (0, import_jsx_runtime.jsx)("div", {
		className: "react-flow__nodes",
		style: containerStyle,
		children: nodeIds.map((nodeId) => {
			return (0, import_jsx_runtime.jsx)(NodeWrapper$1, {
				id: nodeId,
				nodeTypes: props.nodeTypes,
				nodeExtent: props.nodeExtent,
				onClick: props.onNodeClick,
				onMouseEnter: props.onNodeMouseEnter,
				onMouseMove: props.onNodeMouseMove,
				onMouseLeave: props.onNodeMouseLeave,
				onContextMenu: props.onNodeContextMenu,
				onDoubleClick: props.onNodeDoubleClick,
				noDragClassName: props.noDragClassName,
				noPanClassName: props.noPanClassName,
				rfId: props.rfId,
				disableKeyboardA11y: props.disableKeyboardA11y,
				resizeObserver,
				nodesDraggable,
				nodesConnectable,
				nodesFocusable,
				elementsSelectable,
				nodeClickDistance: props.nodeClickDistance,
				onError
			}, nodeId);
		})
	});
}
NodeRendererComponent.displayName = "NodeRenderer";
const NodeRenderer = memo(NodeRendererComponent);
/**
* Hook for getting the visible edge ids from the store.
*
* @internal
* @param onlyRenderVisible
* @returns array with visible edge ids
*/
function useVisibleEdgeIds(onlyRenderVisible) {
	return useStore(useCallback((s) => {
		if (!onlyRenderVisible) return s.edges.map((edge) => edge.id);
		const visibleEdgeIds = [];
		if (s.width && s.height) for (const edge of s.edges) {
			const sourceNode = s.nodeLookup.get(edge.source);
			const targetNode = s.nodeLookup.get(edge.target);
			if (sourceNode && targetNode && isEdgeVisible({
				sourceNode,
				targetNode,
				width: s.width,
				height: s.height,
				transform: s.transform
			})) visibleEdgeIds.push(edge.id);
		}
		return visibleEdgeIds;
	}, [onlyRenderVisible]), shallow$1);
}
const ArrowSymbol = ({ color = "none", strokeWidth = 1 }) => {
	return (0, import_jsx_runtime.jsx)("polyline", {
		className: "arrow",
		style: {
			strokeWidth,
			...color && { stroke: color }
		},
		strokeLinecap: "round",
		fill: "none",
		strokeLinejoin: "round",
		points: "-5,-4 0,0 -5,4"
	});
};
const ArrowClosedSymbol = ({ color = "none", strokeWidth = 1 }) => {
	return (0, import_jsx_runtime.jsx)("polyline", {
		className: "arrowclosed",
		style: {
			strokeWidth,
			...color && {
				stroke: color,
				fill: color
			}
		},
		strokeLinecap: "round",
		strokeLinejoin: "round",
		points: "-5,-4 0,0 -5,4 -5,-4"
	});
};
const MarkerSymbols = {
	[MarkerType.Arrow]: ArrowSymbol,
	[MarkerType.ArrowClosed]: ArrowClosedSymbol
};
function useMarkerSymbol(type) {
	const store = useStoreApi();
	return useMemo(() => {
		if (!Object.prototype.hasOwnProperty.call(MarkerSymbols, type)) {
			store.getState().onError?.("009", errorMessages["error009"](type));
			return null;
		}
		return MarkerSymbols[type];
	}, [type]);
}
const Marker = ({ id, type, color, width = 12.5, height = 12.5, markerUnits = "strokeWidth", strokeWidth, orient = "auto-start-reverse" }) => {
	const Symbol = useMarkerSymbol(type);
	if (!Symbol) return null;
	return (0, import_jsx_runtime.jsx)("marker", {
		className: "react-flow__arrowhead",
		id,
		markerWidth: `${width}`,
		markerHeight: `${height}`,
		viewBox: "-10 -10 20 20",
		markerUnits,
		orient,
		refX: "0",
		refY: "0",
		children: (0, import_jsx_runtime.jsx)(Symbol, {
			color,
			strokeWidth
		})
	});
};
const MarkerDefinitions = ({ defaultColor, rfId }) => {
	const edges = useStore((s) => s.edges);
	const defaultEdgeOptions = useStore((s) => s.defaultEdgeOptions);
	const markers = useMemo(() => {
		return createMarkerIds(edges, {
			id: rfId,
			defaultColor,
			defaultMarkerStart: defaultEdgeOptions?.markerStart,
			defaultMarkerEnd: defaultEdgeOptions?.markerEnd
		});
	}, [
		edges,
		defaultEdgeOptions,
		rfId,
		defaultColor
	]);
	if (!markers.length) return null;
	return (0, import_jsx_runtime.jsx)("svg", {
		className: "react-flow__marker",
		"aria-hidden": "true",
		children: (0, import_jsx_runtime.jsx)("defs", { children: markers.map((marker) => (0, import_jsx_runtime.jsx)(Marker, {
			id: marker.id,
			type: marker.type,
			color: marker.color,
			width: marker.width,
			height: marker.height,
			markerUnits: marker.markerUnits,
			strokeWidth: marker.strokeWidth,
			orient: marker.orient
		}, marker.id)) })
	});
};
MarkerDefinitions.displayName = "MarkerDefinitions";
var MarkerDefinitions$1 = memo(MarkerDefinitions);
function EdgeTextComponent({ x, y, label, labelStyle, labelShowBg = true, labelBgStyle, labelBgPadding = [2, 4], labelBgBorderRadius = 2, children, className, ...rest }) {
	const [edgeTextBbox, setEdgeTextBbox] = useState({
		x: 1,
		y: 0,
		width: 0,
		height: 0
	});
	const edgeTextClasses = cc(["react-flow__edge-textwrapper", className]);
	const edgeTextRef = useRef(null);
	useEffect(() => {
		if (edgeTextRef.current) {
			const textBbox = edgeTextRef.current.getBBox();
			setEdgeTextBbox({
				x: textBbox.x,
				y: textBbox.y,
				width: textBbox.width,
				height: textBbox.height
			});
		}
	}, [label]);
	if (!label) return null;
	return (0, import_jsx_runtime.jsxs)("g", {
		transform: `translate(${x - edgeTextBbox.width / 2} ${y - edgeTextBbox.height / 2})`,
		className: edgeTextClasses,
		visibility: edgeTextBbox.width ? "visible" : "hidden",
		...rest,
		children: [
			labelShowBg && (0, import_jsx_runtime.jsx)("rect", {
				width: edgeTextBbox.width + 2 * labelBgPadding[0],
				x: -labelBgPadding[0],
				y: -labelBgPadding[1],
				height: edgeTextBbox.height + 2 * labelBgPadding[1],
				className: "react-flow__edge-textbg",
				style: labelBgStyle,
				rx: labelBgBorderRadius,
				ry: labelBgBorderRadius
			}),
			(0, import_jsx_runtime.jsx)("text", {
				className: "react-flow__edge-text",
				y: edgeTextBbox.height / 2,
				dy: "0.3em",
				ref: edgeTextRef,
				style: labelStyle,
				children: label
			}),
			children
		]
	});
}
EdgeTextComponent.displayName = "EdgeText";
/**
* You can use the `<EdgeText />` component as a helper component to display text
* within your custom edges.
*
* @public
*
* @example
* ```jsx
* import { EdgeText } from '@xyflow/react';
*
* export function CustomEdgeLabel({ label }) {
*   return (
*     <EdgeText
*       x={100}
*       y={100}
*       label={label}
*       labelStyle={{ fill: 'white' }}
*       labelShowBg
*       labelBgStyle={{ fill: 'red' }}
*       labelBgPadding={[2, 4]}
*       labelBgBorderRadius={2}
*     />
*   );
* }
*```
*/
const EdgeText = memo(EdgeTextComponent);
/**
* The `<BaseEdge />` component gets used internally for all the edges. It can be
* used inside a custom edge and handles the invisible helper edge and the edge label
* for you.
*
* @public
* @example
* ```jsx
*import { BaseEdge } from '@xyflow/react';
*
*export function CustomEdge({ sourceX, sourceY, targetX, targetY, ...props }) {
*  const [edgePath] = getStraightPath({
*    sourceX,
*    sourceY,
*    targetX,
*    targetY,
*  });
*
*  return <BaseEdge path={edgePath} {...props} />;
*}
*```
*
* @remarks If you want to use an edge marker with the [`<BaseEdge />`](/api-reference/components/base-edge) component,
* you can pass the `markerStart` or `markerEnd` props passed to your custom edge
* through to the [`<BaseEdge />`](/api-reference/components/base-edge) component.
* You can see all the props passed to a custom edge by looking at the [`EdgeProps`](/api-reference/types/edge-props) type.
*/
function BaseEdge({ path, labelX, labelY, label, labelStyle, labelShowBg, labelBgStyle, labelBgPadding, labelBgBorderRadius, interactionWidth = 20, ...props }) {
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
		(0, import_jsx_runtime.jsx)("path", {
			...props,
			d: path,
			fill: "none",
			className: cc(["react-flow__edge-path", props.className])
		}),
		interactionWidth ? (0, import_jsx_runtime.jsx)("path", {
			d: path,
			fill: "none",
			strokeOpacity: 0,
			strokeWidth: interactionWidth,
			className: "react-flow__edge-interaction"
		}) : null,
		label && isNumeric(labelX) && isNumeric(labelY) ? (0, import_jsx_runtime.jsx)(EdgeText, {
			x: labelX,
			y: labelY,
			label,
			labelStyle,
			labelShowBg,
			labelBgStyle,
			labelBgPadding,
			labelBgBorderRadius
		}) : null
	] });
}
function getControl({ pos, x1, y1, x2, y2 }) {
	if (pos === Position.Left || pos === Position.Right) return [.5 * (x1 + x2), y1];
	return [x1, .5 * (y1 + y2)];
}
/**
* The `getSimpleBezierPath` util returns everything you need to render a simple
* bezier edge between two nodes.
* @public
* @returns
* - `path`: the path to use in an SVG `<path>` element.
* - `labelX`: the `x` position you can use to render a label for this edge.
* - `labelY`: the `y` position you can use to render a label for this edge.
* - `offsetX`: the absolute difference between the source `x` position and the `x` position of the
* middle of this path.
* - `offsetY`: the absolute difference between the source `y` position and the `y` position of the
* middle of this path.
*/
function getSimpleBezierPath({ sourceX, sourceY, sourcePosition = Position.Bottom, targetX, targetY, targetPosition = Position.Top }) {
	const [sourceControlX, sourceControlY] = getControl({
		pos: sourcePosition,
		x1: sourceX,
		y1: sourceY,
		x2: targetX,
		y2: targetY
	});
	const [targetControlX, targetControlY] = getControl({
		pos: targetPosition,
		x1: targetX,
		y1: targetY,
		x2: sourceX,
		y2: sourceY
	});
	const [labelX, labelY, offsetX, offsetY] = getBezierEdgeCenter({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourceControlX,
		sourceControlY,
		targetControlX,
		targetControlY
	});
	return [
		`M${sourceX},${sourceY} C${sourceControlX},${sourceControlY} ${targetControlX},${targetControlY} ${targetX},${targetY}`,
		labelX,
		labelY,
		offsetX,
		offsetY
	];
}
function createSimpleBezierEdge(params) {
	return memo(({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, labelStyle, labelShowBg, labelBgStyle, labelBgPadding, labelBgBorderRadius, style, markerEnd, markerStart, interactionWidth }) => {
		const [path, labelX, labelY] = getSimpleBezierPath({
			sourceX,
			sourceY,
			sourcePosition,
			targetX,
			targetY,
			targetPosition
		});
		return (0, import_jsx_runtime.jsx)(BaseEdge, {
			id: params.isInternal ? void 0 : id,
			path,
			labelX,
			labelY,
			label,
			labelStyle,
			labelShowBg,
			labelBgStyle,
			labelBgPadding,
			labelBgBorderRadius,
			style,
			markerEnd,
			markerStart,
			interactionWidth
		});
	});
}
const SimpleBezierEdge = createSimpleBezierEdge({ isInternal: false });
const SimpleBezierEdgeInternal = createSimpleBezierEdge({ isInternal: true });
SimpleBezierEdge.displayName = "SimpleBezierEdge";
SimpleBezierEdgeInternal.displayName = "SimpleBezierEdgeInternal";
function createSmoothStepEdge(params) {
	return memo(({ id, sourceX, sourceY, targetX, targetY, label, labelStyle, labelShowBg, labelBgStyle, labelBgPadding, labelBgBorderRadius, style, sourcePosition = Position.Bottom, targetPosition = Position.Top, markerEnd, markerStart, pathOptions, interactionWidth }) => {
		const [path, labelX, labelY] = getSmoothStepPath({
			sourceX,
			sourceY,
			sourcePosition,
			targetX,
			targetY,
			targetPosition,
			borderRadius: pathOptions?.borderRadius,
			offset: pathOptions?.offset,
			stepPosition: pathOptions?.stepPosition
		});
		return (0, import_jsx_runtime.jsx)(BaseEdge, {
			id: params.isInternal ? void 0 : id,
			path,
			labelX,
			labelY,
			label,
			labelStyle,
			labelShowBg,
			labelBgStyle,
			labelBgPadding,
			labelBgBorderRadius,
			style,
			markerEnd,
			markerStart,
			interactionWidth
		});
	});
}
/**
* Component that can be used inside a custom edge to render a smooth step edge.
*
* @public
* @example
*
* ```tsx
* import { SmoothStepEdge } from '@xyflow/react';
*
* function CustomEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }) {
*   return (
*     <SmoothStepEdge
*       sourceX={sourceX}
*       sourceY={sourceY}
*       targetX={targetX}
*       targetY={targetY}
*       sourcePosition={sourcePosition}
*       targetPosition={targetPosition}
*     />
*   );
* }
* ```
*/
const SmoothStepEdge = createSmoothStepEdge({ isInternal: false });
/**
* @internal
*/
const SmoothStepEdgeInternal = createSmoothStepEdge({ isInternal: true });
SmoothStepEdge.displayName = "SmoothStepEdge";
SmoothStepEdgeInternal.displayName = "SmoothStepEdgeInternal";
function createStepEdge(params) {
	return memo(({ id, ...props }) => {
		const _id = params.isInternal ? void 0 : id;
		return (0, import_jsx_runtime.jsx)(SmoothStepEdge, {
			...props,
			id: _id,
			pathOptions: useMemo(() => ({
				borderRadius: 0,
				offset: props.pathOptions?.offset
			}), [props.pathOptions?.offset])
		});
	});
}
/**
* Component that can be used inside a custom edge to render a step edge.
*
* @public
* @example
*
* ```tsx
* import { StepEdge } from '@xyflow/react';
*
* function CustomEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }) {
*   return (
*     <StepEdge
*       sourceX={sourceX}
*       sourceY={sourceY}
*       targetX={targetX}
*       targetY={targetY}
*       sourcePosition={sourcePosition}
*       targetPosition={targetPosition}
*     />
*   );
* }
* ```
*/
const StepEdge = createStepEdge({ isInternal: false });
/**
* @internal
*/
const StepEdgeInternal = createStepEdge({ isInternal: true });
StepEdge.displayName = "StepEdge";
StepEdgeInternal.displayName = "StepEdgeInternal";
function createStraightEdge(params) {
	return memo(({ id, sourceX, sourceY, targetX, targetY, label, labelStyle, labelShowBg, labelBgStyle, labelBgPadding, labelBgBorderRadius, style, markerEnd, markerStart, interactionWidth }) => {
		const [path, labelX, labelY] = getStraightPath({
			sourceX,
			sourceY,
			targetX,
			targetY
		});
		return (0, import_jsx_runtime.jsx)(BaseEdge, {
			id: params.isInternal ? void 0 : id,
			path,
			labelX,
			labelY,
			label,
			labelStyle,
			labelShowBg,
			labelBgStyle,
			labelBgPadding,
			labelBgBorderRadius,
			style,
			markerEnd,
			markerStart,
			interactionWidth
		});
	});
}
/**
* Component that can be used inside a custom edge to render a straight line.
*
* @public
* @example
*
* ```tsx
* import { StraightEdge } from '@xyflow/react';
*
* function CustomEdge({ sourceX, sourceY, targetX, targetY }) {
*   return (
*     <StraightEdge
*       sourceX={sourceX}
*       sourceY={sourceY}
*       targetX={targetX}
*       targetY={targetY}
*     />
*   );
* }
* ```
*/
const StraightEdge = createStraightEdge({ isInternal: false });
/**
* @internal
*/
const StraightEdgeInternal = createStraightEdge({ isInternal: true });
StraightEdge.displayName = "StraightEdge";
StraightEdgeInternal.displayName = "StraightEdgeInternal";
function createBezierEdge(params) {
	return memo(({ id, sourceX, sourceY, targetX, targetY, sourcePosition = Position.Bottom, targetPosition = Position.Top, label, labelStyle, labelShowBg, labelBgStyle, labelBgPadding, labelBgBorderRadius, style, markerEnd, markerStart, pathOptions, interactionWidth }) => {
		const [path, labelX, labelY] = getBezierPath({
			sourceX,
			sourceY,
			sourcePosition,
			targetX,
			targetY,
			targetPosition,
			curvature: pathOptions?.curvature
		});
		return (0, import_jsx_runtime.jsx)(BaseEdge, {
			id: params.isInternal ? void 0 : id,
			path,
			labelX,
			labelY,
			label,
			labelStyle,
			labelShowBg,
			labelBgStyle,
			labelBgPadding,
			labelBgBorderRadius,
			style,
			markerEnd,
			markerStart,
			interactionWidth
		});
	});
}
/**
* Component that can be used inside a custom edge to render a bezier curve.
*
* @public
* @example
*
* ```tsx
* import { BezierEdge } from '@xyflow/react';
*
* function CustomEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }) {
*   return (
*     <BezierEdge
*       sourceX={sourceX}
*       sourceY={sourceY}
*       targetX={targetX}
*       targetY={targetY}
*       sourcePosition={sourcePosition}
*       targetPosition={targetPosition}
*     />
*   );
* }
* ```
*/
const BezierEdge = createBezierEdge({ isInternal: false });
/**
* @internal
*/
const BezierEdgeInternal = createBezierEdge({ isInternal: true });
BezierEdge.displayName = "BezierEdge";
BezierEdgeInternal.displayName = "BezierEdgeInternal";
const builtinEdgeTypes = {
	default: BezierEdgeInternal,
	straight: StraightEdgeInternal,
	step: StepEdgeInternal,
	smoothstep: SmoothStepEdgeInternal,
	simplebezier: SimpleBezierEdgeInternal
};
const nullPosition = {
	sourceX: null,
	sourceY: null,
	targetX: null,
	targetY: null,
	sourcePosition: null,
	targetPosition: null
};
const shiftX = (x, shift, position) => {
	if (position === Position.Left) return x - shift;
	if (position === Position.Right) return x + shift;
	return x;
};
const shiftY = (y, shift, position) => {
	if (position === Position.Top) return y - shift;
	if (position === Position.Bottom) return y + shift;
	return y;
};
const EdgeUpdaterClassName = "react-flow__edgeupdater";
/**
* @internal
*/
function EdgeAnchor({ position, centerX, centerY, radius = 10, onMouseDown, onMouseEnter, onMouseOut, type }) {
	return (0, import_jsx_runtime.jsx)("circle", {
		onMouseDown,
		onMouseEnter,
		onMouseOut,
		className: cc([EdgeUpdaterClassName, `${EdgeUpdaterClassName}-${type}`]),
		cx: shiftX(centerX, radius, position),
		cy: shiftY(centerY, radius, position),
		r: radius,
		stroke: "transparent",
		fill: "transparent"
	});
}
function EdgeUpdateAnchors({ isReconnectable, reconnectRadius, edge, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, onReconnect, onReconnectStart, onReconnectEnd, setReconnecting, setUpdateHover }) {
	const store = useStoreApi();
	const handleEdgeUpdater = (event, oppositeHandle) => {
		if (event.button !== 0) return;
		const { autoPanOnConnect, domNode, connectionMode, connectionRadius, lib, onConnectStart, cancelConnection, nodeLookup, rfId: flowId, panBy, updateConnection } = store.getState();
		const isTarget = oppositeHandle.type === "target";
		const _onReconnectEnd = (evt, connectionState) => {
			setReconnecting(false);
			onReconnectEnd?.(evt, edge, oppositeHandle.type, connectionState);
		};
		const onConnectEdge = (connection) => onReconnect?.(edge, connection);
		const _onConnectStart = (_event, params) => {
			setReconnecting(true);
			onReconnectStart?.(event, edge, oppositeHandle.type);
			onConnectStart?.(_event, params);
		};
		XYHandle.onPointerDown(event.nativeEvent, {
			autoPanOnConnect,
			connectionMode,
			connectionRadius,
			domNode,
			handleId: oppositeHandle.id,
			nodeId: oppositeHandle.nodeId,
			nodeLookup,
			isTarget,
			edgeUpdaterType: oppositeHandle.type,
			lib,
			flowId,
			cancelConnection,
			panBy,
			isValidConnection: (...args) => store.getState().isValidConnection?.(...args) ?? true,
			onConnect: onConnectEdge,
			onConnectStart: _onConnectStart,
			onConnectEnd: (...args) => store.getState().onConnectEnd?.(...args),
			onReconnectEnd: _onReconnectEnd,
			updateConnection,
			getTransform: () => store.getState().transform,
			getFromHandle: () => store.getState().connection.fromHandle,
			dragThreshold: store.getState().connectionDragThreshold,
			handleDomNode: event.currentTarget
		});
	};
	const onReconnectSourceMouseDown = (event) => handleEdgeUpdater(event, {
		nodeId: edge.target,
		id: edge.targetHandle ?? null,
		type: "target"
	});
	const onReconnectTargetMouseDown = (event) => handleEdgeUpdater(event, {
		nodeId: edge.source,
		id: edge.sourceHandle ?? null,
		type: "source"
	});
	const onReconnectMouseEnter = () => setUpdateHover(true);
	const onReconnectMouseOut = () => setUpdateHover(false);
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(isReconnectable === true || isReconnectable === "source") && (0, import_jsx_runtime.jsx)(EdgeAnchor, {
		position: sourcePosition,
		centerX: sourceX,
		centerY: sourceY,
		radius: reconnectRadius,
		onMouseDown: onReconnectSourceMouseDown,
		onMouseEnter: onReconnectMouseEnter,
		onMouseOut: onReconnectMouseOut,
		type: "source"
	}), (isReconnectable === true || isReconnectable === "target") && (0, import_jsx_runtime.jsx)(EdgeAnchor, {
		position: targetPosition,
		centerX: targetX,
		centerY: targetY,
		radius: reconnectRadius,
		onMouseDown: onReconnectTargetMouseDown,
		onMouseEnter: onReconnectMouseEnter,
		onMouseOut: onReconnectMouseOut,
		type: "target"
	})] });
}
function EdgeWrapper({ id, edgesFocusable, edgesReconnectable, elementsSelectable, onClick, onDoubleClick, onContextMenu, onMouseEnter, onMouseMove, onMouseLeave, reconnectRadius, onReconnect, onReconnectStart, onReconnectEnd, rfId, edgeTypes, noPanClassName, onError, disableKeyboardA11y }) {
	let edge = useStore((s) => s.edgeLookup.get(id));
	const defaultEdgeOptions = useStore((s) => s.defaultEdgeOptions);
	edge = defaultEdgeOptions ? {
		...defaultEdgeOptions,
		...edge
	} : edge;
	let edgeType = edge.type || "default";
	let EdgeComponent = edgeTypes?.[edgeType] || builtinEdgeTypes[edgeType];
	if (EdgeComponent === void 0) {
		onError?.("011", errorMessages["error011"](edgeType));
		edgeType = "default";
		EdgeComponent = edgeTypes?.["default"] || builtinEdgeTypes.default;
	}
	const isFocusable = !!(edge.focusable || edgesFocusable && typeof edge.focusable === "undefined");
	const isReconnectable = typeof onReconnect !== "undefined" && (edge.reconnectable || edgesReconnectable && typeof edge.reconnectable === "undefined");
	const isSelectable = !!(edge.selectable || elementsSelectable && typeof edge.selectable === "undefined");
	const edgeRef = useRef(null);
	const [updateHover, setUpdateHover] = useState(false);
	const [reconnecting, setReconnecting] = useState(false);
	const store = useStoreApi();
	const { zIndex, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = useStore(useCallback((store) => {
		const sourceNode = store.nodeLookup.get(edge.source);
		const targetNode = store.nodeLookup.get(edge.target);
		if (!sourceNode || !targetNode) return {
			zIndex: edge.zIndex,
			...nullPosition
		};
		const edgePosition = getEdgePosition({
			id,
			sourceNode,
			targetNode,
			sourceHandle: edge.sourceHandle || null,
			targetHandle: edge.targetHandle || null,
			connectionMode: store.connectionMode,
			onError
		});
		return {
			zIndex: getElevatedEdgeZIndex({
				selected: edge.selected,
				zIndex: edge.zIndex,
				sourceNode,
				targetNode,
				elevateOnSelect: store.elevateEdgesOnSelect,
				zIndexMode: store.zIndexMode
			}),
			...edgePosition || nullPosition
		};
	}, [
		edge.source,
		edge.target,
		edge.sourceHandle,
		edge.targetHandle,
		edge.selected,
		edge.zIndex
	]), shallow$1);
	const markerStartUrl = useMemo(() => edge.markerStart ? `url('#${getMarkerId(edge.markerStart, rfId)}')` : void 0, [edge.markerStart, rfId]);
	const markerEndUrl = useMemo(() => edge.markerEnd ? `url('#${getMarkerId(edge.markerEnd, rfId)}')` : void 0, [edge.markerEnd, rfId]);
	if (edge.hidden || sourceX === null || sourceY === null || targetX === null || targetY === null) return null;
	const onEdgeClick = (event) => {
		const { addSelectedEdges, unselectNodesAndEdges, multiSelectionActive } = store.getState();
		if (isSelectable) {
			store.setState({ nodesSelectionActive: false });
			if (edge.selected && multiSelectionActive) {
				unselectNodesAndEdges({
					nodes: [],
					edges: [edge]
				});
				edgeRef.current?.blur();
			} else addSelectedEdges([id]);
		}
		if (onClick) onClick(event, edge);
	};
	const onEdgeDoubleClick = onDoubleClick ? (event) => {
		onDoubleClick(event, { ...edge });
	} : void 0;
	const onEdgeContextMenu = onContextMenu ? (event) => {
		onContextMenu(event, { ...edge });
	} : void 0;
	const onEdgeMouseEnter = onMouseEnter ? (event) => {
		onMouseEnter(event, { ...edge });
	} : void 0;
	const onEdgeMouseMove = onMouseMove ? (event) => {
		onMouseMove(event, { ...edge });
	} : void 0;
	const onEdgeMouseLeave = onMouseLeave ? (event) => {
		onMouseLeave(event, { ...edge });
	} : void 0;
	const onKeyDown = (event) => {
		if (!disableKeyboardA11y && elementSelectionKeys.includes(event.key) && isSelectable) {
			const { unselectNodesAndEdges, addSelectedEdges } = store.getState();
			if (event.key === "Escape") {
				edgeRef.current?.blur();
				unselectNodesAndEdges({ edges: [edge] });
			} else addSelectedEdges([id]);
		}
	};
	return (0, import_jsx_runtime.jsx)("svg", {
		style: { zIndex },
		children: (0, import_jsx_runtime.jsxs)("g", {
			className: cc([
				"react-flow__edge",
				`react-flow__edge-${edgeType}`,
				edge.className,
				noPanClassName,
				{
					selected: edge.selected,
					animated: edge.animated,
					inactive: !isSelectable && !onClick,
					updating: updateHover,
					selectable: isSelectable
				}
			]),
			onClick: onEdgeClick,
			onDoubleClick: onEdgeDoubleClick,
			onContextMenu: onEdgeContextMenu,
			onMouseEnter: onEdgeMouseEnter,
			onMouseMove: onEdgeMouseMove,
			onMouseLeave: onEdgeMouseLeave,
			onKeyDown: isFocusable ? onKeyDown : void 0,
			tabIndex: isFocusable ? 0 : void 0,
			role: edge.ariaRole ?? (isFocusable ? "group" : "img"),
			"aria-roledescription": "edge",
			"data-id": id,
			"data-testid": `rf__edge-${id}`,
			"aria-label": edge.ariaLabel === null ? void 0 : edge.ariaLabel || `Edge from ${edge.source} to ${edge.target}`,
			"aria-describedby": isFocusable ? `${ARIA_EDGE_DESC_KEY}-${rfId}` : void 0,
			ref: edgeRef,
			...edge.domAttributes,
			children: [!reconnecting && (0, import_jsx_runtime.jsx)(EdgeComponent, {
				id,
				source: edge.source,
				target: edge.target,
				type: edge.type,
				selected: edge.selected,
				animated: edge.animated,
				selectable: isSelectable,
				deletable: edge.deletable ?? true,
				label: edge.label,
				labelStyle: edge.labelStyle,
				labelShowBg: edge.labelShowBg,
				labelBgStyle: edge.labelBgStyle,
				labelBgPadding: edge.labelBgPadding,
				labelBgBorderRadius: edge.labelBgBorderRadius,
				sourceX,
				sourceY,
				targetX,
				targetY,
				sourcePosition,
				targetPosition,
				data: edge.data,
				style: edge.style,
				sourceHandleId: edge.sourceHandle,
				targetHandleId: edge.targetHandle,
				markerStart: markerStartUrl,
				markerEnd: markerEndUrl,
				pathOptions: "pathOptions" in edge ? edge.pathOptions : void 0,
				interactionWidth: edge.interactionWidth
			}), isReconnectable && (0, import_jsx_runtime.jsx)(EdgeUpdateAnchors, {
				edge,
				isReconnectable,
				reconnectRadius,
				onReconnect,
				onReconnectStart,
				onReconnectEnd,
				sourceX,
				sourceY,
				targetX,
				targetY,
				sourcePosition,
				targetPosition,
				setUpdateHover,
				setReconnecting
			})]
		})
	});
}
var EdgeWrapper$1 = memo(EdgeWrapper);
const selector$a = (s) => ({
	edgesFocusable: s.edgesFocusable,
	edgesReconnectable: s.edgesReconnectable,
	elementsSelectable: s.elementsSelectable,
	connectionMode: s.connectionMode,
	onError: s.onError
});
function EdgeRendererComponent({ defaultMarkerColor, onlyRenderVisibleElements, rfId, edgeTypes, noPanClassName, onReconnect, onEdgeContextMenu, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave, onEdgeClick, reconnectRadius, onEdgeDoubleClick, onReconnectStart, onReconnectEnd, disableKeyboardA11y }) {
	const { edgesFocusable, edgesReconnectable, elementsSelectable, onError } = useStore(selector$a, shallow$1);
	const edgeIds = useVisibleEdgeIds(onlyRenderVisibleElements);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "react-flow__edges",
		children: [(0, import_jsx_runtime.jsx)(MarkerDefinitions$1, {
			defaultColor: defaultMarkerColor,
			rfId
		}), edgeIds.map((id) => {
			return (0, import_jsx_runtime.jsx)(EdgeWrapper$1, {
				id,
				edgesFocusable,
				edgesReconnectable,
				elementsSelectable,
				noPanClassName,
				onReconnect,
				onContextMenu: onEdgeContextMenu,
				onMouseEnter: onEdgeMouseEnter,
				onMouseMove: onEdgeMouseMove,
				onMouseLeave: onEdgeMouseLeave,
				onClick: onEdgeClick,
				reconnectRadius,
				onDoubleClick: onEdgeDoubleClick,
				onReconnectStart,
				onReconnectEnd,
				rfId,
				onError,
				edgeTypes,
				disableKeyboardA11y
			}, id);
		})]
	});
}
EdgeRendererComponent.displayName = "EdgeRenderer";
const EdgeRenderer = memo(EdgeRendererComponent);
const selector$9 = (s) => `translate(${s.transform[0]}px,${s.transform[1]}px) scale(${s.transform[2]})`;
function Viewport({ children }) {
	return (0, import_jsx_runtime.jsx)("div", {
		className: "react-flow__viewport xyflow__viewport react-flow__container",
		style: { transform: useStore(selector$9) },
		children
	});
}
/**
* Hook for calling onInit handler.
*
* @internal
*/
function useOnInitHandler(onInit) {
	const rfInstance = useReactFlow();
	const isInitialized = useRef(false);
	useEffect(() => {
		if (!isInitialized.current && rfInstance.viewportInitialized && onInit) {
			setTimeout(() => onInit(rfInstance), 1);
			isInitialized.current = true;
		}
	}, [onInit, rfInstance.viewportInitialized]);
}
const selector$8 = (state) => state.panZoom?.syncViewport;
/**
* Hook for syncing the viewport with the panzoom instance.
*
* @internal
* @param viewport
*/
function useViewportSync(viewport) {
	const syncViewport = useStore(selector$8);
	const store = useStoreApi();
	useEffect(() => {
		if (viewport) {
			syncViewport?.(viewport);
			store.setState({ transform: [
				viewport.x,
				viewport.y,
				viewport.zoom
			] });
		}
	}, [viewport, syncViewport]);
	return null;
}
function storeSelector$1(s) {
	return s.connection.inProgress ? {
		...s.connection,
		to: pointToRendererPoint(s.connection.to, s.transform)
	} : { ...s.connection };
}
function getSelector(connectionSelector) {
	if (connectionSelector) {
		const combinedSelector = (s) => {
			return connectionSelector(storeSelector$1(s));
		};
		return combinedSelector;
	}
	return storeSelector$1;
}
/**
* The `useConnection` hook returns the current connection when there is an active
* connection interaction. If no connection interaction is active, it returns null
* for every property. A typical use case for this hook is to colorize handles
* based on a certain condition (e.g. if the connection is valid or not).
*
* @public
* @param connectionSelector - An optional selector function used to extract a slice of the
* `ConnectionState` data. Using a selector can prevent component re-renders where data you don't
* otherwise care about might change. If a selector is not provided, the entire `ConnectionState`
* object is returned unchanged.
* @example
*
* ```tsx
*import { useConnection } from '@xyflow/react';
*
*function App() {
*  const connection = useConnection();
*
*  return (
*    <div> {connection ? `Someone is trying to make a connection from ${connection.fromNode} to this one.` : 'There are currently no incoming connections!'}
*
*   </div>
*   );
* }
* ```
*
* @returns ConnectionState
*/
function useConnection(connectionSelector) {
	return useStore(getSelector(connectionSelector), shallow$1);
}
const selector$7 = (s) => ({
	nodesConnectable: s.nodesConnectable,
	isValid: s.connection.isValid,
	inProgress: s.connection.inProgress,
	width: s.width,
	height: s.height
});
function ConnectionLineWrapper({ containerStyle, style, type, component }) {
	const { nodesConnectable, width, height, isValid, inProgress } = useStore(selector$7, shallow$1);
	if (!!!(width && nodesConnectable && inProgress)) return null;
	return (0, import_jsx_runtime.jsx)("svg", {
		style: containerStyle,
		width,
		height,
		className: "react-flow__connectionline react-flow__container",
		children: (0, import_jsx_runtime.jsx)("g", {
			className: cc(["react-flow__connection", getConnectionStatus(isValid)]),
			children: (0, import_jsx_runtime.jsx)(ConnectionLine, {
				style,
				type,
				CustomComponent: component,
				isValid
			})
		})
	});
}
const ConnectionLine = ({ style, type = ConnectionLineType.Bezier, CustomComponent, isValid }) => {
	const { inProgress, from, fromNode, fromHandle, fromPosition, to, toNode, toHandle, toPosition, pointer } = useConnection();
	if (!inProgress) return;
	if (CustomComponent) return (0, import_jsx_runtime.jsx)(CustomComponent, {
		connectionLineType: type,
		connectionLineStyle: style,
		fromNode,
		fromHandle,
		fromX: from.x,
		fromY: from.y,
		toX: to.x,
		toY: to.y,
		fromPosition,
		toPosition,
		connectionStatus: getConnectionStatus(isValid),
		toNode,
		toHandle,
		pointer
	});
	let path = "";
	const pathParams = {
		sourceX: from.x,
		sourceY: from.y,
		sourcePosition: fromPosition,
		targetX: to.x,
		targetY: to.y,
		targetPosition: toPosition
	};
	switch (type) {
		case ConnectionLineType.Bezier:
			[path] = getBezierPath(pathParams);
			break;
		case ConnectionLineType.SimpleBezier:
			[path] = getSimpleBezierPath(pathParams);
			break;
		case ConnectionLineType.Step:
			[path] = getSmoothStepPath({
				...pathParams,
				borderRadius: 0
			});
			break;
		case ConnectionLineType.SmoothStep:
			[path] = getSmoothStepPath(pathParams);
			break;
		default: [path] = getStraightPath(pathParams);
	}
	return (0, import_jsx_runtime.jsx)("path", {
		d: path,
		fill: "none",
		className: "react-flow__connection-path",
		style
	});
};
ConnectionLine.displayName = "ConnectionLine";
const emptyTypes = {};
function useNodeOrEdgeTypesWarning(nodeOrEdgeTypes = emptyTypes) {
	useRef(nodeOrEdgeTypes);
	useStoreApi();
	useEffect(() => {}, [nodeOrEdgeTypes]);
}
function useStylesLoadedWarning() {
	useStoreApi();
	useRef(false);
	useEffect(() => {}, []);
}
function GraphViewComponent({ nodeTypes, edgeTypes, onInit, onNodeClick, onEdgeClick, onNodeDoubleClick, onEdgeDoubleClick, onNodeMouseEnter, onNodeMouseMove, onNodeMouseLeave, onNodeContextMenu, onSelectionContextMenu, onSelectionStart, onSelectionEnd, connectionLineType, connectionLineStyle, connectionLineComponent, connectionLineContainerStyle, selectionKeyCode, selectionOnDrag, selectionMode, multiSelectionKeyCode, panActivationKeyCode, zoomActivationKeyCode, deleteKeyCode, onlyRenderVisibleElements, elementsSelectable, defaultViewport, translateExtent, minZoom, maxZoom, preventScrolling, defaultMarkerColor, zoomOnScroll, zoomOnPinch, panOnScroll, panOnScrollSpeed, panOnScrollMode, zoomOnDoubleClick, panOnDrag, onPaneClick, onPaneMouseEnter, onPaneMouseMove, onPaneMouseLeave, onPaneScroll, onPaneContextMenu, paneClickDistance, nodeClickDistance, onEdgeContextMenu, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave, reconnectRadius, onReconnect, onReconnectStart, onReconnectEnd, noDragClassName, noWheelClassName, noPanClassName, disableKeyboardA11y, nodeExtent, rfId, viewport, onViewportChange }) {
	useNodeOrEdgeTypesWarning(nodeTypes);
	useNodeOrEdgeTypesWarning(edgeTypes);
	useStylesLoadedWarning();
	useOnInitHandler(onInit);
	useViewportSync(viewport);
	return (0, import_jsx_runtime.jsx)(FlowRenderer, {
		onPaneClick,
		onPaneMouseEnter,
		onPaneMouseMove,
		onPaneMouseLeave,
		onPaneContextMenu,
		onPaneScroll,
		paneClickDistance,
		deleteKeyCode,
		selectionKeyCode,
		selectionOnDrag,
		selectionMode,
		onSelectionStart,
		onSelectionEnd,
		multiSelectionKeyCode,
		panActivationKeyCode,
		zoomActivationKeyCode,
		elementsSelectable,
		zoomOnScroll,
		zoomOnPinch,
		zoomOnDoubleClick,
		panOnScroll,
		panOnScrollSpeed,
		panOnScrollMode,
		panOnDrag,
		defaultViewport,
		translateExtent,
		minZoom,
		maxZoom,
		onSelectionContextMenu,
		preventScrolling,
		noDragClassName,
		noWheelClassName,
		noPanClassName,
		disableKeyboardA11y,
		onViewportChange,
		isControlledViewport: !!viewport,
		children: (0, import_jsx_runtime.jsxs)(Viewport, { children: [
			(0, import_jsx_runtime.jsx)(EdgeRenderer, {
				edgeTypes,
				onEdgeClick,
				onEdgeDoubleClick,
				onReconnect,
				onReconnectStart,
				onReconnectEnd,
				onlyRenderVisibleElements,
				onEdgeContextMenu,
				onEdgeMouseEnter,
				onEdgeMouseMove,
				onEdgeMouseLeave,
				reconnectRadius,
				defaultMarkerColor,
				noPanClassName,
				disableKeyboardA11y,
				rfId
			}),
			(0, import_jsx_runtime.jsx)(ConnectionLineWrapper, {
				style: connectionLineStyle,
				type: connectionLineType,
				component: connectionLineComponent,
				containerStyle: connectionLineContainerStyle
			}),
			(0, import_jsx_runtime.jsx)("div", { className: "react-flow__edgelabel-renderer" }),
			(0, import_jsx_runtime.jsx)(NodeRenderer, {
				nodeTypes,
				onNodeClick,
				onNodeDoubleClick,
				onNodeMouseEnter,
				onNodeMouseMove,
				onNodeMouseLeave,
				onNodeContextMenu,
				nodeClickDistance,
				onlyRenderVisibleElements,
				noPanClassName,
				noDragClassName,
				disableKeyboardA11y,
				nodeExtent,
				rfId
			}),
			(0, import_jsx_runtime.jsx)("div", { className: "react-flow__viewport-portal" })
		] })
	});
}
GraphViewComponent.displayName = "GraphView";
const GraphView = memo(GraphViewComponent);
const getInitialState = ({ nodes, edges, defaultNodes, defaultEdges, width, height, fitView, fitViewOptions, minZoom = .5, maxZoom = 2, nodeOrigin, nodeExtent, zIndexMode = "basic" } = {}) => {
	const nodeLookup = /* @__PURE__ */ new Map();
	const parentLookup = /* @__PURE__ */ new Map();
	const connectionLookup = /* @__PURE__ */ new Map();
	const edgeLookup = /* @__PURE__ */ new Map();
	const storeEdges = defaultEdges ?? edges ?? [];
	const storeNodes = defaultNodes ?? nodes ?? [];
	const storeNodeOrigin = nodeOrigin ?? [0, 0];
	const storeNodeExtent = nodeExtent ?? infiniteExtent;
	updateConnectionLookup(connectionLookup, edgeLookup, storeEdges);
	const { nodesInitialized } = adoptUserNodes(storeNodes, nodeLookup, parentLookup, {
		nodeOrigin: storeNodeOrigin,
		nodeExtent: storeNodeExtent,
		zIndexMode
	});
	let transform = [
		0,
		0,
		1
	];
	if (fitView && width && height) {
		const { x, y, zoom } = getViewportForBounds(getInternalNodesBounds(nodeLookup, { filter: (node) => !!((node.width || node.initialWidth) && (node.height || node.initialHeight)) }), width, height, minZoom, maxZoom, fitViewOptions?.padding ?? .1);
		transform = [
			x,
			y,
			zoom
		];
	}
	return {
		rfId: "1",
		width: width ?? 0,
		height: height ?? 0,
		transform,
		nodes: storeNodes,
		nodesInitialized,
		nodeLookup,
		parentLookup,
		edges: storeEdges,
		edgeLookup,
		connectionLookup,
		onNodesChange: null,
		onEdgesChange: null,
		hasDefaultNodes: defaultNodes !== void 0,
		hasDefaultEdges: defaultEdges !== void 0,
		panZoom: null,
		minZoom,
		maxZoom,
		translateExtent: infiniteExtent,
		nodeExtent: storeNodeExtent,
		nodesSelectionActive: false,
		userSelectionActive: false,
		userSelectionRect: null,
		connectionMode: ConnectionMode.Strict,
		domNode: null,
		paneDragging: false,
		noPanClassName: "nopan",
		nodeOrigin: storeNodeOrigin,
		nodeDragThreshold: 1,
		connectionDragThreshold: 1,
		snapGrid: [15, 15],
		snapToGrid: false,
		nodesDraggable: true,
		nodesConnectable: true,
		nodesFocusable: true,
		edgesFocusable: true,
		edgesReconnectable: true,
		elementsSelectable: true,
		elevateNodesOnSelect: true,
		elevateEdgesOnSelect: true,
		selectNodesOnDrag: true,
		multiSelectionActive: false,
		fitViewQueued: fitView ?? false,
		fitViewOptions,
		fitViewResolver: null,
		connection: { ...initialConnection },
		connectionClickStartHandle: null,
		connectOnClick: true,
		ariaLiveMessage: "",
		autoPanOnConnect: true,
		autoPanOnNodeDrag: true,
		autoPanOnNodeFocus: true,
		autoPanSpeed: 15,
		connectionRadius: 20,
		onError: devWarn,
		isValidConnection: void 0,
		onSelectionChangeHandlers: [],
		lib: "react",
		debug: false,
		ariaLabelConfig: defaultAriaLabelConfig,
		zIndexMode,
		onNodesChangeMiddlewareMap: /* @__PURE__ */ new Map(),
		onEdgesChangeMiddlewareMap: /* @__PURE__ */ new Map()
	};
};
const createStore = ({ nodes, edges, defaultNodes, defaultEdges, width, height, fitView, fitViewOptions, minZoom, maxZoom, nodeOrigin, nodeExtent, zIndexMode }) => createWithEqualityFn((set, get) => {
	async function resolveFitView() {
		const { nodeLookup, panZoom, fitViewOptions, fitViewResolver, width, height, minZoom, maxZoom } = get();
		if (!panZoom) return;
		await fitViewport({
			nodes: nodeLookup,
			width,
			height,
			panZoom,
			minZoom,
			maxZoom
		}, fitViewOptions);
		fitViewResolver?.resolve(true);
		/**
		* wait for the fitViewport to resolve before deleting the resolver,
		* we want to reuse the old resolver if the user calls fitView again in the mean time
		*/
		set({ fitViewResolver: null });
	}
	return {
		...getInitialState({
			nodes,
			edges,
			width,
			height,
			fitView,
			fitViewOptions,
			minZoom,
			maxZoom,
			nodeOrigin,
			nodeExtent,
			defaultNodes,
			defaultEdges,
			zIndexMode
		}),
		setNodes: (nodes) => {
			const { nodeLookup, parentLookup, nodeOrigin, elevateNodesOnSelect, fitViewQueued, zIndexMode, nodesSelectionActive } = get();
			const { nodesInitialized, hasSelectedNodes } = adoptUserNodes(nodes, nodeLookup, parentLookup, {
				nodeOrigin,
				nodeExtent,
				elevateNodesOnSelect,
				checkEquality: true,
				zIndexMode
			});
			const nextNodesSelectionActive = nodesSelectionActive && hasSelectedNodes;
			if (fitViewQueued && nodesInitialized) {
				resolveFitView();
				set({
					nodes,
					nodesInitialized,
					fitViewQueued: false,
					fitViewOptions: void 0,
					nodesSelectionActive: nextNodesSelectionActive
				});
			} else set({
				nodes,
				nodesInitialized,
				nodesSelectionActive: nextNodesSelectionActive
			});
		},
		setEdges: (edges) => {
			const { connectionLookup, edgeLookup } = get();
			updateConnectionLookup(connectionLookup, edgeLookup, edges);
			set({ edges });
		},
		setDefaultNodesAndEdges: (nodes, edges) => {
			if (nodes) {
				const { setNodes } = get();
				setNodes(nodes);
				set({ hasDefaultNodes: true });
			}
			if (edges) {
				const { setEdges } = get();
				setEdges(edges);
				set({ hasDefaultEdges: true });
			}
		},
		updateNodeInternals: (updates) => {
			const { triggerNodeChanges, nodeLookup, parentLookup, domNode, nodeOrigin, nodeExtent, debug, fitViewQueued, zIndexMode } = get();
			const { changes, updatedInternals } = updateNodeInternals(updates, nodeLookup, parentLookup, domNode, nodeOrigin, nodeExtent, zIndexMode);
			if (!updatedInternals) return;
			updateAbsolutePositions(nodeLookup, parentLookup, {
				nodeOrigin,
				nodeExtent,
				zIndexMode
			});
			if (fitViewQueued) {
				resolveFitView();
				set({
					fitViewQueued: false,
					fitViewOptions: void 0
				});
			} else set({});
			if (changes?.length > 0) {
				if (debug) console.log("React Flow: trigger node changes", changes);
				triggerNodeChanges?.(changes);
			}
		},
		updateNodePositions: (nodeDragItems, dragging = false) => {
			const parentExpandChildren = [];
			let changes = [];
			const { nodeLookup, triggerNodeChanges, connection, updateConnection, onNodesChangeMiddlewareMap } = get();
			for (const [id, dragItem] of nodeDragItems) {
				const node = nodeLookup.get(id);
				const expandParent = !!(node?.expandParent && node?.parentId && dragItem?.position);
				const change = {
					id,
					type: "position",
					position: expandParent ? {
						x: Math.max(0, dragItem.position.x),
						y: Math.max(0, dragItem.position.y)
					} : dragItem.position,
					dragging
				};
				if (node && connection.inProgress && connection.fromNode.id === node.id) {
					const updatedFrom = getHandlePosition(node, connection.fromHandle, Position.Left, true);
					updateConnection({
						...connection,
						from: updatedFrom
					});
				}
				if (expandParent && node.parentId) parentExpandChildren.push({
					id,
					parentId: node.parentId,
					rect: {
						...dragItem.internals.positionAbsolute,
						width: dragItem.measured.width ?? 0,
						height: dragItem.measured.height ?? 0
					}
				});
				changes.push(change);
			}
			if (parentExpandChildren.length > 0) {
				const { parentLookup, nodeOrigin } = get();
				const parentExpandChanges = handleExpandParent(parentExpandChildren, nodeLookup, parentLookup, nodeOrigin);
				changes.push(...parentExpandChanges);
			}
			for (const middleware of onNodesChangeMiddlewareMap.values()) changes = middleware(changes);
			triggerNodeChanges(changes);
		},
		triggerNodeChanges: (changes) => {
			const { onNodesChange, setNodes, nodes, hasDefaultNodes, debug } = get();
			if (changes?.length) {
				if (hasDefaultNodes) setNodes(applyNodeChanges(changes, nodes));
				if (debug) console.log("React Flow: trigger node changes", changes);
				onNodesChange?.(changes);
			}
		},
		triggerEdgeChanges: (changes) => {
			const { onEdgesChange, setEdges, edges, hasDefaultEdges, debug } = get();
			if (changes?.length) {
				if (hasDefaultEdges) setEdges(applyEdgeChanges(changes, edges));
				if (debug) console.log("React Flow: trigger edge changes", changes);
				onEdgesChange?.(changes);
			}
		},
		addSelectedNodes: (selectedNodeIds) => {
			const { multiSelectionActive, edgeLookup, nodeLookup, triggerNodeChanges, triggerEdgeChanges } = get();
			if (multiSelectionActive) {
				triggerNodeChanges(selectedNodeIds.map((nodeId) => createSelectionChange(nodeId, true)));
				return;
			}
			triggerNodeChanges(getSelectionChanges(nodeLookup, new Set([...selectedNodeIds]), true));
			triggerEdgeChanges(getSelectionChanges(edgeLookup));
		},
		addSelectedEdges: (selectedEdgeIds) => {
			const { multiSelectionActive, edgeLookup, nodeLookup, triggerNodeChanges, triggerEdgeChanges } = get();
			if (multiSelectionActive) {
				triggerEdgeChanges(selectedEdgeIds.map((edgeId) => createSelectionChange(edgeId, true)));
				return;
			}
			triggerEdgeChanges(getSelectionChanges(edgeLookup, new Set([...selectedEdgeIds])));
			triggerNodeChanges(getSelectionChanges(nodeLookup, /* @__PURE__ */ new Set(), true));
		},
		unselectNodesAndEdges: ({ nodes, edges } = {}) => {
			const { edges: storeEdges, nodes: storeNodes, nodeLookup, triggerNodeChanges, triggerEdgeChanges } = get();
			const nodesToUnselect = nodes ? nodes : storeNodes;
			const edgesToUnselect = edges ? edges : storeEdges;
			const nodeChanges = [];
			for (const node of nodesToUnselect) {
				if (!node.selected) continue;
				const internalNode = nodeLookup.get(node.id);
				if (internalNode) internalNode.selected = false;
				nodeChanges.push(createSelectionChange(node.id, false));
			}
			const edgeChanges = [];
			for (const edge of edgesToUnselect) {
				if (!edge.selected) continue;
				edgeChanges.push(createSelectionChange(edge.id, false));
			}
			triggerNodeChanges(nodeChanges);
			triggerEdgeChanges(edgeChanges);
		},
		setMinZoom: (minZoom) => {
			const { panZoom, maxZoom } = get();
			panZoom?.setScaleExtent([minZoom, maxZoom]);
			set({ minZoom });
		},
		setMaxZoom: (maxZoom) => {
			const { panZoom, minZoom } = get();
			panZoom?.setScaleExtent([minZoom, maxZoom]);
			set({ maxZoom });
		},
		setTranslateExtent: (translateExtent) => {
			get().panZoom?.setTranslateExtent(translateExtent);
			set({ translateExtent });
		},
		resetSelectedElements: () => {
			const { edges, nodes, triggerNodeChanges, triggerEdgeChanges, elementsSelectable } = get();
			if (!elementsSelectable) return;
			const nodeChanges = nodes.reduce((res, node) => node.selected ? [...res, createSelectionChange(node.id, false)] : res, []);
			const edgeChanges = edges.reduce((res, edge) => edge.selected ? [...res, createSelectionChange(edge.id, false)] : res, []);
			triggerNodeChanges(nodeChanges);
			triggerEdgeChanges(edgeChanges);
		},
		setNodeExtent: (nextNodeExtent) => {
			const { nodes, nodeLookup, parentLookup, nodeOrigin, elevateNodesOnSelect, nodeExtent, zIndexMode } = get();
			if (nextNodeExtent[0][0] === nodeExtent[0][0] && nextNodeExtent[0][1] === nodeExtent[0][1] && nextNodeExtent[1][0] === nodeExtent[1][0] && nextNodeExtent[1][1] === nodeExtent[1][1]) return;
			adoptUserNodes(nodes, nodeLookup, parentLookup, {
				nodeOrigin,
				nodeExtent: nextNodeExtent,
				elevateNodesOnSelect,
				checkEquality: false,
				zIndexMode
			});
			set({ nodeExtent: nextNodeExtent });
		},
		panBy: (delta) => {
			const { transform, width, height, panZoom, translateExtent } = get();
			return panBy({
				delta,
				panZoom,
				transform,
				translateExtent,
				width,
				height
			});
		},
		setCenter: async (x, y, options) => {
			const { width, height, maxZoom, panZoom } = get();
			if (!panZoom) return Promise.resolve(false);
			const nextZoom = typeof options?.zoom !== "undefined" ? options.zoom : maxZoom;
			await panZoom.setViewport({
				x: width / 2 - x * nextZoom,
				y: height / 2 - y * nextZoom,
				zoom: nextZoom
			}, {
				duration: options?.duration,
				ease: options?.ease,
				interpolate: options?.interpolate
			});
			return Promise.resolve(true);
		},
		cancelConnection: () => {
			set({ connection: { ...initialConnection } });
		},
		updateConnection: (connection) => {
			set({ connection });
		},
		reset: () => set({ ...getInitialState() })
	};
}, Object.is);
/**
* The `<ReactFlowProvider />` component is a [context provider](https://react.dev/learn/passing-data-deeply-with-context#)
* that makes it possible to access a flow's internal state outside of the
* [`<ReactFlow />`](/api-reference/react-flow) component. Many of the hooks we
* provide rely on this component to work.
* @public
*
* @example
* ```tsx
*import { ReactFlow, ReactFlowProvider, useNodes } from '@xyflow/react'
*
*export default function Flow() {
*  return (
*    <ReactFlowProvider>
*      <ReactFlow nodes={...} edges={...} />
*      <Sidebar />
*    </ReactFlowProvider>
*  );
*}
*
*function Sidebar() {
*  // This hook will only work if the component it's used in is a child of a
*  // <ReactFlowProvider />.
*  const nodes = useNodes()
*
*  return <aside>do something with nodes</aside>;
*}
*```
*
* @remarks If you're using a router and want your flow's state to persist across routes,
* it's vital that you place the `<ReactFlowProvider />` component _outside_ of
* your router. If you have multiple flows on the same page you will need to use a separate
* `<ReactFlowProvider />` for each flow.
*/
function ReactFlowProvider({ initialNodes: nodes, initialEdges: edges, defaultNodes, defaultEdges, initialWidth: width, initialHeight: height, initialMinZoom: minZoom, initialMaxZoom: maxZoom, initialFitViewOptions: fitViewOptions, fitView, nodeOrigin, nodeExtent, zIndexMode, children }) {
	const [store] = useState(() => createStore({
		nodes,
		edges,
		defaultNodes,
		defaultEdges,
		width,
		height,
		fitView,
		minZoom,
		maxZoom,
		fitViewOptions,
		nodeOrigin,
		nodeExtent,
		zIndexMode
	}));
	return (0, import_jsx_runtime.jsx)(Provider$1, {
		value: store,
		children: (0, import_jsx_runtime.jsx)(BatchProvider, { children })
	});
}
function Wrapper({ children, nodes, edges, defaultNodes, defaultEdges, width, height, fitView, fitViewOptions, minZoom, maxZoom, nodeOrigin, nodeExtent, zIndexMode }) {
	if (useContext(StoreContext)) return (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children });
	return (0, import_jsx_runtime.jsx)(ReactFlowProvider, {
		initialNodes: nodes,
		initialEdges: edges,
		defaultNodes,
		defaultEdges,
		initialWidth: width,
		initialHeight: height,
		fitView,
		initialFitViewOptions: fitViewOptions,
		initialMinZoom: minZoom,
		initialMaxZoom: maxZoom,
		nodeOrigin,
		nodeExtent,
		zIndexMode,
		children
	});
}
const wrapperStyle = {
	width: "100%",
	height: "100%",
	overflow: "hidden",
	position: "relative",
	zIndex: 0
};
function ReactFlow({ nodes, edges, defaultNodes, defaultEdges, className, nodeTypes, edgeTypes, onNodeClick, onEdgeClick, onInit, onMove, onMoveStart, onMoveEnd, onConnect, onConnectStart, onConnectEnd, onClickConnectStart, onClickConnectEnd, onNodeMouseEnter, onNodeMouseMove, onNodeMouseLeave, onNodeContextMenu, onNodeDoubleClick, onNodeDragStart, onNodeDrag, onNodeDragStop, onNodesDelete, onEdgesDelete, onDelete, onSelectionChange, onSelectionDragStart, onSelectionDrag, onSelectionDragStop, onSelectionContextMenu, onSelectionStart, onSelectionEnd, onBeforeDelete, connectionMode, connectionLineType = ConnectionLineType.Bezier, connectionLineStyle, connectionLineComponent, connectionLineContainerStyle, deleteKeyCode = "Backspace", selectionKeyCode = "Shift", selectionOnDrag = false, selectionMode = SelectionMode.Full, panActivationKeyCode = "Space", multiSelectionKeyCode = isMacOs() ? "Meta" : "Control", zoomActivationKeyCode = isMacOs() ? "Meta" : "Control", snapToGrid, snapGrid, onlyRenderVisibleElements = false, selectNodesOnDrag, nodesDraggable, autoPanOnNodeFocus, nodesConnectable, nodesFocusable, nodeOrigin = defaultNodeOrigin, edgesFocusable, edgesReconnectable, elementsSelectable = true, defaultViewport: defaultViewport$1 = defaultViewport, minZoom = .5, maxZoom = 2, translateExtent = infiniteExtent, preventScrolling = true, nodeExtent, defaultMarkerColor = "#b1b1b7", zoomOnScroll = true, zoomOnPinch = true, panOnScroll = false, panOnScrollSpeed = .5, panOnScrollMode = PanOnScrollMode.Free, zoomOnDoubleClick = true, panOnDrag = true, onPaneClick, onPaneMouseEnter, onPaneMouseMove, onPaneMouseLeave, onPaneScroll, onPaneContextMenu, paneClickDistance = 1, nodeClickDistance = 0, children, onReconnect, onReconnectStart, onReconnectEnd, onEdgeContextMenu, onEdgeDoubleClick, onEdgeMouseEnter, onEdgeMouseMove, onEdgeMouseLeave, reconnectRadius = 10, onNodesChange, onEdgesChange, noDragClassName = "nodrag", noWheelClassName = "nowheel", noPanClassName = "nopan", fitView, fitViewOptions, connectOnClick, attributionPosition, proOptions, defaultEdgeOptions, elevateNodesOnSelect = true, elevateEdgesOnSelect = false, disableKeyboardA11y = false, autoPanOnConnect, autoPanOnNodeDrag, autoPanSpeed, connectionRadius, isValidConnection, onError, style, id, nodeDragThreshold, connectionDragThreshold, viewport, onViewportChange, width, height, colorMode = "light", debug, onScroll, ariaLabelConfig, zIndexMode = "basic", ...rest }, ref) {
	const rfId = id || "1";
	const colorModeClassName = useColorModeClass(colorMode);
	const wrapperOnScroll = useCallback((e) => {
		e.currentTarget.scrollTo({
			top: 0,
			left: 0,
			behavior: "instant"
		});
		onScroll?.(e);
	}, [onScroll]);
	return (0, import_jsx_runtime.jsx)("div", {
		"data-testid": "rf__wrapper",
		...rest,
		onScroll: wrapperOnScroll,
		style: {
			...style,
			...wrapperStyle
		},
		ref,
		className: cc([
			"react-flow",
			className,
			colorModeClassName
		]),
		id,
		role: "application",
		children: (0, import_jsx_runtime.jsxs)(Wrapper, {
			nodes,
			edges,
			width,
			height,
			fitView,
			fitViewOptions,
			minZoom,
			maxZoom,
			nodeOrigin,
			nodeExtent,
			zIndexMode,
			children: [
				(0, import_jsx_runtime.jsx)(StoreUpdater, {
					nodes,
					edges,
					defaultNodes,
					defaultEdges,
					onConnect,
					onConnectStart,
					onConnectEnd,
					onClickConnectStart,
					onClickConnectEnd,
					nodesDraggable,
					autoPanOnNodeFocus,
					nodesConnectable,
					nodesFocusable,
					edgesFocusable,
					edgesReconnectable,
					elementsSelectable,
					elevateNodesOnSelect,
					elevateEdgesOnSelect,
					minZoom,
					maxZoom,
					nodeExtent,
					onNodesChange,
					onEdgesChange,
					snapToGrid,
					snapGrid,
					connectionMode,
					translateExtent,
					connectOnClick,
					defaultEdgeOptions,
					fitView,
					fitViewOptions,
					onNodesDelete,
					onEdgesDelete,
					onDelete,
					onNodeDragStart,
					onNodeDrag,
					onNodeDragStop,
					onSelectionDrag,
					onSelectionDragStart,
					onSelectionDragStop,
					onMove,
					onMoveStart,
					onMoveEnd,
					noPanClassName,
					nodeOrigin,
					rfId,
					autoPanOnConnect,
					autoPanOnNodeDrag,
					autoPanSpeed,
					onError,
					connectionRadius,
					isValidConnection,
					selectNodesOnDrag,
					nodeDragThreshold,
					connectionDragThreshold,
					onBeforeDelete,
					debug,
					ariaLabelConfig,
					zIndexMode
				}),
				(0, import_jsx_runtime.jsx)(GraphView, {
					onInit,
					onNodeClick,
					onEdgeClick,
					onNodeMouseEnter,
					onNodeMouseMove,
					onNodeMouseLeave,
					onNodeContextMenu,
					onNodeDoubleClick,
					nodeTypes,
					edgeTypes,
					connectionLineType,
					connectionLineStyle,
					connectionLineComponent,
					connectionLineContainerStyle,
					selectionKeyCode,
					selectionOnDrag,
					selectionMode,
					deleteKeyCode,
					multiSelectionKeyCode,
					panActivationKeyCode,
					zoomActivationKeyCode,
					onlyRenderVisibleElements,
					defaultViewport: defaultViewport$1,
					translateExtent,
					minZoom,
					maxZoom,
					preventScrolling,
					zoomOnScroll,
					zoomOnPinch,
					zoomOnDoubleClick,
					panOnScroll,
					panOnScrollSpeed,
					panOnScrollMode,
					panOnDrag,
					onPaneClick,
					onPaneMouseEnter,
					onPaneMouseMove,
					onPaneMouseLeave,
					onPaneScroll,
					onPaneContextMenu,
					paneClickDistance,
					nodeClickDistance,
					onSelectionContextMenu,
					onSelectionStart,
					onSelectionEnd,
					onReconnect,
					onReconnectStart,
					onReconnectEnd,
					onEdgeContextMenu,
					onEdgeDoubleClick,
					onEdgeMouseEnter,
					onEdgeMouseMove,
					onEdgeMouseLeave,
					reconnectRadius,
					defaultMarkerColor,
					noDragClassName,
					noWheelClassName,
					noPanClassName,
					rfId,
					disableKeyboardA11y,
					nodeExtent,
					viewport,
					onViewportChange
				}),
				(0, import_jsx_runtime.jsx)(SelectionListener, { onSelectionChange }),
				children,
				(0, import_jsx_runtime.jsx)(Attribution, {
					proOptions,
					position: attributionPosition
				}),
				(0, import_jsx_runtime.jsx)(A11yDescriptions, {
					rfId,
					disableKeyboardA11y
				})
			]
		})
	});
}
/**
* The `<ReactFlow />` component is the heart of your React Flow application.
* It renders your nodes and edges and handles user interaction
*
* @public
*
* @example
* ```tsx
*import { ReactFlow } from '@xyflow/react'
*
*export default function Flow() {
*  return (<ReactFlow
*    nodes={...}
*    edges={...}
*    onNodesChange={...}
*    ...
*  />);
*}
*```
*/
var index = fixedForwardRef(ReactFlow);
const error014 = errorMessages["error014"]();
function LinePattern({ dimensions, lineWidth, variant, className }) {
	return (0, import_jsx_runtime.jsx)("path", {
		strokeWidth: lineWidth,
		d: `M${dimensions[0] / 2} 0 V${dimensions[1]} M0 ${dimensions[1] / 2} H${dimensions[0]}`,
		className: cc([
			"react-flow__background-pattern",
			variant,
			className
		])
	});
}
function DotPattern({ radius, className }) {
	return (0, import_jsx_runtime.jsx)("circle", {
		cx: radius,
		cy: radius,
		r: radius,
		className: cc([
			"react-flow__background-pattern",
			"dots",
			className
		])
	});
}
/**
* The three variants are exported as an enum for convenience. You can either import
* the enum and use it like `BackgroundVariant.Lines` or you can use the raw string
* value directly.
* @public
*/
var BackgroundVariant;
(function(BackgroundVariant) {
	BackgroundVariant["Lines"] = "lines";
	BackgroundVariant["Dots"] = "dots";
	BackgroundVariant["Cross"] = "cross";
})(BackgroundVariant || (BackgroundVariant = {}));
const defaultSize = {
	[BackgroundVariant.Dots]: 1,
	[BackgroundVariant.Lines]: 1,
	[BackgroundVariant.Cross]: 6
};
const selector$3 = (s) => ({
	transform: s.transform,
	patternId: `pattern-${s.rfId}`
});
function BackgroundComponent({ id, variant = BackgroundVariant.Dots, gap = 20, size, lineWidth = 1, offset = 0, color, bgColor, style, className, patternClassName }) {
	const ref = useRef(null);
	const { transform, patternId } = useStore(selector$3, shallow$1);
	const patternSize = size || defaultSize[variant];
	const isDots = variant === BackgroundVariant.Dots;
	const isCross = variant === BackgroundVariant.Cross;
	const gapXY = Array.isArray(gap) ? gap : [gap, gap];
	const scaledGap = [gapXY[0] * transform[2] || 1, gapXY[1] * transform[2] || 1];
	const scaledSize = patternSize * transform[2];
	const offsetXY = Array.isArray(offset) ? offset : [offset, offset];
	const patternDimensions = isCross ? [scaledSize, scaledSize] : scaledGap;
	const scaledOffset = [offsetXY[0] * transform[2] || 1 + patternDimensions[0] / 2, offsetXY[1] * transform[2] || 1 + patternDimensions[1] / 2];
	const _patternId = `${patternId}${id ? id : ""}`;
	return (0, import_jsx_runtime.jsxs)("svg", {
		className: cc(["react-flow__background", className]),
		style: {
			...style,
			...containerStyle,
			"--xy-background-color-props": bgColor,
			"--xy-background-pattern-color-props": color
		},
		ref,
		"data-testid": "rf__background",
		children: [(0, import_jsx_runtime.jsx)("pattern", {
			id: _patternId,
			x: transform[0] % scaledGap[0],
			y: transform[1] % scaledGap[1],
			width: scaledGap[0],
			height: scaledGap[1],
			patternUnits: "userSpaceOnUse",
			patternTransform: `translate(-${scaledOffset[0]},-${scaledOffset[1]})`,
			children: isDots ? (0, import_jsx_runtime.jsx)(DotPattern, {
				radius: scaledSize / 2,
				className: patternClassName
			}) : (0, import_jsx_runtime.jsx)(LinePattern, {
				dimensions: patternDimensions,
				lineWidth,
				variant,
				className: patternClassName
			})
		}), (0, import_jsx_runtime.jsx)("rect", {
			x: "0",
			y: "0",
			width: "100%",
			height: "100%",
			fill: `url(#${_patternId})`
		})]
	});
}
BackgroundComponent.displayName = "Background";
/**
* The `<Background />` component makes it convenient to render different types of backgrounds common in node-based UIs. It comes with three variants: lines, dots and cross.
*
* @example
*
* A simple example of how to use the Background component.
*
* ```tsx
* import { useState } from 'react';
* import { ReactFlow, Background, BackgroundVariant } from '@xyflow/react';
*
* export default function Flow() {
*   return (
*     <ReactFlow defaultNodes={[...]} defaultEdges={[...]}>
*       <Background color="#ccc" variant={BackgroundVariant.Dots} />
*     </ReactFlow>
*   );
* }
* ```
*
* @example
*
* In this example you can see how to combine multiple backgrounds
*
* ```tsx
* import { ReactFlow, Background, BackgroundVariant } from '@xyflow/react';
* import '@xyflow/react/dist/style.css';
*
* export default function Flow() {
*   return (
*     <ReactFlow defaultNodes={[...]} defaultEdges={[...]}>
*       <Background
*         id="1"
*         gap={10}
*         color="#f1f1f1"
*         variant={BackgroundVariant.Lines}
*       />
*       <Background
*         id="2"
*         gap={100}
*         color="#ccc"
*         variant={BackgroundVariant.Lines}
*       />
*     </ReactFlow>
*   );
* }
* ```
*
* @remarks
*
* When combining multiple <Background /> components it’s important to give each of them a unique id prop!
*
*/
const Background = memo(BackgroundComponent);
function PlusIcon() {
	return (0, import_jsx_runtime.jsx)("svg", {
		xmlns: "http://www.w3.org/2000/svg",
		viewBox: "0 0 32 32",
		children: (0, import_jsx_runtime.jsx)("path", { d: "M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z" })
	});
}
function MinusIcon() {
	return (0, import_jsx_runtime.jsx)("svg", {
		xmlns: "http://www.w3.org/2000/svg",
		viewBox: "0 0 32 5",
		children: (0, import_jsx_runtime.jsx)("path", { d: "M0 0h32v4.2H0z" })
	});
}
function FitViewIcon() {
	return (0, import_jsx_runtime.jsx)("svg", {
		xmlns: "http://www.w3.org/2000/svg",
		viewBox: "0 0 32 30",
		children: (0, import_jsx_runtime.jsx)("path", { d: "M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" })
	});
}
function LockIcon() {
	return (0, import_jsx_runtime.jsx)("svg", {
		xmlns: "http://www.w3.org/2000/svg",
		viewBox: "0 0 25 32",
		children: (0, import_jsx_runtime.jsx)("path", { d: "M21.333 10.667H19.81V7.619C19.81 3.429 16.38 0 12.19 0 8 0 4.571 3.429 4.571 7.619v3.048H3.048A3.056 3.056 0 000 13.714v15.238A3.056 3.056 0 003.048 32h18.285a3.056 3.056 0 003.048-3.048V13.714a3.056 3.056 0 00-3.048-3.047zM12.19 24.533a3.056 3.056 0 01-3.047-3.047 3.056 3.056 0 013.047-3.048 3.056 3.056 0 013.048 3.048 3.056 3.056 0 01-3.048 3.047zm4.724-13.866H7.467V7.619c0-2.59 2.133-4.724 4.723-4.724 2.591 0 4.724 2.133 4.724 4.724v3.048z" })
	});
}
function UnlockIcon() {
	return (0, import_jsx_runtime.jsx)("svg", {
		xmlns: "http://www.w3.org/2000/svg",
		viewBox: "0 0 25 32",
		children: (0, import_jsx_runtime.jsx)("path", { d: "M21.333 10.667H19.81V7.619C19.81 3.429 16.38 0 12.19 0c-4.114 1.828-1.37 2.133.305 2.438 1.676.305 4.42 2.59 4.42 5.181v3.048H3.047A3.056 3.056 0 000 13.714v15.238A3.056 3.056 0 003.048 32h18.285a3.056 3.056 0 003.048-3.048V13.714a3.056 3.056 0 00-3.048-3.047zM12.19 24.533a3.056 3.056 0 01-3.047-3.047 3.056 3.056 0 013.047-3.048 3.056 3.056 0 013.048 3.048 3.056 3.056 0 01-3.048 3.047z" })
	});
}
/**
* You can add buttons to the control panel by using the `<ControlButton />` component
* and pass it as a child to the [`<Controls />`](/api-reference/components/controls) component.
*
* @public
* @example
*```jsx
*import { MagicWand } from '@radix-ui/react-icons'
*import { ReactFlow, Controls, ControlButton } from '@xyflow/react'
*
*export default function Flow() {
*  return (
*    <ReactFlow nodes={[...]} edges={[...]}>
*      <Controls>
*        <ControlButton onClick={() => alert('Something magical just happened. ✨')}>
*          <MagicWand />
*        </ControlButton>
*      </Controls>
*    </ReactFlow>
*  )
*}
*```
*/
function ControlButton({ children, className, ...rest }) {
	return (0, import_jsx_runtime.jsx)("button", {
		type: "button",
		className: cc(["react-flow__controls-button", className]),
		...rest,
		children
	});
}
const selector$2 = (s) => ({
	isInteractive: s.nodesDraggable || s.nodesConnectable || s.elementsSelectable,
	minZoomReached: s.transform[2] <= s.minZoom,
	maxZoomReached: s.transform[2] >= s.maxZoom,
	ariaLabelConfig: s.ariaLabelConfig
});
function ControlsComponent({ style, showZoom = true, showFitView = true, showInteractive = true, fitViewOptions, onZoomIn, onZoomOut, onFitView, onInteractiveChange, className, children, position = "bottom-left", orientation = "vertical", "aria-label": ariaLabel }) {
	const store = useStoreApi();
	const { isInteractive, minZoomReached, maxZoomReached, ariaLabelConfig } = useStore(selector$2, shallow$1);
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	const onZoomInHandler = () => {
		zoomIn();
		onZoomIn?.();
	};
	const onZoomOutHandler = () => {
		zoomOut();
		onZoomOut?.();
	};
	const onFitViewHandler = () => {
		fitView(fitViewOptions);
		onFitView?.();
	};
	const onToggleInteractivity = () => {
		store.setState({
			nodesDraggable: !isInteractive,
			nodesConnectable: !isInteractive,
			elementsSelectable: !isInteractive
		});
		onInteractiveChange?.(!isInteractive);
	};
	return (0, import_jsx_runtime.jsxs)(Panel, {
		className: cc([
			"react-flow__controls",
			orientation === "horizontal" ? "horizontal" : "vertical",
			className
		]),
		position,
		style,
		"data-testid": "rf__controls",
		"aria-label": ariaLabel ?? ariaLabelConfig["controls.ariaLabel"],
		children: [
			showZoom && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(ControlButton, {
				onClick: onZoomInHandler,
				className: "react-flow__controls-zoomin",
				title: ariaLabelConfig["controls.zoomIn.ariaLabel"],
				"aria-label": ariaLabelConfig["controls.zoomIn.ariaLabel"],
				disabled: maxZoomReached,
				children: (0, import_jsx_runtime.jsx)(PlusIcon, {})
			}), (0, import_jsx_runtime.jsx)(ControlButton, {
				onClick: onZoomOutHandler,
				className: "react-flow__controls-zoomout",
				title: ariaLabelConfig["controls.zoomOut.ariaLabel"],
				"aria-label": ariaLabelConfig["controls.zoomOut.ariaLabel"],
				disabled: minZoomReached,
				children: (0, import_jsx_runtime.jsx)(MinusIcon, {})
			})] }),
			showFitView && (0, import_jsx_runtime.jsx)(ControlButton, {
				className: "react-flow__controls-fitview",
				onClick: onFitViewHandler,
				title: ariaLabelConfig["controls.fitView.ariaLabel"],
				"aria-label": ariaLabelConfig["controls.fitView.ariaLabel"],
				children: (0, import_jsx_runtime.jsx)(FitViewIcon, {})
			}),
			showInteractive && (0, import_jsx_runtime.jsx)(ControlButton, {
				className: "react-flow__controls-interactive",
				onClick: onToggleInteractivity,
				title: ariaLabelConfig["controls.interactive.ariaLabel"],
				"aria-label": ariaLabelConfig["controls.interactive.ariaLabel"],
				children: isInteractive ? (0, import_jsx_runtime.jsx)(UnlockIcon, {}) : (0, import_jsx_runtime.jsx)(LockIcon, {})
			}),
			children
		]
	});
}
ControlsComponent.displayName = "Controls";
/**
* The `<Controls />` component renders a small panel that contains convenient
* buttons to zoom in, zoom out, fit the view, and lock the viewport.
*
* @public
* @example
*```tsx
*import { ReactFlow, Controls } from '@xyflow/react'
*
*export default function Flow() {
*  return (
*    <ReactFlow nodes={[...]} edges={[...]}>
*      <Controls />
*    </ReactFlow>
*  )
*}
*```
*
* @remarks To extend or customise the controls, you can use the [`<ControlButton />`](/api-reference/components/control-button) component
*
*/
const Controls = memo(ControlsComponent);
function MiniMapNodeComponent({ id, x, y, width, height, style, color, strokeColor, strokeWidth, className, borderRadius, shapeRendering, selected, onClick }) {
	const { background, backgroundColor } = style || {};
	const fill = color || background || backgroundColor;
	return (0, import_jsx_runtime.jsx)("rect", {
		className: cc([
			"react-flow__minimap-node",
			{ selected },
			className
		]),
		x,
		y,
		rx: borderRadius,
		ry: borderRadius,
		width,
		height,
		style: {
			fill,
			stroke: strokeColor,
			strokeWidth
		},
		shapeRendering,
		onClick: onClick ? (event) => onClick(event, id) : void 0
	});
}
const MiniMapNode = memo(MiniMapNodeComponent);
const selectorNodeIds = (s) => s.nodes.map((node) => node.id);
const getAttrFunction = (func) => func instanceof Function ? func : () => func;
function MiniMapNodes({ nodeStrokeColor, nodeColor, nodeClassName = "", nodeBorderRadius = 5, nodeStrokeWidth, nodeComponent: NodeComponent = MiniMapNode, onClick }) {
	const nodeIds = useStore(selectorNodeIds, shallow$1);
	const nodeColorFunc = getAttrFunction(nodeColor);
	const nodeStrokeColorFunc = getAttrFunction(nodeStrokeColor);
	const nodeClassNameFunc = getAttrFunction(nodeClassName);
	const shapeRendering = typeof window === "undefined" || !!window.chrome ? "crispEdges" : "geometricPrecision";
	return (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children: nodeIds.map((nodeId) => (0, import_jsx_runtime.jsx)(NodeComponentWrapper, {
		id: nodeId,
		nodeColorFunc,
		nodeStrokeColorFunc,
		nodeClassNameFunc,
		nodeBorderRadius,
		nodeStrokeWidth,
		NodeComponent,
		onClick,
		shapeRendering
	}, nodeId)) });
}
function NodeComponentWrapperInner({ id, nodeColorFunc, nodeStrokeColorFunc, nodeClassNameFunc, nodeBorderRadius, nodeStrokeWidth, shapeRendering, NodeComponent, onClick }) {
	const { node, x, y, width, height } = useStore((s) => {
		const node = s.nodeLookup.get(id);
		if (!node) return {
			node: void 0,
			x: 0,
			y: 0,
			width: 0,
			height: 0
		};
		const userNode = node.internals.userNode;
		const { x, y } = node.internals.positionAbsolute;
		const { width, height } = getNodeDimensions(userNode);
		return {
			node: userNode,
			x,
			y,
			width,
			height
		};
	}, shallow$1);
	if (!node || node.hidden || !nodeHasDimensions(node)) return null;
	return (0, import_jsx_runtime.jsx)(NodeComponent, {
		x,
		y,
		width,
		height,
		style: node.style,
		selected: !!node.selected,
		className: nodeClassNameFunc(node),
		color: nodeColorFunc(node),
		borderRadius: nodeBorderRadius,
		strokeColor: nodeStrokeColorFunc(node),
		strokeWidth: nodeStrokeWidth,
		shapeRendering,
		onClick,
		id: node.id
	});
}
const NodeComponentWrapper = memo(NodeComponentWrapperInner);
var MiniMapNodes$1 = memo(MiniMapNodes);
const defaultWidth = 200;
const defaultHeight = 150;
const filterHidden = (node) => !node.hidden;
const selector$1 = (s) => {
	const viewBB = {
		x: -s.transform[0] / s.transform[2],
		y: -s.transform[1] / s.transform[2],
		width: s.width / s.transform[2],
		height: s.height / s.transform[2]
	};
	return {
		viewBB,
		boundingRect: s.nodeLookup.size > 0 ? getBoundsOfRects(getInternalNodesBounds(s.nodeLookup, { filter: filterHidden }), viewBB) : viewBB,
		rfId: s.rfId,
		panZoom: s.panZoom,
		translateExtent: s.translateExtent,
		flowWidth: s.width,
		flowHeight: s.height,
		ariaLabelConfig: s.ariaLabelConfig
	};
};
const ARIA_LABEL_KEY = "react-flow__minimap-desc";
function MiniMapComponent({ style, className, nodeStrokeColor, nodeColor, nodeClassName = "", nodeBorderRadius = 5, nodeStrokeWidth, nodeComponent, bgColor, maskColor, maskStrokeColor, maskStrokeWidth, position = "bottom-right", onClick, onNodeClick, pannable = false, zoomable = false, ariaLabel, inversePan, zoomStep = 1, offsetScale = 5 }) {
	const store = useStoreApi();
	const svg = useRef(null);
	const { boundingRect, viewBB, rfId, panZoom, translateExtent, flowWidth, flowHeight, ariaLabelConfig } = useStore(selector$1, shallow$1);
	const elementWidth = style?.width ?? defaultWidth;
	const elementHeight = style?.height ?? defaultHeight;
	const scaledWidth = boundingRect.width / elementWidth;
	const scaledHeight = boundingRect.height / elementHeight;
	const viewScale = Math.max(scaledWidth, scaledHeight);
	const viewWidth = viewScale * elementWidth;
	const viewHeight = viewScale * elementHeight;
	const offset = offsetScale * viewScale;
	const x = boundingRect.x - (viewWidth - boundingRect.width) / 2 - offset;
	const y = boundingRect.y - (viewHeight - boundingRect.height) / 2 - offset;
	const width = viewWidth + offset * 2;
	const height = viewHeight + offset * 2;
	const labelledBy = `${ARIA_LABEL_KEY}-${rfId}`;
	const viewScaleRef = useRef(0);
	const minimapInstance = useRef();
	viewScaleRef.current = viewScale;
	useEffect(() => {
		if (svg.current && panZoom) {
			minimapInstance.current = XYMinimap({
				domNode: svg.current,
				panZoom,
				getTransform: () => store.getState().transform,
				getViewScale: () => viewScaleRef.current
			});
			return () => {
				minimapInstance.current?.destroy();
			};
		}
	}, [panZoom]);
	useEffect(() => {
		minimapInstance.current?.update({
			translateExtent,
			width: flowWidth,
			height: flowHeight,
			inversePan,
			pannable,
			zoomStep,
			zoomable
		});
	}, [
		pannable,
		zoomable,
		inversePan,
		zoomStep,
		translateExtent,
		flowWidth,
		flowHeight
	]);
	const onSvgClick = onClick ? (event) => {
		const [x, y] = minimapInstance.current?.pointer(event) || [0, 0];
		onClick(event, {
			x,
			y
		});
	} : void 0;
	const onSvgNodeClick = onNodeClick ? useCallback((event, nodeId) => {
		const node = store.getState().nodeLookup.get(nodeId).internals.userNode;
		onNodeClick(event, node);
	}, []) : void 0;
	const _ariaLabel = ariaLabel ?? ariaLabelConfig["minimap.ariaLabel"];
	return (0, import_jsx_runtime.jsx)(Panel, {
		position,
		style: {
			...style,
			"--xy-minimap-background-color-props": typeof bgColor === "string" ? bgColor : void 0,
			"--xy-minimap-mask-background-color-props": typeof maskColor === "string" ? maskColor : void 0,
			"--xy-minimap-mask-stroke-color-props": typeof maskStrokeColor === "string" ? maskStrokeColor : void 0,
			"--xy-minimap-mask-stroke-width-props": typeof maskStrokeWidth === "number" ? maskStrokeWidth * viewScale : void 0,
			"--xy-minimap-node-background-color-props": typeof nodeColor === "string" ? nodeColor : void 0,
			"--xy-minimap-node-stroke-color-props": typeof nodeStrokeColor === "string" ? nodeStrokeColor : void 0,
			"--xy-minimap-node-stroke-width-props": typeof nodeStrokeWidth === "number" ? nodeStrokeWidth : void 0
		},
		className: cc(["react-flow__minimap", className]),
		"data-testid": "rf__minimap",
		children: (0, import_jsx_runtime.jsxs)("svg", {
			width: elementWidth,
			height: elementHeight,
			viewBox: `${x} ${y} ${width} ${height}`,
			className: "react-flow__minimap-svg",
			role: "img",
			"aria-labelledby": labelledBy,
			ref: svg,
			onClick: onSvgClick,
			children: [
				_ariaLabel && (0, import_jsx_runtime.jsx)("title", {
					id: labelledBy,
					children: _ariaLabel
				}),
				(0, import_jsx_runtime.jsx)(MiniMapNodes$1, {
					onClick: onSvgNodeClick,
					nodeColor,
					nodeStrokeColor,
					nodeBorderRadius,
					nodeClassName,
					nodeStrokeWidth,
					nodeComponent
				}),
				(0, import_jsx_runtime.jsx)("path", {
					className: "react-flow__minimap-mask",
					d: `M${x - offset},${y - offset}h${width + offset * 2}v${height + offset * 2}h${-width - offset * 2}z
        M${viewBB.x},${viewBB.y}h${viewBB.width}v${viewBB.height}h${-viewBB.width}z`,
					fillRule: "evenodd",
					pointerEvents: "none"
				})
			]
		})
	});
}
MiniMapComponent.displayName = "MiniMap";
/**
* The `<MiniMap />` component can be used to render an overview of your flow. It
* renders each node as an SVG element and visualizes where the current viewport is
* in relation to the rest of the flow.
*
* @public
* @example
*
* ```jsx
*import { ReactFlow, MiniMap } from '@xyflow/react';
*
*export default function Flow() {
*  return (
*    <ReactFlow nodes={[...]} edges={[...]}>
*      <MiniMap nodeStrokeWidth={3} />
*    </ReactFlow>
*  );
*}
*```
*/
const MiniMap = memo(MiniMapComponent);
const scaleSelector = (calculateScale) => (store) => calculateScale ? `${Math.max(1 / store.transform[2], 1)}` : void 0;
const defaultPositions = {
	[ResizeControlVariant.Line]: "right",
	[ResizeControlVariant.Handle]: "bottom-right"
};
function ResizeControl({ nodeId, position, variant = ResizeControlVariant.Handle, className, style = void 0, children, color, minWidth = 10, minHeight = 10, maxWidth = Number.MAX_VALUE, maxHeight = Number.MAX_VALUE, keepAspectRatio = false, resizeDirection, autoScale = true, shouldResize, onResizeStart, onResize, onResizeEnd }) {
	const contextNodeId = useNodeId();
	const id = typeof nodeId === "string" ? nodeId : contextNodeId;
	const store = useStoreApi();
	const resizeControlRef = useRef(null);
	const isHandleControl = variant === ResizeControlVariant.Handle;
	const scale = useStore(useCallback(scaleSelector(isHandleControl && autoScale), [isHandleControl, autoScale]), shallow$1);
	const resizer = useRef(null);
	const controlPosition = position ?? defaultPositions[variant];
	useEffect(() => {
		if (!resizeControlRef.current || !id) return;
		if (!resizer.current) resizer.current = XYResizer({
			domNode: resizeControlRef.current,
			nodeId: id,
			getStoreItems: () => {
				const { nodeLookup, transform, snapGrid, snapToGrid, nodeOrigin, domNode } = store.getState();
				return {
					nodeLookup,
					transform,
					snapGrid,
					snapToGrid,
					nodeOrigin,
					paneDomNode: domNode
				};
			},
			onChange: (change, childChanges) => {
				const { triggerNodeChanges, nodeLookup, parentLookup, nodeOrigin } = store.getState();
				const changes = [];
				const nextPosition = {
					x: change.x,
					y: change.y
				};
				const node = nodeLookup.get(id);
				if (node && node.expandParent && node.parentId) {
					const origin = node.origin ?? nodeOrigin;
					const width = change.width ?? node.measured.width ?? 0;
					const height = change.height ?? node.measured.height ?? 0;
					const parentExpandChanges = handleExpandParent([{
						id: node.id,
						parentId: node.parentId,
						rect: {
							width,
							height,
							...evaluateAbsolutePosition({
								x: change.x ?? node.position.x,
								y: change.y ?? node.position.y
							}, {
								width,
								height
							}, node.parentId, nodeLookup, origin)
						}
					}], nodeLookup, parentLookup, nodeOrigin);
					changes.push(...parentExpandChanges);
					nextPosition.x = change.x ? Math.max(origin[0] * width, change.x) : void 0;
					nextPosition.y = change.y ? Math.max(origin[1] * height, change.y) : void 0;
				}
				if (nextPosition.x !== void 0 && nextPosition.y !== void 0) {
					const positionChange = {
						id,
						type: "position",
						position: { ...nextPosition }
					};
					changes.push(positionChange);
				}
				if (change.width !== void 0 && change.height !== void 0) {
					const dimensionChange = {
						id,
						type: "dimensions",
						resizing: true,
						setAttributes: !resizeDirection ? true : resizeDirection === "horizontal" ? "width" : "height",
						dimensions: {
							width: change.width,
							height: change.height
						}
					};
					changes.push(dimensionChange);
				}
				for (const childChange of childChanges) {
					const positionChange = {
						...childChange,
						type: "position"
					};
					changes.push(positionChange);
				}
				triggerNodeChanges(changes);
			},
			onEnd: ({ width, height }) => {
				const dimensionChange = {
					id,
					type: "dimensions",
					resizing: false,
					dimensions: {
						width,
						height
					}
				};
				store.getState().triggerNodeChanges([dimensionChange]);
			}
		});
		resizer.current.update({
			controlPosition,
			boundaries: {
				minWidth,
				minHeight,
				maxWidth,
				maxHeight
			},
			keepAspectRatio,
			resizeDirection,
			onResizeStart,
			onResize,
			onResizeEnd,
			shouldResize
		});
		return () => {
			resizer.current?.destroy();
		};
	}, [
		controlPosition,
		minWidth,
		minHeight,
		maxWidth,
		maxHeight,
		keepAspectRatio,
		onResizeStart,
		onResize,
		onResizeEnd,
		shouldResize
	]);
	return (0, import_jsx_runtime.jsx)("div", {
		className: cc([
			"react-flow__resize-control",
			"nodrag",
			...controlPosition.split("-"),
			variant,
			className
		]),
		ref: resizeControlRef,
		style: {
			...style,
			scale,
			...color && { [isHandleControl ? "backgroundColor" : "borderColor"]: color }
		},
		children
	});
}
/**
* To create your own resizing UI, you can use the `NodeResizeControl` component where you can pass children (such as icons).
* @public
*
*/
const NodeResizeControl = memo(ResizeControl);

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/WorkflowGraphViewer.js
function resolveNodeColor(type) {
	const t = type.toLowerCase();
	if (t.includes("trigger") || t.includes("webhook") || t.includes("schedule") || t.includes("cron")) return {
		bg: "#451a03",
		border: "#f59e0b",
		badge: "#f59e0b"
	};
	if (t.includes("if") || t.includes("switch") || t.includes("merge") || t.includes("split") || t.includes("wait") || t.includes("noop") || t.includes("start")) return {
		bg: "#1e293b",
		border: "#64748b",
		badge: "#64748b"
	};
	if (t.includes("gmail") || t.includes("slack") || t.includes("telegram") || t.includes("discord") || t.includes("github") || t.includes("notion") || t.includes("google") || t.includes("openai") || t.includes("anthropic")) return {
		bg: "#2e1065",
		border: "#8b5cf6",
		badge: "#8b5cf6"
	};
	return {
		bg: "#0c1a2e",
		border: "#3b82f6",
		badge: "#3b82f6"
	};
}
const NODE_WIDTH = 180;
const NODE_HEIGHT = 64;
const H_GAP = 60;
const V_GAP = 40;
function autoLayoutPositions(nodeNames) {
	const cols = Math.max(1, Math.ceil(Math.sqrt(nodeNames.length)));
	const positions = /* @__PURE__ */ new Map();
	nodeNames.forEach((name, i) => {
		const col = i % cols;
		const row = Math.floor(i / cols);
		positions.set(name, {
			x: col * (NODE_WIDTH + H_GAP) + 40,
			y: row * (NODE_HEIGHT + V_GAP) + 40
		});
	});
	return positions;
}
function workflowToReactFlow(workflow) {
	if (!workflow?.nodes?.length) return {
		nodes: [],
		edges: []
	};
	const rawNodes = workflow.nodes;
	const posOverrides = /* @__PURE__ */ new Map();
	for (const n of rawNodes) if (n.position) posOverrides.set(n.name, {
		x: n.position[0],
		y: n.position[1]
	});
	const autoPos = autoLayoutPositions(rawNodes.filter((n) => !posOverrides.has(n.name)).map((n) => n.name));
	const nodes = rawNodes.map((n) => {
		const pos = posOverrides.get(n.name) ?? autoPos.get(n.name) ?? {
			x: 0,
			y: 0
		};
		const colors = resolveNodeColor(n.type ?? "");
		const typeLabel = (n.type ?? "node").split(".").pop() ?? "node";
		return {
			id: n.id ?? n.name,
			position: pos,
			data: {
				label: n.name,
				typeLabel,
				colors
			},
			style: {
				background: colors.bg,
				border: `1.5px solid ${colors.border}`,
				borderRadius: "8px",
				padding: "8px 12px",
				width: NODE_WIDTH,
				minHeight: NODE_HEIGHT,
				color: "#e2e8f0",
				fontSize: "12px",
				boxShadow: `0 0 0 1px ${colors.border}22`
			}
		};
	});
	const nameToId = /* @__PURE__ */ new Map();
	for (const n of rawNodes) nameToId.set(n.name, n.id ?? n.name);
	const edges = [];
	const connections = workflow.connections ?? {};
	for (const [sourceName, outputMap] of Object.entries(connections)) {
		const sourceId = nameToId.get(sourceName);
		if (!sourceId) continue;
		(outputMap.main ?? []).forEach((outputIndex, oi) => {
			(outputIndex ?? []).forEach((conn, ci) => {
				const targetId = nameToId.get(conn.node);
				if (!targetId) return;
				edges.push({
					id: `${sourceId}-${targetId}-${oi}-${ci}`,
					source: sourceId,
					target: targetId,
					type: "smoothstep",
					animated: false,
					style: {
						stroke: "#475569",
						strokeWidth: 1.5
					}
				});
			});
		});
	}
	return {
		nodes,
		edges
	};
}
function generatingEdges(edges) {
	return edges.map((e) => ({
		...e,
		animated: true,
		style: {
			...e.style,
			stroke: "#3b82f6",
			strokeDasharray: "6 3"
		}
	}));
}
function graphChrome(uiTheme) {
	if (uiTheme === "light") return {
		canvasBg: "#f8fafc",
		dots: "#cbd5e1",
		minimapMask: "rgba(226, 232, 240, 0.72)",
		minimapBg: "#ffffff",
		minimapBorder: "#cbd5e1",
		emptyTitleClass: "text-slate-700",
		emptyHelpClass: "text-slate-500",
		overlayBg: "rgba(248, 250, 252, 0.72)",
		overlayChipBg: "rgba(255, 255, 255, 0.94)",
		overlayChipText: "#1d4ed8"
	};
	return {
		canvasBg: "#020817",
		dots: "#334155",
		minimapMask: "rgba(2, 8, 23, 0.7)",
		minimapBg: "#0f172a",
		minimapBorder: "#334155",
		emptyTitleClass: "text-slate-300",
		emptyHelpClass: "text-slate-500",
		overlayBg: "rgba(2, 8, 23, 0.6)",
		overlayChipBg: "rgba(2, 8, 23, 0.82)",
		overlayChipText: "#60a5fa"
	};
}
/**
* Stage messages for `WorkflowGenerationProgress`. The plugin's workflow
* generation today is a single request/response, so the client cannot yet
* observe the actual stage in real time. We cycle through plausible labels
* on a fixed timer based on observed median latencies of each phase:
*   1. extractKeywords (fast — runtime-context provider + keyword LLM call)
*   2. searchNodes + credential filter + fetchRuntimeContext
*   3. generateWorkflow (LLM, slowest)
*   4. validateAndRepair + injectMissingCredentialBlocks
*   5. deployWorkflow + resolveCredentials + activate
*
* When the plugin grows a server-sent-events streaming endpoint, the timer
* can be replaced with real per-stage progress events.
*/
const WORKFLOW_GENERATION_STAGES = [
	{
		label: "Understanding your prompt",
		hint: "Extracting keywords + matching providers",
		startsAt: 0
	},
	{
		label: "Finding the right nodes",
		hint: "Searching catalog + checking credentials",
		startsAt: 3
	},
	{
		label: "Generating workflow",
		hint: "Asking the LLM with runtime facts",
		startsAt: 6
	},
	{
		label: "Validating + repairing",
		hint: "Clamping versions + auto-fixing references",
		startsAt: 18
	},
	{
		label: "Deploying to n8n",
		hint: "Minting credentials + activating",
		startsAt: 24
	},
	{
		label: "Almost done",
		hint: "Wrapping up — this is taking a bit longer than usual",
		startsAt: 35
	}
];
function WorkflowGenerationProgress({ chrome }) {
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		const start = Date.now();
		const id = setInterval(() => {
			setElapsed(Math.floor((Date.now() - start) / 1e3));
		}, 500);
		return () => clearInterval(id);
	}, []);
	const currentIndex = WORKFLOW_GENERATION_STAGES.reduce((acc, stage, idx) => elapsed >= stage.startsAt ? idx : acc, 0);
	return (0, import_jsx_runtime.jsx)("div", {
		className: "w-full max-w-md rounded-xl border px-5 py-4 text-sm shadow-lg",
		style: {
			background: chrome.overlayChipBg,
			color: chrome.overlayChipText,
			borderColor: chrome.overlayChipText
		},
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-start gap-3",
			children: [(0, import_jsx_runtime.jsx)(Spinner, { className: "mt-0.5 h-4 w-4 shrink-0" }), (0, import_jsx_runtime.jsxs)("div", {
				className: "min-w-0 flex-1 space-y-3",
				children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)("div", {
					className: "font-semibold",
					children: "Building your workflow…"
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "text-xs opacity-70",
					children: "Generations usually take 10–30 seconds."
				})] }), (0, import_jsx_runtime.jsx)("ol", {
					className: "space-y-1.5",
					children: WORKFLOW_GENERATION_STAGES.map((stage, idx) => {
						const isDone = idx < currentIndex;
						const isActive = idx === currentIndex;
						return (0, import_jsx_runtime.jsxs)("li", {
							className: `flex items-start gap-2 text-xs transition-opacity ${isDone || isActive ? "opacity-100" : "opacity-40"}`,
							children: [(0, import_jsx_runtime.jsx)("span", {
								className: `mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${isDone ? "border-current bg-current/15" : isActive ? "border-current bg-current/15" : "border-current/40"}`,
								"aria-hidden": true,
								children: isDone ? (0, import_jsx_runtime.jsx)("svg", {
									viewBox: "0 0 12 12",
									className: "h-2.5 w-2.5",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: "2",
									role: "img",
									"aria-label": "completed",
									children: (0, import_jsx_runtime.jsx)("path", {
										d: "M2.5 6.5l2.5 2.5 4.5-5",
										strokeLinecap: "round",
										strokeLinejoin: "round"
									})
								}) : isActive ? (0, import_jsx_runtime.jsx)("span", {
									className: "h-1.5 w-1.5 animate-pulse rounded-full bg-current",
									"aria-hidden": true
								}) : null
							}), (0, import_jsx_runtime.jsxs)("span", {
								className: "min-w-0 flex-1",
								children: [(0, import_jsx_runtime.jsx)("span", {
									className: `font-medium ${isActive ? "" : "opacity-70"}`,
									children: stage.label
								}), (isDone || isActive) && (0, import_jsx_runtime.jsxs)("span", {
									className: "ml-1.5 opacity-60",
									children: ["— ", stage.hint]
								})]
							})]
						}, stage.label);
					})
				})]
			})]
		})
	});
}
const PARAM_TRUNCATE_LENGTH = 200;
function ParamValue({ value }) {
	const { t } = useApp();
	const [expanded, setExpanded] = useState(false);
	if (typeof value === "string") {
		if (value.length > PARAM_TRUNCATE_LENGTH && !expanded) return (0, import_jsx_runtime.jsxs)("span", { children: [(0, import_jsx_runtime.jsxs)("pre", {
			className: "inline font-mono whitespace-pre-wrap break-all text-xs text-txt/80",
			children: [value.slice(0, PARAM_TRUNCATE_LENGTH), "…"]
		}), (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			className: "ml-1 text-xs text-blue-400 hover:underline",
			onClick: () => setExpanded(true),
			children: t("workflowGraph.nodeDrawer.showMore")
		})] });
		if (value.length > PARAM_TRUNCATE_LENGTH && expanded) return (0, import_jsx_runtime.jsxs)("span", { children: [(0, import_jsx_runtime.jsx)("pre", {
			className: "inline font-mono whitespace-pre-wrap break-all text-xs text-txt/80",
			children: value
		}), (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			className: "ml-1 text-xs text-blue-400 hover:underline",
			onClick: () => setExpanded(false),
			children: t("workflowGraph.nodeDrawer.showLess")
		})] });
		return (0, import_jsx_runtime.jsx)("pre", {
			className: "font-mono whitespace-pre-wrap break-all text-xs text-txt/80",
			children: value
		});
	}
	if (typeof value === "object" && value !== null) {
		const json = JSON.stringify(value, null, 2);
		if (json.length > PARAM_TRUNCATE_LENGTH && !expanded) return (0, import_jsx_runtime.jsxs)("span", { children: [(0, import_jsx_runtime.jsxs)("pre", {
			className: "inline font-mono whitespace-pre-wrap break-all text-xs text-txt/80",
			children: [json.slice(0, PARAM_TRUNCATE_LENGTH), "…"]
		}), (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			className: "ml-1 text-xs text-blue-400 hover:underline",
			onClick: () => setExpanded(true),
			children: t("workflowGraph.nodeDrawer.showMore")
		})] });
		if (json.length > PARAM_TRUNCATE_LENGTH && expanded) return (0, import_jsx_runtime.jsxs)("span", { children: [(0, import_jsx_runtime.jsx)("pre", {
			className: "font-mono whitespace-pre-wrap break-all text-xs text-txt/80",
			children: json
		}), (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			className: "ml-1 text-xs text-blue-400 hover:underline",
			onClick: () => setExpanded(false),
			children: t("workflowGraph.nodeDrawer.showLess")
		})] });
		return (0, import_jsx_runtime.jsx)("pre", {
			className: "font-mono whitespace-pre-wrap break-all text-xs text-txt/80",
			children: json
		});
	}
	return (0, import_jsx_runtime.jsx)("pre", {
		className: "font-mono whitespace-pre-wrap break-all text-xs text-txt/80",
		children: String(value)
	});
}
function buildEditorUrl(workflow, status, cloudAgentId, uiTheme) {
	let editorUrl = null;
	if (status.mode === "local" && status.host) editorUrl = `${status.host}/workflow/${encodeURIComponent(workflow.id)}`;
	if (status.mode === "cloud" && cloudAgentId) editorUrl = `${getBootConfig().cloudApiBase ?? "https://www.elizacloud.ai"}/agents/${encodeURIComponent(cloudAgentId)}/n8n/workflow/${encodeURIComponent(workflow.id)}`;
	if (!editorUrl) return null;
	const url = new URL(editorUrl);
	url.searchParams.set("theme", uiTheme);
	return url.toString();
}
function NodeDetailDrawer({ node, workflow, status, onClose, labelId }) {
	const { t, activeAgentProfile, uiTheme } = useApp();
	const closeButtonRef = useRef(null);
	const isOpen = node !== null;
	useEffect(() => {
		if (isOpen) {
			const id = setTimeout(() => closeButtonRef.current?.focus(), 60);
			return () => clearTimeout(id);
		}
	}, [isOpen]);
	const colors = resolveNodeColor(node?.type ?? "");
	const typeLabel = (node?.type ?? "node").split(".").pop() ?? "node";
	const hasParams = node?.parameters && Object.keys(node.parameters).length > 0;
	const editorUrl = !(!status || status.mode === "disabled" || status.status === "error") && workflow && status && node ? buildEditorUrl(workflow, status, activeAgentProfile?.cloudAgentId, uiTheme) : null;
	const badgeVariant = colors.badge === "#f59e0b" ? "warning" : colors.badge === "#8b5cf6" ? "danger" : "muted";
	return (0, import_jsx_runtime.jsxs)("div", {
		role: "dialog",
		"aria-modal": "false",
		"aria-labelledby": isOpen ? labelId : void 0,
		"aria-hidden": !isOpen,
		className: [
			"absolute inset-y-0 right-0 z-30 flex w-72 flex-col",
			"border-l border-border/40 bg-bg shadow-xl backdrop-blur-[2px]",
			"transition-transform duration-200 ease-out",
			isOpen ? "translate-x-0" : "translate-x-full"
		].join(" "),
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex shrink-0 items-start gap-2 border-b border-border/30 px-4 py-3",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "flex-1 min-w-0 space-y-1",
					children: [(0, import_jsx_runtime.jsx)("h2", {
						id: labelId,
						className: "text-sm font-semibold text-txt leading-tight truncate",
						children: node?.name ?? ""
					}), (0, import_jsx_runtime.jsx)("div", {
						className: "flex items-center gap-1.5",
						children: (0, import_jsx_runtime.jsx)(StatusBadge, {
							label: typeLabel,
							variant: badgeVariant
						})
					})]
				}), (0, import_jsx_runtime.jsx)("button", {
					ref: closeButtonRef,
					type: "button",
					"aria-label": t("workflowGraph.closeDrawer"),
					tabIndex: isOpen ? 0 : -1,
					className: "shrink-0 flex h-6 w-6 items-center justify-center rounded text-muted hover:text-txt transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					onClick: onClose,
					children: (0, import_jsx_runtime.jsx)(X, { className: "h-3.5 w-3.5" })
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "flex-1 overflow-y-auto space-y-4 px-4 py-3",
				children: node && (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [node.notes?.trim() ? (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-2",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "text-xs font-semibold uppercase tracking-wider text-muted",
						children: "Step"
					}), (0, import_jsx_runtime.jsx)("div", {
						className: "rounded bg-bg/40 border border-border/20 px-2 py-2",
						children: (0, import_jsx_runtime.jsx)("p", {
							className: "text-xs leading-relaxed text-txt/80",
							children: node.notes.trim()
						})
					})]
				}) : null, (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-2",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "text-xs font-semibold uppercase tracking-wider text-muted",
						children: t("common.parameters")
					}), hasParams ? (0, import_jsx_runtime.jsx)("div", {
						className: "space-y-2",
						children: Object.entries(node.parameters ?? {}).map(([key, val]) => (0, import_jsx_runtime.jsxs)("div", {
							className: "space-y-0.5",
							children: [(0, import_jsx_runtime.jsx)("div", {
								className: "text-xs font-medium text-muted/80 font-mono",
								children: key
							}), (0, import_jsx_runtime.jsx)("div", {
								className: "rounded bg-bg/40 border border-border/20 px-2 py-1",
								children: (0, import_jsx_runtime.jsx)(ParamValue, { value: val })
							})]
						}, key))
					}) : (0, import_jsx_runtime.jsx)("p", {
						className: "text-xs text-muted/60 italic",
						children: t("workflowGraph.nodeDrawer.noParameters")
					})]
				})] })
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "shrink-0 border-t border-border/30 px-4 py-3",
				children: editorUrl ? (0, import_jsx_runtime.jsxs)(Button, {
					type: "button",
					variant: "outline",
					size: "sm",
					className: "w-full h-8 text-xs gap-1.5",
					tabIndex: isOpen ? 0 : -1,
					onClick: () => window.open(editorUrl, "_blank", "noopener"),
					children: [(0, import_jsx_runtime.jsx)(ExternalLink, { className: "h-3.5 w-3.5" }), t("workflowGraph.nodeDrawer.openInEditor")]
				}) : (0, import_jsx_runtime.jsx)(Button, {
					type: "button",
					variant: "outline",
					size: "sm",
					className: "w-full h-8 text-xs",
					disabled: true,
					tabIndex: isOpen ? 0 : -1,
					title: t("workflowGraph.nodeDrawer.editorDisabled"),
					children: t("workflowGraph.nodeDrawer.openInEditor")
				})
			})
		]
	});
}
function GraphPanel({ nodes, edges, isGenerating, ariaLabel, onNodeClick, uiTheme }) {
	const chrome = graphChrome(uiTheme);
	return (0, import_jsx_runtime.jsxs)(index, {
		nodes,
		edges: isGenerating ? generatingEdges(edges) : edges,
		nodesDraggable: !isGenerating,
		nodesConnectable: false,
		edgesReconnectable: false,
		onNodeClick,
		fitView: true,
		fitViewOptions: {
			padding: .2,
			maxZoom: 1.2
		},
		proOptions: { hideAttribution: true },
		"aria-label": ariaLabel,
		children: [
			(0, import_jsx_runtime.jsx)(Background, {
				color: chrome.dots,
				gap: 20,
				size: 1
			}),
			(0, import_jsx_runtime.jsx)(Controls, { showInteractive: false }),
			(0, import_jsx_runtime.jsx)(MiniMap, {
				nodeColor: (n) => {
					return (n.data?.colors)?.border ?? "#475569";
				},
				maskColor: chrome.minimapMask,
				style: {
					background: chrome.minimapBg,
					border: `1px solid ${chrome.minimapBorder}`
				}
			})
		]
	});
}
function WorkflowGraphViewer({ workflow, loading = false, isGenerating = false, emptyStateActionLabel = "Describe your workflow", emptyStateHelpText = "Describe the trigger and steps in the sidebar.", onNodeClick, onEmptyStateAction, status }) {
	const { activeAgentProfile, uiTheme } = useApp();
	const [fullScreen, setFullScreen] = useState(false);
	const [selectedNode, setSelectedNode] = useState(null);
	const containerRef = useRef(null);
	const drawerLabelId = useId();
	const { nodes, edges } = useMemo(() => workflowToReactFlow(workflow), [workflow]);
	const ariaLabel = `Workflow graph with ${nodes.length} nodes and ${edges.length} connections`;
	useEffect(() => {
		setSelectedNode(null);
	}, [workflow?.id]);
	const handleNodeClick = useCallback((_, node) => {
		const label = node.data?.label ?? node.id;
		setSelectedNode(workflow?.nodes?.find((n) => n.id === node.id || n.name === label) ?? null);
		onNodeClick?.(label);
	}, [onNodeClick, workflow]);
	const handleCloseDrawer = useCallback(() => {
		setSelectedNode(null);
	}, []);
	useEffect(() => {
		if (!selectedNode || fullScreen) return;
		const handler = (e) => {
			if (e.key === "Escape") setSelectedNode(null);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [selectedNode, fullScreen]);
	useEffect(() => {
		if (!fullScreen) return;
		const handler = (e) => {
			if (e.key === "Escape") if (selectedNode) setSelectedNode(null);
			else setFullScreen(false);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [fullScreen, selectedNode]);
	const hasNodes = nodes.length > 0;
	const editorUrl = !(!status || status.mode === "disabled" || status.status === "error") && workflow && status ? buildEditorUrl(workflow, status, activeAgentProfile?.cloudAgentId, uiTheme) : null;
	const borderClass = isGenerating ? "animate-pulse ring-2 ring-blue-500/50" : "ring-1 ring-border/30";
	const chrome = graphChrome(uiTheme);
	return (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsxs)("div", {
		ref: containerRef,
		role: "img",
		"aria-label": ariaLabel,
		className: `relative overflow-hidden rounded-lg ${borderClass}`,
		style: {
			height: 420,
			background: chrome.canvasBg
		},
		children: [
			loading && !hasNodes && (0, import_jsx_runtime.jsx)("div", {
				className: "absolute inset-0 flex items-center justify-center",
				children: (0, import_jsx_runtime.jsx)(Spinner, { className: "h-6 w-6 text-muted" })
			}),
			!loading && !hasNodes && !isGenerating && (0, import_jsx_runtime.jsxs)("div", {
				className: "absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center",
				children: [
					(0, import_jsx_runtime.jsx)("p", {
						className: `text-sm font-medium ${chrome.emptyTitleClass}`,
						children: "Blank workflow"
					}),
					(0, import_jsx_runtime.jsx)("p", {
						className: `max-w-sm text-xs ${chrome.emptyHelpClass}`,
						children: emptyStateHelpText
					}),
					onEmptyStateAction && (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						className: "mt-1 rounded-md border border-border/40 bg-bg/40 px-3 py-1.5 text-xs text-txt hover:bg-bg/70 transition-colors",
						onClick: onEmptyStateAction,
						children: emptyStateActionLabel
					})
				]
			}),
			isGenerating && (0, import_jsx_runtime.jsx)("div", {
				className: "absolute inset-0 z-10 flex items-center justify-center backdrop-blur-[1px]",
				style: { background: chrome.overlayBg },
				children: (0, import_jsx_runtime.jsx)(WorkflowGenerationProgress, { chrome })
			}),
			!loading && (0, import_jsx_runtime.jsx)("div", {
				role: "presentation",
				className: "h-full w-full",
				onClick: (e) => e.stopPropagation(),
				onKeyDown: (e) => e.stopPropagation(),
				children: (0, import_jsx_runtime.jsxs)(index, {
					nodes,
					edges: isGenerating ? generatingEdges(edges) : edges,
					nodesDraggable: !isGenerating,
					nodesConnectable: false,
					edgesReconnectable: false,
					onNodeClick: handleNodeClick,
					fitView: true,
					fitViewOptions: {
						padding: .2,
						maxZoom: 1.2
					},
					proOptions: { hideAttribution: true },
					"aria-label": ariaLabel,
					children: [
						(0, import_jsx_runtime.jsx)(Background, {
							color: chrome.dots,
							gap: 20,
							size: 1
						}),
						(0, import_jsx_runtime.jsx)(Controls, { showInteractive: false }),
						hasNodes && (0, import_jsx_runtime.jsx)(MiniMap, {
							nodeColor: (n) => {
								return (n.data?.colors)?.border ?? "#475569";
							},
							maskColor: chrome.minimapMask,
							style: {
								background: chrome.minimapBg,
								border: `1px solid ${chrome.minimapBorder}`
							}
						})
					]
				})
			}),
			hasNodes && !isGenerating && (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				"aria-label": "Full screen",
				className: [
					"absolute top-3 z-20 flex h-7 w-7 items-center justify-center",
					"rounded border border-border/40 bg-bg/80 text-muted hover:text-txt transition-all duration-200",
					selectedNode ? "right-[calc(18rem_+_0.75rem)]" : "right-3"
				].join(" "),
				onClick: () => setFullScreen(true),
				children: (0, import_jsx_runtime.jsx)(Maximize2, { className: "h-3.5 w-3.5" })
			}),
			editorUrl && !isGenerating && (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				"aria-label": "Open in n8n editor",
				className: "absolute right-12 top-3 z-20 rounded border border-border/40 bg-bg/80 px-2.5 py-1 text-xs text-muted transition-colors hover:text-txt",
				onClick: () => window.open(editorUrl, "_blank", "noopener"),
				children: "Open in n8n"
			}),
			!fullScreen && (0, import_jsx_runtime.jsx)(NodeDetailDrawer, {
				node: selectedNode,
				workflow,
				status,
				onClose: handleCloseDrawer,
				labelId: drawerLabelId
			})
		]
	}), (0, import_jsx_runtime.jsx)(Dialog, {
		open: fullScreen,
		onOpenChange: setFullScreen,
		children: (0, import_jsx_runtime.jsxs)(DialogContent, {
			className: "h-[90dvh] w-[90vw] !max-w-none !max-h-none flex flex-col p-0 gap-0",
			showCloseButton: false,
			children: [(0, import_jsx_runtime.jsxs)(DialogHeader, {
				className: "flex flex-row items-center justify-between border-b border-border/30 px-4 py-3 shrink-0",
				children: [(0, import_jsx_runtime.jsx)(DialogTitle, {
					className: "text-sm font-medium",
					children: workflow?.name ?? "Workflow Graph"
				}), (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					"aria-label": "Close",
					className: "flex h-7 w-7 items-center justify-center rounded text-muted hover:text-txt transition-colors",
					onClick: () => setFullScreen(false),
					children: (0, import_jsx_runtime.jsx)(X, { className: "h-4 w-4" })
				})]
			}), (0, import_jsx_runtime.jsxs)("div", {
				className: "relative flex-1 min-h-0 overflow-hidden",
				style: { background: chrome.canvasBg },
				children: [(0, import_jsx_runtime.jsx)(GraphPanel, {
					nodes,
					edges,
					isGenerating,
					ariaLabel,
					onNodeClick: handleNodeClick,
					uiTheme
				}), (0, import_jsx_runtime.jsx)(NodeDetailDrawer, {
					node: selectedNode,
					workflow,
					status,
					onClose: handleCloseDrawer,
					labelId: drawerLabelId
				})]
			})]
		})
	})] });
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/workflow-graph-events.js
const VISUALIZE_WORKFLOW_EVENT = "eliza:automations:visualize-workflow";

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/components/pages/AutomationsView.js
/**
* AutomationsView — list/detail UI for tasks and n8n workflows.
*/
var AutomationsView_exports = /* @__PURE__ */ __exportAll({
	AutomationsDesktopShell: () => AutomationsDesktopShell,
	AutomationsView: () => AutomationsView
});
const WORKFLOW_DRAFT_TITLE = "New Workflow Draft";
const WORKFLOW_SYSTEM_ADDENDUM = "You are in a workflow-specific automation room. Focus only on this workflow. Use the linked terminal conversation only when it directly informs the workflow. Request keys and connector setup when needed, and prefer owner-scoped LifeOps integrations for personal services.";
const AUTOMATION_DRAFT_SYSTEM_ADDENDUM = "You are in an automation-creation room. The user wants to create one automation. Decide whether it should be a task or a workflow and call the matching action exactly once:\n- Task: a simple prompt that runs on a schedule or from an event, for example \"every morning summarize my inbox\" or \"when I get a GitHub notification, make a todo\". Use CREATE_TRIGGER_TASK with a clear displayName, instructions, and any needed schedule.\n- Workflow: a multi-step n8n pipeline with deterministic steps and integrations, for example \"when a Slack message matches X, post to Discord and log it\". Create an n8n workflow via the n8n actions.\nAsk one short clarifying question only if the shape is genuinely ambiguous; otherwise create immediately. After creation, briefly confirm what you made and how it starts.";
const NODE_CLASS_ORDER = [
	"agent",
	"action",
	"context",
	"integration",
	"trigger",
	"flow-control"
];
const PAGE_CHAT_PREFILL_EVENT = "eliza:chat:prefill";
const DESCRIBE_WORKFLOW_PROMPT = "Describe your workflow";
const DESCRIBE_AUTOMATION_PROMPT = "What should happen?";
const WORKFLOW_PROMPT_PLACEHOLDER = "Describe the trigger and steps, e.g. when a GitHub issue opens, summarize it and post to Discord";
const AUTOMATION_PROMPT_PLACEHOLDER = "e.g. Every morning summarize my inbox, or when a GitHub issue opens, triage it";
const AUTOMATIONS_OVERVIEW_VISIBILITY_EVENT = "eliza:automations:overview-visibility";
function createWorkflowDraftId() {
	return globalThis.crypto.randomUUID();
}
function prefillPageChat(text, options) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(PAGE_CHAT_PREFILL_EVENT, { detail: {
		text,
		select: options?.select ?? true
	} }));
}
function buildWorkflowCopyRequest(workflow, name) {
	return {
		name,
		nodes: workflow.nodes?.map((node) => ({
			name: node.name,
			type: node.type,
			typeVersion: node.typeVersion ?? 1,
			position: node.position ?? [0, 0],
			parameters: node.parameters ?? {},
			...node.notes ? { notes: node.notes } : {},
			...node.notesInFlow !== void 0 ? { notesInFlow: node.notesInFlow } : {}
		})) ?? [],
		connections: workflow.connections ?? {},
		settings: {}
	};
}
function inferAutomationPromptKind(prompt) {
	const normalized = prompt.toLowerCase();
	const looksScheduledTask = /\b(every|daily|hourly|weekly|monthly|weekday|morning|evening|at \d{1,2})\b/.test(normalized);
	const looksWorkflow = /\b(when|if|after|then|workflow|pipeline|webhook|event|triage|route|label|enrich|crm)\b/.test(normalized) || normalized.includes(" and ") && /\b(send|post|create|update|reply|notify|summarize)\b/.test(normalized);
	if (looksScheduledTask && !normalized.includes("when ")) return "task";
	return looksWorkflow ? "workflow" : "task";
}
function titleFromAutomationPrompt(prompt) {
	const cleaned = prompt.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return "New task";
	const title = cleaned.split(" ").slice(0, 7).join(" ");
	return title.charAt(0).toUpperCase() + title.slice(1);
}
const AUTOMATIONS_TRIGGER_HASH_KEY = "automations.trigger";
function readAutomationsTriggerFromHash() {
	if (typeof window === "undefined") return null;
	const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
	if (!raw) return null;
	for (const chunk of raw.split("&")) {
		if (!chunk) continue;
		const eq = chunk.indexOf("=");
		if (eq < 0) continue;
		try {
			if (decodeURIComponent(chunk.slice(0, eq)) !== AUTOMATIONS_TRIGGER_HASH_KEY) continue;
			return decodeURIComponent(chunk.slice(eq + 1)) || null;
		} catch {}
	}
	return null;
}
function getNavigationPathFromWindow() {
	if (typeof window === "undefined") return "/";
	return window.location.protocol === "file:" ? window.location.hash.replace(/^#/, "") || "/" : window.location.pathname || "/";
}
function normalizeAutomationPath(pathname) {
	if (!pathname) return "/";
	const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
function getAutomationSubpageFromPath(pathname) {
	const normalized = normalizeAutomationPath(pathname);
	if (normalized === "/node-catalog" || normalized === "/automations/node-catalog") return "node-catalog";
	return "list";
}
function getPathForAutomationSubpage(subpage) {
	return subpage === "node-catalog" ? "/automations/node-catalog" : "/automations";
}
function syncAutomationSubpagePath(subpage, mode = "push") {
	if (typeof window === "undefined") return;
	const nextPath = getPathForAutomationSubpage(subpage);
	if (normalizeAutomationPath(getNavigationPathFromWindow()) === nextPath) return;
	if (window.location.protocol === "file:") {
		window.location.hash = nextPath;
		return;
	}
	window.history[mode === "replace" ? "replaceState" : "pushState"](null, "", nextPath);
}
function getSelectionKind(item) {
	if (!item) return null;
	if (item.type === "n8n_workflow") return "workflow";
	if (item.task) return "task";
	if (item.trigger) return "trigger";
	return null;
}
function getAutomationDisplayTitle(item) {
	return item.isDraft ? "Draft" : item.title;
}
function getOverviewDisplayTitle(item) {
	if (!item.isDraft) return getAutomationDisplayTitle(item);
	if (item.type === "automation_draft") return "Draft automation";
	return `Draft ${getAutomationGroupLabel(item).toLowerCase()}`;
}
function getAutomationGroupLabel(item) {
	if (item.type === "n8n_workflow") return "Workflow";
	if (item.system) return "Agent owned";
	return "Task";
}
function isTimeBasedTrigger(trigger) {
	return trigger.triggerType !== "event";
}
function formatScheduleCount(count) {
	return count === 1 ? "1 schedule" : `${count} schedules`;
}
function getAutomationBridgeIdForItem(item, activeConversationId, conversations) {
	return item?.room?.terminalBridgeConversationId ?? item?.room?.sourceConversationId ?? getAutomationBridgeConversationId(activeConversationId, conversations);
}
function getWorkflowNodeCount(item) {
	return item.workflow?.nodeCount ?? item.workflow?.nodes?.length ?? 0;
}
function getAutomationIndicatorTone(item) {
	if (item.type === "n8n_workflow") return item.enabled ? "accent" : void 0;
	if (item.task) return item.task.isCompleted ? void 0 : "accent";
	if (item.trigger) return item.trigger.enabled ? "accent" : void 0;
}
function getTriggerWakeModeLabel(trigger) {
	return trigger.wakeMode === "inject_now" ? "Interrupt and run now" : "Queue for next cycle";
}
function getTriggerStartModeLabel(trigger) {
	if (trigger.triggerType === "once") return "One time";
	if (trigger.triggerType === "cron") return "Cron schedule";
	if (trigger.triggerType === "event") return "Event";
	return "Repeating";
}
function buildTriggerSchedulePrompt(trigger) {
	if (trigger.triggerType === "interval") return `Schedule: interval every ${trigger.intervalMs ?? 0}ms.`;
	if (trigger.triggerType === "once") return `Schedule: run once at ${trigger.scheduledAtIso ?? "an unspecified time"}.`;
	if (trigger.triggerType === "cron") return `Schedule: cron ${trigger.cronExpression ?? ""}.`;
	if (trigger.triggerType === "event") return `Event: ${trigger.eventKind ?? "event"}.`;
	return `Schedule type: ${trigger.triggerType}.`;
}
function buildWorkflowCompilationPrompt(item) {
	const lines = [
		"Compile this coordinator automation into an n8n workflow.",
		`Automation title: ${item.title}`,
		`Description: ${item.description || "No additional description provided."}`,
		"Keep the workflow in this dedicated automation room.",
		"Use runtime actions and providers as workflow nodes when they fit the job.",
		"Use owner-scoped LifeOps nodes for Gmail, Calendar, Signal, Telegram, Discord, and GitHub when they are set up. If not, request the required setup or keys."
	];
	if (item.task) lines.push(`Task description: ${item.task.description || "No task description."}`);
	if (item.trigger) {
		lines.push(`Coordinator instructions: ${item.trigger.instructions}`);
		lines.push(buildTriggerSchedulePrompt(item.trigger));
	}
	if (item.schedules.length > 0) {
		lines.push("Existing schedules:");
		for (const schedule of item.schedules) lines.push(`- ${buildTriggerSchedulePrompt(schedule)}`);
	}
	lines.push("Ask follow-up questions only when workflow intent is genuinely ambiguous.");
	return lines.join("\n");
}
function getNodeClassLabel(className) {
	switch (className) {
		case "agent": return "Agent";
		case "action": return "Actions";
		case "context": return "Context";
		case "integration": return "Integrations";
		case "trigger": return "Triggers";
		case "flow-control": return "Flow Control";
		default: return className;
	}
}
function getNodeIcon(node) {
	if (node.source === "lifeops_event") return (0, import_jsx_runtime.jsx)(Zap, { className: "h-3.5 w-3.5" });
	if (node.source === "lifeops") {
		if (node.id === "lifeops:gmail") return (0, import_jsx_runtime.jsx)(Mail, { className: "h-3.5 w-3.5" });
		if (node.id === "lifeops:signal") return (0, import_jsx_runtime.jsx)(Signal, { className: "h-3.5 w-3.5" });
		if (node.id === "lifeops:github") return (0, import_jsx_runtime.jsx)(GitBranch, { className: "h-3.5 w-3.5" });
	}
	if (node.class === "agent") return (0, import_jsx_runtime.jsx)(SquareTerminal, { className: "h-3.5 w-3.5" });
	if (node.class === "integration") return (0, import_jsx_runtime.jsx)(Workflow, { className: "h-3.5 w-3.5" });
	if (node.class === "context") return (0, import_jsx_runtime.jsx)(Settings, { className: "h-3.5 w-3.5" });
	if (node.class === "trigger") return (0, import_jsx_runtime.jsx)(Clock3, { className: "h-3.5 w-3.5" });
	return (0, import_jsx_runtime.jsx)(Zap, { className: "h-3.5 w-3.5" });
}
function useAutomationsViewController() {
	const { triggers = [], triggersLoaded = false, triggersLoading = false, triggersSaving = false, triggerRunsById = {}, triggerError = null, loadTriggers = async () => {}, createTrigger = async () => null, updateTrigger = async () => null, deleteTrigger = async () => true, runTriggerNow = async () => true, loadTriggerRuns = async () => {}, loadTriggerHealth = async () => {}, ensureTriggersLoaded = async () => {
		await loadTriggers(triggersLoaded ? { silent: true } : void 0);
	}, t, uiLanguage } = useApp();
	const [taskError, setTaskError] = useState(null);
	const [taskSaving, setTaskSaving] = useState(false);
	const [form, setForm] = useState(emptyForm);
	const [editingId, setEditingId] = useState(null);
	const [selectedItemId, setSelectedItemId] = useState(null);
	const [selectedItemKind, setSelectedItemKind] = useState(null);
	const [formError, setFormError] = useState(null);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editorMode, setEditorMode] = useState("trigger");
	const [userTemplates, setUserTemplates] = useState(loadUserTemplates);
	const [templateNotice, setTemplateNotice] = useState(null);
	const [taskFormName, setTaskFormName] = useState("");
	const [taskFormDescription, setTaskFormDescription] = useState("");
	const [editingTaskId, setEditingTaskId] = useState(null);
	const [filter, setFilter] = useState("all");
	const [automationItems, setAutomationItems] = useState([]);
	const [automationNodes, setAutomationNodes] = useState([]);
	const [automationsLoading, setAutomationsLoading] = useState(false);
	const [automationsLoaded, setAutomationsLoaded] = useState(false);
	const [automationsError, setAutomationsError] = useState(null);
	const [n8nStatus, setN8nStatus] = useState(null);
	const [workflowFetchError, setWorkflowFetchError] = useState(null);
	const didBootstrapDataRef = useRef(false);
	const lastSelectedIdRef = useRef(null);
	const refreshAutomations = useCallback(async () => {
		setAutomationsLoading(true);
		try {
			const [automationData, nodeCatalog] = await Promise.all([client.listAutomations(), client.getAutomationNodeCatalog()]);
			setAutomationItems(automationData.automations ?? []);
			setAutomationNodes(nodeCatalog.nodes ?? []);
			setN8nStatus(automationData.n8nStatus ?? null);
			setWorkflowFetchError(automationData.workflowFetchError ?? null);
			setAutomationsError(null);
			return automationData;
		} catch (error) {
			setAutomationsError(error instanceof Error ? error.message : t("automations.loadFailed", { defaultValue: "Failed to load automations." }));
			return null;
		} finally {
			setAutomationsLoaded(true);
			setAutomationsLoading(false);
		}
	}, [t]);
	const createWorkbenchTask = useCallback(async (data) => {
		setTaskSaving(true);
		try {
			const res = await client.createWorkbenchTask(data);
			setTaskError(null);
			await refreshAutomations();
			return res.task;
		} catch (error) {
			setTaskError(error instanceof Error ? error.message : t("automations.taskCreateFailed", { defaultValue: "Failed to create task." }));
			return null;
		} finally {
			setTaskSaving(false);
		}
	}, [refreshAutomations, t]);
	const updateWorkbenchTask = useCallback(async (id, data) => {
		setTaskSaving(true);
		try {
			const res = await client.updateWorkbenchTask(id, data);
			setTaskError(null);
			await refreshAutomations();
			return res.task;
		} catch (error) {
			setTaskError(error instanceof Error ? error.message : t("automations.taskUpdateFailed", { defaultValue: "Failed to update task." }));
			return null;
		} finally {
			setTaskSaving(false);
		}
	}, [refreshAutomations, t]);
	const deleteWorkbenchTask = useCallback(async (id) => {
		setTaskSaving(true);
		try {
			await client.deleteWorkbenchTask(id);
			setTaskError(null);
			await refreshAutomations();
			return true;
		} catch (error) {
			setTaskError(error instanceof Error ? error.message : t("automations.taskDeleteFailed", { defaultValue: "Failed to delete task." }));
			return false;
		} finally {
			setTaskSaving(false);
		}
	}, [refreshAutomations, t]);
	const saveFormAsTemplate = useCallback(() => {
		const name = form.displayName.trim();
		if (!name) return;
		const template = {
			id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			name,
			instructions: form.instructions.trim(),
			interval: form.durationValue || "1",
			unit: form.durationUnit
		};
		setUserTemplates((previous) => {
			const next = [...previous, template];
			saveUserTemplates(next);
			return next;
		});
	}, [form]);
	const deleteUserTemplate = useCallback((id) => {
		setUserTemplates((previous) => {
			const next = previous.filter((template) => template.id !== id);
			saveUserTemplates(next);
			return next;
		});
	}, []);
	useEffect(() => {
		if (didBootstrapDataRef.current) return;
		didBootstrapDataRef.current = true;
		loadTriggerHealth();
		ensureTriggersLoaded();
		refreshAutomations();
	}, [
		ensureTriggersLoaded,
		loadTriggerHealth,
		refreshAutomations
	]);
	useEffect(() => {
		const handler = (event) => {
			const detail = event.detail;
			if (detail?.filter) setFilter(detail.filter);
		};
		window.addEventListener("eliza:automations:setFilter", handler);
		return () => window.removeEventListener("eliza:automations:setFilter", handler);
	}, []);
	const allItems = automationItems;
	const filteredItems = useMemo(() => {
		switch (filter) {
			case "coordinator": return allItems.filter((item) => item.type === "coordinator_text");
			case "workflows": return allItems.filter((item) => item.type === "n8n_workflow");
			case "scheduled": return allItems.filter((item) => item.schedules.length > 0);
			default: return allItems;
		}
	}, [allItems, filter]);
	useEffect(() => {
		if (!selectedItemId) return;
		if (selectedItemId.startsWith("workflow-draft:")) return;
		if (!allItems.some((item) => item.id === selectedItemId)) {
			setSelectedItemId(null);
			setSelectedItemKind(null);
		}
	}, [allItems, selectedItemId]);
	useEffect(() => {
		if (selectedItemId) lastSelectedIdRef.current = selectedItemId;
	}, [selectedItemId]);
	useEffect(() => {
		if (editorOpen || editingId || editingTaskId || selectedItemId || allItems.length === 0) return;
		const preferred = lastSelectedIdRef.current;
		if (!preferred) return;
		const item = allItems.find((candidate) => candidate.id === preferred);
		if (!item) return;
		setSelectedItemId(preferred);
		setSelectedItemKind(getSelectionKind(item));
	}, [
		allItems,
		editingId,
		editingTaskId,
		editorOpen,
		selectedItemId
	]);
	useEffect(() => {
		if (!editorOpen) return void 0;
		const onKeyDown = (event) => {
			if (event.key === "Escape") {
				setEditorOpen(false);
				setEditingId(null);
				setEditingTaskId(null);
				setForm(emptyForm);
				setFormError(null);
				setTaskFormName("");
				setTaskFormDescription("");
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [editorOpen]);
	useEffect(() => {
		function applyHash() {
			const hashTriggerId = readAutomationsTriggerFromHash();
			if (!hashTriggerId) return;
			const nextId = `trigger:${hashTriggerId}`;
			setSelectedItemId((prev) => prev === nextId ? prev : nextId);
			setSelectedItemKind("trigger");
		}
		applyHash();
		window.addEventListener("hashchange", applyHash);
		return () => window.removeEventListener("hashchange", applyHash);
	}, []);
	const resetEditor = () => {
		setForm(emptyForm);
		setEditingId(null);
		setEditingTaskId(null);
		setFormError(null);
		setTaskFormName("");
		setTaskFormDescription("");
	};
	const closeEditor = () => {
		setEditorOpen(false);
		resetEditor();
	};
	const openCreateTrigger = () => {
		resetEditor();
		setEditorMode("trigger");
		setEditorOpen(true);
	};
	const openCreateTask = () => {
		openCreateTrigger();
	};
	const openEditTrigger = (trigger) => {
		setEditingId(trigger.id);
		setForm(formFromTrigger(trigger));
		setFormError(null);
		setSelectedItemId(`trigger:${trigger.id}`);
		setSelectedItemKind("trigger");
		setEditorMode("trigger");
		setEditorOpen(true);
	};
	const openEditTask = (task) => {
		setEditingTaskId(task.id);
		setTaskFormName(task.name);
		setTaskFormDescription(task.description);
		setSelectedItemId(`task:${task.id}`);
		setSelectedItemKind("task");
		setEditorMode("task");
		setEditorOpen(true);
	};
	const setField = (key, value) => setForm((previous) => ({
		...previous,
		[key]: value
	}));
	const onSubmitTrigger = async () => {
		const error = validateForm(form, t);
		if (error) {
			setFormError(error);
			return;
		}
		setFormError(null);
		if (editingId) {
			const updated = await updateTrigger(editingId, buildUpdateRequest(form));
			if (updated) {
				if (updated.kind === "workflow" && updated.workflowId) {
					setSelectedItemId(`workflow:${updated.workflowId}`);
					setSelectedItemKind("workflow");
				} else {
					setSelectedItemId(`trigger:${updated.id}`);
					setSelectedItemKind("trigger");
				}
				await refreshAutomations();
				closeEditor();
			}
			return;
		}
		const created = await createTrigger(buildCreateRequest(form));
		if (created) {
			if (created.kind === "workflow" && created.workflowId) {
				setSelectedItemId(`workflow:${created.workflowId}`);
				setSelectedItemKind("workflow");
			} else {
				setSelectedItemId(`trigger:${created.id}`);
				setSelectedItemKind("trigger");
			}
			loadTriggerRuns(created.id);
			await refreshAutomations();
			closeEditor();
		}
	};
	const onSubmitTask = async () => {
		const name = taskFormName.trim();
		if (!name) {
			setFormError(t("automations.nameRequired", { defaultValue: "Name is required." }));
			return;
		}
		setFormError(null);
		if (editingTaskId) {
			const updated = await updateWorkbenchTask(editingTaskId, {
				name,
				description: taskFormDescription.trim()
			});
			if (updated) {
				setSelectedItemId(`task:${updated.id}`);
				setSelectedItemKind("task");
				closeEditor();
			}
			return;
		}
		const created = await createWorkbenchTask({
			name,
			description: taskFormDescription.trim()
		});
		if (created) {
			setSelectedItemId(`task:${created.id}`);
			setSelectedItemKind("task");
			closeEditor();
		}
	};
	const onDeleteTrigger = async (triggerId, displayName) => {
		const targetId = triggerId ?? editingId;
		if (!targetId) return;
		if (!await confirmDesktopAction({
			title: t("heartbeatsview.deleteTitle"),
			message: t("heartbeatsview.deleteMessage", { name: displayName ?? form.displayName }),
			confirmLabel: t("common.delete"),
			cancelLabel: t("common.cancel"),
			type: "warning"
		})) return;
		if (!await deleteTrigger(targetId)) return;
		if (selectedItemId === `trigger:${targetId}`) {
			setSelectedItemId(null);
			setSelectedItemKind(null);
		}
		await refreshAutomations();
		if (targetId === editingId) closeEditor();
	};
	const onDeleteTask = async (taskId) => {
		if (!await confirmDesktopAction({
			title: t("automations.taskDeleteTitle", { defaultValue: "Delete task" }),
			message: t("automations.taskDeleteMessage", { defaultValue: "Are you sure you want to delete this task?" }),
			confirmLabel: t("common.delete"),
			cancelLabel: t("common.cancel"),
			type: "warning"
		})) return;
		if (!await deleteWorkbenchTask(taskId)) return;
		if (selectedItemId === `task:${taskId}`) {
			setSelectedItemId(null);
			setSelectedItemKind(null);
		}
		if (editingTaskId === taskId) closeEditor();
	};
	const onRunSelectedTrigger = async (triggerId) => {
		setSelectedItemId(`trigger:${triggerId}`);
		setSelectedItemKind("trigger");
		await runTriggerNow(triggerId);
		await loadTriggerRuns(triggerId);
		await refreshAutomations();
	};
	const onToggleTriggerEnabled = async (triggerId, currentlyEnabled) => {
		const updated = await updateTrigger(triggerId, { enabled: !currentlyEnabled });
		if (updated && editingId === updated.id) setForm(formFromTrigger(updated));
		await refreshAutomations();
	};
	const onToggleTaskCompleted = async (taskId, currentlyCompleted) => {
		await updateWorkbenchTask(taskId, { isCompleted: !currentlyCompleted });
	};
	const resolvedSelectedItem = useMemo(() => {
		if (editorOpen || editingId || editingTaskId) return null;
		if (selectedItemId) {
			const found = allItems.find((item) => item.id === selectedItemId);
			if (found) return found;
			if (selectedItemId.startsWith("workflow-draft:")) return {
				id: selectedItemId,
				type: "automation_draft",
				source: "workflow_draft",
				title: "New workflow",
				description: "",
				status: "draft",
				enabled: false,
				system: false,
				isDraft: true,
				hasBackingWorkflow: false,
				updatedAt: null,
				draftId: selectedItemId.slice(15),
				schedules: [],
				room: null
			};
			return null;
		}
		return allItems[0] ?? null;
	}, [
		allItems,
		editingId,
		editingTaskId,
		editorOpen,
		selectedItemId
	]);
	const modalTitle = editorMode === "trigger" ? form.kind === "workflow" ? editingId ? `Edit ${form.displayName.trim() || "schedule"}` : "New schedule" : editingId ? t("heartbeatsview.editTitle", {
		name: form.displayName.trim() || t("automations.taskLabel", { defaultValue: "Task" }),
		defaultValue: "Edit {{name}}"
	}) : t("automations.newTask", { defaultValue: "New task" }) : editingTaskId ? t("automations.editTask", { defaultValue: "Edit task" }) : t("automations.newTextTask", { defaultValue: "New text task" });
	const editorEnabled = editingId != null ? triggers.find((trigger) => trigger.id === editingId)?.enabled ?? form.enabled : form.enabled;
	const hasItems = allItems.length > 0;
	const isLoading = triggersLoading || automationsLoading;
	const combinedError = automationsError || triggerError || taskError;
	return {
		filter,
		setFilter,
		allItems,
		filteredItems,
		selectedItemId,
		selectedItemKind,
		setSelectedItemId,
		setSelectedItemKind,
		resolvedSelectedItem,
		form,
		setForm,
		setField,
		editingId,
		setEditingId,
		editorOpen,
		setEditorOpen,
		editorMode,
		setEditorMode,
		formError,
		setFormError,
		editorEnabled,
		modalTitle,
		templateNotice,
		setTemplateNotice,
		userTemplates,
		taskFormName,
		setTaskFormName,
		taskFormDescription,
		setTaskFormDescription,
		editingTaskId,
		setEditingTaskId,
		taskSaving,
		closeEditor,
		openCreateTrigger,
		openCreateTask,
		openEditTrigger,
		openEditTask,
		onSubmitTrigger,
		onSubmitTask,
		onDeleteTrigger,
		onDeleteTask,
		onRunSelectedTrigger,
		onToggleTriggerEnabled,
		onToggleTaskCompleted,
		saveFormAsTemplate,
		deleteUserTemplate,
		loadTriggerRuns,
		refreshAutomations,
		automationNodes,
		automationsLoading,
		automationsLoaded,
		automationsError,
		n8nStatus,
		workflowFetchError,
		triggers,
		triggerRunsById,
		triggersSaving,
		triggersLoading,
		triggerError,
		taskError,
		hasItems,
		isLoading,
		combinedError,
		showFirstRunEmptyState: !isLoading && !combinedError && !hasItems,
		showDetailPane: Boolean(editorOpen || editingId || editingTaskId || resolvedSelectedItem),
		t,
		uiLanguage
	};
}
const AutomationsViewContext = createContext(null);
function useAutomationsViewContext() {
	const context = useContext(AutomationsViewContext);
	if (!context) throw new Error("Automations view context is unavailable.");
	return context;
}
function AutomationCollapsibleSection({ sectionKey, label, icon, count, collapsed, onToggleCollapsed, onAdd, addLabel, emptyLabel, children }) {
	const Chevron = collapsed ? ChevronRight : ChevronDown;
	return (0, import_jsx_runtime.jsxs)("section", {
		"data-testid": `automation-section-${sectionKey}`,
		className: "group/section space-y-0",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-1",
			children: [(0, import_jsx_runtime.jsxs)("button", {
				type: "button",
				onClick: () => onToggleCollapsed(sectionKey),
				"aria-expanded": !collapsed,
				className: "inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] bg-transparent px-1.5 py-1 text-left text-2xs font-semibold uppercase tracking-[0.16em] text-muted transition-colors hover:text-txt",
				children: [
					(0, import_jsx_runtime.jsx)("span", {
						className: "inline-flex shrink-0 items-center justify-center text-muted",
						children: icon
					}),
					(0, import_jsx_runtime.jsx)("span", {
						className: "truncate",
						children: label
					}),
					(0, import_jsx_runtime.jsx)(Chevron, {
						"aria-hidden": true,
						className: "ml-auto h-3 w-3 shrink-0 text-muted"
					})
				]
			}), onAdd ? (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				onClick: onAdd,
				"aria-label": addLabel ?? "Add",
				title: addLabel,
				className: "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt",
				children: (0, import_jsx_runtime.jsx)(Plus, {
					className: "h-3.5 w-3.5",
					"aria-hidden": true
				})
			}) : null]
		}), collapsed ? null : count === 0 ? (0, import_jsx_runtime.jsx)("div", {
			className: "py-1 pl-8 pr-1 text-2xs text-muted/70",
			children: emptyLabel
		}) : (0, import_jsx_runtime.jsx)("div", {
			className: "space-y-0 pl-3 pr-0.5",
			children
		})]
	});
}
function getWorkflowTemplates(t) {
	return [
		{
			id: "daily-email-digest",
			icon: Mail,
			title: t("automations.templates.emailDigest.title", { defaultValue: "Daily Email Digest" }),
			description: t("automations.templates.emailDigest.desc", { defaultValue: "Summarize your inbox each morning and post to Slack." }),
			seedPrompt: t("automations.templates.emailDigest.prompt", { defaultValue: "Every weekday at 9am, read my Gmail inbox from the last 24 hours, summarize the important messages, and post the summary to my #daily channel in Slack." })
		},
		{
			id: "slack-discord-bridge",
			icon: Share2,
			title: "Slack ↔ Discord Bridge",
			description: "Cross-post messages between Slack and Discord channels.",
			seedPrompt: "Whenever a message is posted in the #announcements channel in Slack, forward it to the #general channel in Discord."
		},
		{
			id: "rss-to-summary",
			icon: Rss,
			title: "RSS to Summary",
			description: "Poll an RSS feed and summarize new articles via email.",
			seedPrompt: "Check my RSS feed https://example.com/feed.xml every hour. For each new article, generate a 3-sentence summary and email it to me."
		},
		{
			id: "calendar-to-slack",
			icon: Calendar,
			title: "Calendar to Slack",
			description: "Post your day's agenda to Slack each morning.",
			seedPrompt: "Every weekday at 8am, read today's events from my Google Calendar and post a formatted agenda to my #daily-standup channel in Slack."
		},
		{
			id: "github-issue-triage",
			icon: GitBranch,
			title: "GitHub Issue Triage",
			description: "Auto-classify and label new GitHub issues.",
			seedPrompt: "When a new issue is opened on my GitHub repo, classify it (bug/feature/question/docs), add the matching label, and post a welcoming comment."
		},
		{
			id: "email-to-notion",
			icon: FileText,
			title: "Email → Notion",
			description: "Turn tagged emails into Notion pages.",
			seedPrompt: "When I receive a Gmail message labeled 'Task', extract the key details and create a new page in my Notion 'Inbox' database with the subject as the title and body as content."
		}
	];
}
function WorkflowTemplatesModal({ open, onOpenChange, onSelectTemplate, onSelectCustom }) {
	const { t } = useAutomationsViewContext();
	const templates = getWorkflowTemplates(t);
	return (0, import_jsx_runtime.jsx)(Dialog, {
		open,
		onOpenChange,
		children: (0, import_jsx_runtime.jsxs)(DialogContent, {
			className: "w-[min(calc(100vw_-_1.5rem),56rem)] max-w-none",
			children: [(0, import_jsx_runtime.jsxs)(DialogHeader, { children: [(0, import_jsx_runtime.jsx)(DialogTitle, { children: t("automations.templatesModalTitle", { defaultValue: "Start with a template" }) }), (0, import_jsx_runtime.jsx)(DialogDescription, { children: t("automations.templatesModalSubtitle", { defaultValue: "Pick a workflow to customize, or start blank." }) })] }), (0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-3 overflow-y-auto pr-1 sm:grid-cols-2 max-h-[min(32rem,calc(100dvh_-_12rem))]",
				children: [templates.map((template) => {
					const Icon = template.icon;
					return (0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-col gap-3 rounded-xl border border-border/40 bg-bg/30 p-4 hover:border-accent/30 hover:bg-accent/5 transition-colors",
						children: [(0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-start gap-3",
							children: [(0, import_jsx_runtime.jsx)("div", {
								className: "mt-0.5 rounded-lg bg-accent/10 p-2 text-accent shrink-0",
								children: (0, import_jsx_runtime.jsx)(Icon, { className: "h-4 w-4" })
							}), (0, import_jsx_runtime.jsxs)("div", {
								className: "min-w-0 flex-1 space-y-1",
								children: [(0, import_jsx_runtime.jsx)("div", {
									className: "text-sm font-semibold text-txt",
									children: template.title
								}), (0, import_jsx_runtime.jsx)("p", {
									className: "text-sm text-muted leading-snug",
									children: template.description
								})]
							})]
						}), (0, import_jsx_runtime.jsx)(Button, {
							variant: "outline",
							size: "sm",
							className: "self-end h-7 px-3 text-xs",
							onClick: () => onSelectTemplate(template.seedPrompt),
							children: t("automations.templateUseButton", { defaultValue: "Use template" })
						})]
					}, template.id);
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-3 rounded-xl border border-dashed border-border/40 bg-transparent p-4 hover:border-accent/30 hover:bg-accent/5 transition-colors",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-start gap-3",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "mt-0.5 rounded-lg bg-muted/10 p-2 text-muted shrink-0",
							children: (0, import_jsx_runtime.jsx)(Plus, { className: "h-4 w-4" })
						}), (0, import_jsx_runtime.jsxs)("div", {
							className: "min-w-0 flex-1 space-y-1",
							children: [(0, import_jsx_runtime.jsx)("div", {
								className: "text-sm font-semibold text-txt",
								children: t("automations.templateCustom.title", { defaultValue: "Custom" })
							}), (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-muted leading-snug",
								children: t("automations.templateCustom.desc", { defaultValue: "Describe your own workflow in chat." })
							})]
						})]
					}), (0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "self-end h-7 px-3 text-xs",
						onClick: onSelectCustom,
						children: t("automations.templateUseButton", { defaultValue: "Use template" })
					})]
				})]
			})]
		})
	});
}
function CreateAutomationDialog({ open, onOpenChange, onCreateTask, onCreateWorkflow, onDescribeAutomation }) {
	return (0, import_jsx_runtime.jsx)(Dialog, {
		open,
		onOpenChange,
		children: (0, import_jsx_runtime.jsxs)(DialogContent, {
			className: "w-[min(calc(100vw_-_1.5rem),34rem)] max-w-none",
			children: [
				(0, import_jsx_runtime.jsx)(DialogHeader, { children: (0, import_jsx_runtime.jsx)(DialogTitle, { children: "Create automation" }) }),
				(0, import_jsx_runtime.jsx)(AutomationCommandBar, {
					autoFocus: true,
					onSubmit: async (prompt) => {
						await onDescribeAutomation(prompt);
						onOpenChange(false);
					}
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "grid gap-3 sm:grid-cols-2",
					children: [(0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: onCreateTask,
						className: "rounded-xl border border-border/30 bg-bg/30 p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent/5",
						children: (0, import_jsx_runtime.jsx)("div", {
							className: "text-sm font-semibold text-txt",
							children: "Task"
						})
					}), (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: onCreateWorkflow,
						className: "rounded-xl border border-border/30 bg-bg/30 p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent/5",
						children: (0, import_jsx_runtime.jsx)("div", {
							className: "text-sm font-semibold text-txt",
							children: "Workflow"
						})
					})]
				})
			]
		})
	});
}
function AutomationsZeroState({ onBrowseTemplates, onNewTrigger, onNewTask }) {
	const { t } = useAutomationsViewContext();
	return (0, import_jsx_runtime.jsx)("div", {
		className: "flex min-h-0 flex-1 items-center justify-center px-8 py-12",
		children: (0, import_jsx_runtime.jsxs)(PagePanel, {
			variant: "padded",
			className: "w-full max-w-lg text-center space-y-5",
			children: [
				(0, import_jsx_runtime.jsx)("div", {
					className: "flex justify-center",
					children: (0, import_jsx_runtime.jsx)("div", {
						className: "rounded-2xl bg-accent/10 p-4 text-accent",
						children: (0, import_jsx_runtime.jsx)(Zap, { className: "h-8 w-8" })
					})
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-2",
					children: [(0, import_jsx_runtime.jsx)("h3", {
						className: "text-xl font-semibold text-txt",
						children: t("automations.zeroState.title", { defaultValue: "What would you like your agent to do?" })
					}), (0, import_jsx_runtime.jsx)("p", {
						className: "text-sm text-muted leading-relaxed",
						children: t("automations.zeroState.subtitle", { defaultValue: "I can build workflows for you, run prompts on a schedule, or keep a checklist of tasks." })
					})]
				}),
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap justify-center gap-2 pt-1",
					children: [
						(0, import_jsx_runtime.jsx)(Button, {
							variant: "default",
							size: "sm",
							className: "h-8 gap-1.5 px-4 text-sm",
							onClick: onBrowseTemplates,
							children: t("automations.zeroState.browseTemplates", { defaultValue: "Browse templates →" })
						}),
						(0, import_jsx_runtime.jsxs)(Button, {
							variant: "outline",
							size: "sm",
							className: "h-8 gap-1.5 px-3 text-sm",
							onClick: onNewTrigger,
							children: [(0, import_jsx_runtime.jsx)(Clock3, { className: "h-3.5 w-3.5" }), t("automations.newTriggerButton", { defaultValue: "+ New trigger" })]
						}),
						(0, import_jsx_runtime.jsxs)(Button, {
							variant: "outline",
							size: "sm",
							className: "h-8 gap-1.5 px-3 text-sm",
							onClick: onNewTask,
							children: [(0, import_jsx_runtime.jsx)(SquareTerminal, { className: "h-3.5 w-3.5" }), t("automations.newTaskButton", { defaultValue: "+ New task" })]
						})
					]
				})
			]
		})
	});
}
function TaskForm() {
	const { taskFormName, setTaskFormName, taskFormDescription, setTaskFormDescription, editingTaskId, formError, taskSaving, onSubmitTask, onDeleteTask, closeEditor, modalTitle, t } = useAutomationsViewContext();
	return (0, import_jsx_runtime.jsxs)(PagePanel, {
		variant: "padded",
		className: "space-y-5",
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between",
				children: [(0, import_jsx_runtime.jsx)("h3", {
					className: "text-lg font-semibold text-txt",
					children: modalTitle
				}), (0, import_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					onClick: closeEditor,
					children: t("common.cancel")
				})]
			}),
			formError && (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-lg border border-danger/20 bg-danger/10 p-3 text-sm text-danger",
				children: formError
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-3",
				children: [(0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, { children: "Task name" }), (0, import_jsx_runtime.jsx)(Input, {
					value: taskFormName,
					onChange: (event) => setTaskFormName(event.target.value),
					placeholder: "Task name...",
					autoFocus: true
				})] }), (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)(FieldLabel, { children: "Prompt" }), (0, import_jsx_runtime.jsx)(Textarea, {
					value: taskFormDescription,
					onChange: (event) => setTaskFormDescription(event.target.value),
					placeholder: "What should this task do?",
					rows: 4
				})] })]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2",
				children: [(0, import_jsx_runtime.jsx)(Button, {
					variant: "default",
					size: "sm",
					disabled: taskSaving || !taskFormName.trim(),
					onClick: () => void onSubmitTask(),
					children: editingTaskId ? t("automations.saveTask", { defaultValue: "Save task" }) : t("automations.createTask", { defaultValue: "Create task" })
				}), editingTaskId && (0, import_jsx_runtime.jsx)(Button, {
					variant: "outline",
					size: "sm",
					className: "border-danger/30 text-danger hover:bg-danger/10",
					onClick: () => void onDeleteTask(editingTaskId),
					children: t("common.delete")
				})]
			})
		]
	});
}
/**
* Render a single clarification ("Which channel in Cozy Devs?") with a row
* of quick-pick buttons drawn from the catalog. Falls back to a hint when
* the catalog has no entries for the clarification's platform/scope (e.g.
* the user only configured Discord but the LLM asked about Slack), since
* the user has nothing to pick from in that case.
*/
function ClarificationPanel({ state, onChoose, onDismiss }) {
	const current = state.response.clarifications[state.currentIndex];
	if (!current) return null;
	const options = optionsForClarification(state.response.catalog, current);
	const choiceId = `n8n-clarification-${current.paramPath || "free-text"}`;
	return (0, import_jsx_runtime.jsx)(PagePanel, {
		variant: "padded",
		className: "mb-4 border border-accent/40 bg-accent/5",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-start justify-between gap-3",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-2 min-w-0 flex-1",
				children: [
					(0, import_jsx_runtime.jsx)("p", {
						className: "text-sm font-semibold text-txt",
						children: current.question
					}),
					state.response.clarifications.length > 1 ? (0, import_jsx_runtime.jsxs)("p", {
						className: "text-2xs text-muted",
						children: [
							"Step ",
							state.currentIndex + 1,
							" of",
							" ",
							state.response.clarifications.length
						]
					}) : null,
					options.length > 0 ? (0, import_jsx_runtime.jsx)(ChoiceWidget, {
						id: choiceId,
						scope: "n8n-clarification",
						options,
						onChoose: (value) => {
							if (state.busy) return;
							onChoose(current.paramPath, value);
						}
					}, choiceId) : (0, import_jsx_runtime.jsx)(ClarificationFreeTextInput, {
						busy: state.busy,
						onSubmit: (value) => onChoose(current.paramPath, value),
						placeholderHint: current.platform
					}, choiceId),
					state.error ? (0, import_jsx_runtime.jsx)("p", {
						className: "text-2xs text-danger",
						children: state.error
					}) : null,
					state.busy ? (0, import_jsx_runtime.jsx)("p", {
						className: "text-2xs text-muted",
						children: "Applying choice…"
					}) : null
				]
			}), (0, import_jsx_runtime.jsx)(Button, {
				variant: "ghost",
				size: "sm",
				className: "text-muted hover:text-txt",
				onClick: onDismiss,
				disabled: state.busy,
				children: "Cancel"
			})]
		})
	});
}
/**
* Filter the catalog snapshot down to the picker options for one
* clarification. Channel pickers narrow to a single guild via
* `scope.guildId`. Server pickers list one entry per group. Free-text and
* value clarifications fall back to a text input (returns []).
*/
function optionsForClarification(catalog, clarification) {
	const platform = clarification.platform;
	if (!platform) return [];
	const groups = catalog.filter((g) => g.platform === platform);
	if (groups.length === 0) return [];
	switch (clarification.kind) {
		case "target_server": return groups.map((g) => ({
			value: g.groupId,
			label: g.groupName
		}));
		case "target_channel": {
			const guildId = clarification.scope?.guildId;
			const scoped = guildId ? groups.filter((g) => g.groupId === guildId) : groups;
			const out = [];
			for (const g of scoped) for (const t of g.targets) {
				if (t.kind !== "channel") continue;
				const label = scoped.length > 1 ? `${g.groupName}/#${t.name}` : `#${t.name}`;
				out.push({
					value: t.id,
					label
				});
			}
			return out;
		}
		case "recipient": {
			const out = [];
			for (const g of groups) for (const t of g.targets) {
				if (t.kind !== "recipient") continue;
				out.push({
					value: t.id,
					label: t.name
				});
			}
			return out;
		}
		default: return [];
	}
}
function ClarificationFreeTextInput({ busy, onSubmit, placeholderHint }) {
	const [value, setValue] = useState("");
	const trimmed = value.trim();
	return (0, import_jsx_runtime.jsxs)("form", {
		onSubmit: (e) => {
			e.preventDefault();
			if (busy || trimmed.length === 0) return;
			onSubmit(trimmed);
		},
		className: "mt-1 flex items-center gap-2",
		children: [(0, import_jsx_runtime.jsx)(Input, {
			value,
			onChange: (e) => setValue(e.target.value),
			placeholder: placeholderHint ? `Enter a value for ${placeholderHint}…` : "Type your answer…",
			disabled: busy,
			className: "h-8 text-xs"
		}), (0, import_jsx_runtime.jsx)(Button, {
			type: "submit",
			size: "sm",
			variant: "outline",
			disabled: busy || trimmed.length === 0,
			children: "Apply"
		})]
	});
}
function WorkflowRuntimeNotice({ status, workflowFetchError, busy, onRefresh, onStartLocal }) {
	const isAutoStarting = status?.mode === "local" && (status.status === "starting" || status.status === "stopped");
	if (!status && !workflowFetchError) return null;
	if (status?.mode === "disabled") return (0, import_jsx_runtime.jsxs)("div", {
		className: "mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border/25 bg-bg/30 px-3 py-1.5 text-xs-tight",
		children: [(0, import_jsx_runtime.jsx)("span", {
			className: "text-muted",
			children: "Workflow deploy requires n8n. Text tasks still work without it."
		}), status.platform !== "mobile" && (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			disabled: busy,
			onClick: onStartLocal,
			className: "text-2xs font-semibold uppercase tracking-[0.12em] text-accent hover:text-accent/80 disabled:opacity-50",
			children: "Enable"
		})]
	});
	if (isAutoStarting) return (0, import_jsx_runtime.jsxs)("div", {
		className: "mb-2 flex items-center gap-2 px-3 py-1 text-2xs text-muted/70",
		children: [(0, import_jsx_runtime.jsx)("span", { className: "inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" }), (0, import_jsx_runtime.jsx)("span", { children: "Starting local n8n…" })]
	});
	if (workflowFetchError) return (0, import_jsx_runtime.jsxs)("div", {
		className: "mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs-tight",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex min-w-0 items-center gap-2",
			children: [(0, import_jsx_runtime.jsx)("span", { className: "inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger" }), (0, import_jsx_runtime.jsx)("span", {
				className: "truncate text-danger/90",
				children: workflowFetchError
			})]
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-3",
			children: [status?.mode === "local" && status.status !== "ready" && (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				disabled: busy,
				onClick: onStartLocal,
				className: "text-2xs font-semibold uppercase tracking-[0.12em] text-danger hover:text-danger/80 disabled:opacity-50",
				children: "Restart"
			}), (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				disabled: busy,
				onClick: onRefresh,
				className: "text-2xs font-semibold uppercase tracking-[0.12em] text-muted hover:text-txt disabled:opacity-50",
				children: "Refresh"
			})]
		})]
	});
	if (status?.mode === "local" && status.status === "error") return (0, import_jsx_runtime.jsxs)("div", {
		className: "mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs-tight",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex min-w-0 items-center gap-2",
			children: [(0, import_jsx_runtime.jsx)("span", { className: "inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger" }), (0, import_jsx_runtime.jsx)("span", {
				className: "text-danger/90",
				children: "Local n8n failed to start."
			})]
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-3",
			children: [(0, import_jsx_runtime.jsx)("button", {
				type: "button",
				disabled: busy,
				onClick: onStartLocal,
				className: "text-2xs font-semibold uppercase tracking-[0.12em] text-danger hover:text-danger/80 disabled:opacity-50",
				children: "Retry"
			}), (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				disabled: busy,
				onClick: onRefresh,
				className: "text-2xs font-semibold uppercase tracking-[0.12em] text-muted hover:text-txt disabled:opacity-50",
				children: "Refresh"
			})]
		})]
	});
	if (status?.mode === "cloud" && status.cloudHealth === "degraded") return (0, import_jsx_runtime.jsxs)("div", {
		className: "mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-warning/25 bg-warning/5 px-3 py-1.5 text-xs-tight",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex min-w-0 items-center gap-2",
			children: [(0, import_jsx_runtime.jsx)("span", { className: "inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning" }), (0, import_jsx_runtime.jsx)("span", {
				className: "text-warning",
				children: "Eliza Cloud workflow gateway is degraded."
			})]
		}), (0, import_jsx_runtime.jsx)("button", {
			type: "button",
			disabled: busy,
			onClick: onRefresh,
			className: "text-2xs font-semibold uppercase tracking-[0.12em] text-muted hover:text-txt disabled:opacity-50",
			children: "Refresh"
		})]
	});
	return null;
}
function AutomationNodePalette({ nodes, title }) {
	const groupedNodes = useMemo(() => NODE_CLASS_ORDER.map((className) => ({
		className,
		nodes: nodes.filter((node) => node.class === className)
	})).filter((group) => group.nodes.length > 0), [nodes]);
	const enabledCount = nodes.filter((n) => n.availability === "enabled").length;
	const disabledCount = nodes.filter((n) => n.availability === "disabled").length;
	return (0, import_jsx_runtime.jsxs)("section", {
		className: "rounded-[var(--radius-sm)] border border-border/25 bg-bg/20",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center justify-between gap-2 border-b border-border/20 px-3 py-1.5",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted",
				children: [(0, import_jsx_runtime.jsx)("span", { children: title }), (0, import_jsx_runtime.jsx)("span", {
					className: "text-muted/50",
					children: nodes.length
				})]
			}), (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-1.5 text-[10px] tabular-nums",
				children: [
					(0, import_jsx_runtime.jsx)("span", {
						className: "text-ok",
						children: enabledCount
					}),
					(0, import_jsx_runtime.jsx)("span", {
						className: "text-muted/40",
						children: "·"
					}),
					(0, import_jsx_runtime.jsx)("span", {
						className: "text-warning",
						children: disabledCount
					})
				]
			})]
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "space-y-2 px-2 py-2",
			children: groupedNodes.map((group) => (0, import_jsx_runtime.jsxs)("div", { children: [(0, import_jsx_runtime.jsx)("div", {
				className: "px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted/60",
				children: getNodeClassLabel(group.className)
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "grid gap-1 sm:grid-cols-2 xl:grid-cols-3",
				children: group.nodes.map((node) => (0, import_jsx_runtime.jsxs)("div", {
					title: node.disabledReason || node.description || node.label,
					className: `flex items-center gap-2 rounded-[var(--radius-sm)] border px-2 py-1 text-xs-tight ${node.availability === "enabled" ? "border-border/20 bg-bg/30" : "border-warning/20 bg-warning/5"}`,
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: node.availability === "enabled" ? "text-accent/80" : "text-warning",
							children: getNodeIcon(node)
						}),
						(0, import_jsx_runtime.jsx)("span", {
							className: "truncate text-txt",
							children: node.label
						}),
						node.ownerScoped && (0, import_jsx_runtime.jsx)("span", {
							className: "ml-auto text-[9px] uppercase tracking-wider text-muted/60",
							children: "owner"
						})
					]
				}, node.id))
			})] }, group.className))
		})]
	});
}
function AutomationNodeCatalogPane({ nodes }) {
	return (0, import_jsx_runtime.jsx)(AutomationNodePalette, {
		nodes,
		title: "Nodes"
	});
}
function TaskAutomationDetailPane({ automation, onPromoteToWorkflow }) {
	const { openEditTask, onDeleteTask, onToggleTaskCompleted, setEditorOpen, setEditorMode, setTaskFormDescription, setTaskFormName, setEditingTaskId, setSelectedItemId, setSelectedItemKind, t, uiLanguage } = useAutomationsViewContext();
	const task = automation.task;
	if (!task) return null;
	const statusLabel = automation.system ? "System" : task.isCompleted ? "Completed" : "Open";
	const statusTone = automation.system ? "muted" : task.isCompleted ? "muted" : "success";
	const nextScheduledRun = automation.schedules.filter(isTimeBasedTrigger).map((schedule) => schedule.nextRunAtMs ?? 0).filter((value) => value > 0).sort((left, right) => left - right)[0];
	const taskTypeLabel = automation.system ? "Agent owned" : "Task";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-4",
		children: [
			(0, import_jsx_runtime.jsx)(DetailHeader, {
				icon: automation.system ? (0, import_jsx_runtime.jsx)(Settings, {
					className: "h-3.5 w-3.5",
					"aria-hidden": true
				}) : (0, import_jsx_runtime.jsx)(FileText, {
					className: "h-3.5 w-3.5",
					"aria-hidden": true
				}),
				title: getAutomationDisplayTitle(automation),
				description: automation.description || (automation.system ? "Internal manual task." : "Simple text task."),
				status: (0, import_jsx_runtime.jsx)(DetailStatusIndicator, {
					label: statusLabel,
					tone: statusTone,
					dotOnly: !automation.system && !task.isCompleted
				}),
				actions: !automation.system ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: task.isCompleted ? "Reopen" : "Complete",
						onClick: () => void onToggleTaskCompleted(task.id, task.isCompleted),
						icon: task.isCompleted ? (0, import_jsx_runtime.jsx)(Circle, { className: "h-3.5 w-3.5" }) : (0, import_jsx_runtime.jsx)(CheckCircle2, { className: "h-3.5 w-3.5" }),
						tone: task.isCompleted ? "ok" : void 0
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: "Duplicate",
						onClick: () => {
							setTaskFormName(`${task.name} copy`);
							setTaskFormDescription(task.description);
							setEditingTaskId(null);
							setEditorMode("task");
							setSelectedItemId(null);
							setSelectedItemKind(null);
							setEditorOpen(true);
						},
						icon: (0, import_jsx_runtime.jsx)(Copy, { className: "h-3.5 w-3.5" })
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: "Compile to Workflow",
						onClick: () => void onPromoteToWorkflow(automation),
						icon: (0, import_jsx_runtime.jsx)(GitBranch, { className: "h-3.5 w-3.5" })
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: t("common.edit"),
						onClick: () => openEditTask(task),
						icon: (0, import_jsx_runtime.jsx)(Edit, { className: "h-3.5 w-3.5" })
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: t("common.delete"),
						onClick: () => void onDeleteTask(task.id),
						icon: (0, import_jsx_runtime.jsx)(Trash2, { className: "h-3.5 w-3.5" }),
						tone: "danger"
					})
				] }) : null
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-2 sm:grid-cols-2 xl:grid-cols-4",
				children: [
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Task type",
						value: taskTypeLabel,
						detail: automation.schedules.length > 0 ? formatScheduleCount(automation.schedules.length) : "Run it manually"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Status",
						value: statusLabel,
						detail: task.isCompleted ? "Already completed" : "Still open",
						tone: task.isCompleted ? "default" : "ok"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Starts",
						value: nextScheduledRun ? formatRelativeFuture(nextScheduledRun, t) : "Manual",
						detail: nextScheduledRun ? formatDateTime(nextScheduledRun, {
							fallback: "—",
							locale: uiLanguage
						}) : "Run it yourself or attach a schedule",
						tone: nextScheduledRun ? "ok" : "default"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Updated",
						value: formatRelativePast(automation.updatedAt, t),
						detail: formatDateTime(automation.updatedAt, { fallback: "—" })
					})
				]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-4 xl:grid-cols-[minmax(0,1.12fr)_minmax(320px,0.88fr)]",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-4",
					children: [(0, import_jsx_runtime.jsx)(DetailSection, {
						title: "Prompt",
						children: (0, import_jsx_runtime.jsx)("div", {
							className: "min-h-[10rem] px-4 py-4 text-sm leading-relaxed text-muted/85 whitespace-pre-wrap",
							children: task.description || "Describe what this task should do."
						})
					}), (0, import_jsx_runtime.jsx)(DetailSection, {
						title: automation.schedules.length > 0 ? "Starts when" : "How it starts",
						children: automation.schedules.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
							className: "divide-y divide-border/20",
							children: automation.schedules.map((schedule) => (0, import_jsx_runtime.jsx)(OverviewListItem, {
								title: schedule.displayName,
								meta: scheduleLabel(schedule, t, uiLanguage),
								detail: formatDateTime(schedule.nextRunAtMs ?? null, {
									fallback: "No next run queued",
									locale: uiLanguage
								}),
								trailing: schedule.enabled ? "Live" : "Paused",
								tone: schedule.enabled ? "success" : "muted"
							}, schedule.id))
						}) : (0, import_jsx_runtime.jsx)("div", {
							className: "px-4 py-4 text-xs-tight text-muted/70",
							children: "This task is manual right now. Add a schedule if you want it to start on its own."
						})
					})]
				}), (0, import_jsx_runtime.jsx)("div", {
					className: "space-y-4",
					children: (0, import_jsx_runtime.jsx)(DetailSection, {
						title: "Details",
						children: (0, import_jsx_runtime.jsx)(DetailFactList, { items: [
							{
								label: "State",
								value: task.isCompleted ? "Completed" : "Open"
							},
							{
								label: "Source",
								value: automation.system ? "Internal checklist item" : "Simple prompt task"
							},
							{
								label: "Next run",
								value: nextScheduledRun ? formatDateTime(nextScheduledRun, {
									fallback: "—",
									locale: uiLanguage
								}) : "Manual"
							},
							{
								label: "Tags",
								value: task.tags.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
									className: "flex flex-wrap justify-end gap-1",
									children: task.tags.map((tag) => (0, import_jsx_runtime.jsx)("span", {
										className: "rounded bg-bg/50 px-1.5 py-0.5 text-[10px] text-muted",
										children: tag
									}, tag))
								}) : "None"
							}
						] })
					})
				})]
			})
		]
	});
}
const AUTOMATION_DRAFT_EXAMPLES = [
	{
		icon: Mail,
		kind: "task",
		label: "Daily inbox digest",
		blurb: "A simple recurring prompt that keeps your morning brief tight.",
		prompt: "Every weekday at 9am, summarize my Gmail inbox from the last 24 hours and post the summary to my #daily channel in Slack."
	},
	{
		icon: Clock3,
		kind: "task",
		label: "Hourly health check",
		blurb: "A lightweight prompt that watches for anything stuck or failing.",
		prompt: "Every hour, review recent activity, check that nothing is stuck or errored, and notify me if anything needs attention."
	},
	{
		icon: GitBranch,
		kind: "workflow",
		label: "GitHub issue triage",
		blurb: "An event-driven pipeline that labels, routes, and replies.",
		prompt: "When a new issue is opened on my GitHub repo, classify it (bug / feature / question / docs), add the matching label, and post a welcoming comment."
	},
	{
		icon: Share2,
		kind: "workflow",
		label: "Lead handoff",
		blurb: "A cross-app flow that enriches, routes, and notifies.",
		prompt: "When a new website lead arrives, enrich it, create the contact in my CRM, and post a summary to Slack for the team."
	}
];
function OverviewIdeaGrid({ ideas, onSelect }) {
	return (0, import_jsx_runtime.jsx)("div", {
		className: "grid gap-1.5",
		children: ideas.map((idea) => {
			const Icon = idea.icon;
			return (0, import_jsx_runtime.jsxs)("button", {
				type: "button",
				onClick: () => onSelect(idea),
				className: "group flex items-start gap-2 rounded-[var(--radius-sm)] border border-border/25 bg-bg/30 px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-accent/5",
				children: [(0, import_jsx_runtime.jsx)(Icon, {
					className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-accent/80",
					"aria-hidden": true
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0 flex-1 space-y-0.5",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "truncate text-xs-tight font-semibold text-txt",
							children: idea.label
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "rounded bg-bg/50 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted/70",
							children: idea.kind
						})]
					}), (0, import_jsx_runtime.jsx)("div", {
						className: "text-[11px] leading-snug text-muted/70",
						children: idea.blurb
					})]
				})]
			}, idea.label);
		})
	});
}
function AutomationCommandBar({ onSubmit, autoFocus = false }) {
	const [prompt, setPrompt] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const submit = useCallback(async () => {
		const trimmed = prompt.trim();
		if (!trimmed || submitting) return;
		setSubmitting(true);
		try {
			await onSubmit(trimmed);
			setPrompt("");
		} finally {
			setSubmitting(false);
		}
	}, [
		onSubmit,
		prompt,
		submitting
	]);
	return (0, import_jsx_runtime.jsx)("div", {
		className: "rounded-2xl border border-border/30 bg-bg/55 p-1.5 shadow-sm",
		children: (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-col gap-2 sm:flex-row sm:items-center",
			children: [(0, import_jsx_runtime.jsx)(Input, {
				value: prompt,
				onChange: (event) => setPrompt(event.target.value),
				onKeyDown: (event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						submit();
					}
				},
				placeholder: AUTOMATION_PROMPT_PLACEHOLDER,
				"aria-label": DESCRIBE_AUTOMATION_PROMPT,
				className: "min-h-11 flex-1 border-0 bg-transparent px-4 text-sm shadow-none focus-visible:ring-0",
				autoFocus
			}), (0, import_jsx_runtime.jsx)(Button, {
				variant: "default",
				size: "sm",
				className: "h-10 shrink-0 rounded-xl px-4 text-sm",
				disabled: submitting || prompt.trim().length === 0,
				onClick: () => void submit(),
				children: submitting ? "Creating..." : "Create"
			})]
		})
	});
}
function formatRelativeFuture(targetMs, t) {
	const delta = targetMs - Date.now();
	if (delta <= 0) return "now";
	return `in ${formatDurationMs(delta, { t })}`;
}
function formatRelativePast(iso, t) {
	if (!iso) return "—";
	const ts = typeof iso === "string" ? Date.parse(iso) : iso;
	if (!Number.isFinite(ts)) return "—";
	const delta = Date.now() - ts;
	if (delta < 0) return "now";
	return `${formatDurationMs(delta, { t })} ago`;
}
function OverviewMetricCard({ label, value, detail, tone = "default" }) {
	const valueClass = tone === "ok" ? "text-ok" : tone === "warning" ? "text-warning" : tone === "danger" ? "text-danger" : "text-txt";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "rounded-xl border border-border/25 bg-bg/35 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
		children: [
			(0, import_jsx_runtime.jsx)("div", {
				className: "text-[10px] font-semibold uppercase tracking-[0.14em] text-muted/70",
				children: label
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: `mt-2 text-lg font-semibold leading-none ${valueClass}`,
				children: value
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "mt-2 text-[11px] leading-snug text-muted/70",
				children: detail
			})
		]
	});
}
function OverviewListItem({ title, badge, meta, detail, trailing, tone = "muted", onClick }) {
	const content = (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-start gap-2",
		children: [(0, import_jsx_runtime.jsx)(StatusDot, {
			tone,
			className: "mt-1 shrink-0"
		}), (0, import_jsx_runtime.jsxs)("div", {
			className: "min-w-0 flex-1",
			children: [
				(0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-2",
					children: [
						(0, import_jsx_runtime.jsx)("span", {
							className: "truncate font-medium text-txt",
							children: title
						}),
						badge ? (0, import_jsx_runtime.jsx)("span", {
							className: "rounded bg-bg/50 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted/70",
							children: badge
						}) : null,
						trailing ? (0, import_jsx_runtime.jsx)("span", {
							className: "ml-auto shrink-0 text-[11px] text-muted/70",
							children: trailing
						}) : null
					]
				}),
				meta ? (0, import_jsx_runtime.jsx)("div", {
					className: "mt-0.5 text-[11px] leading-snug text-muted/70",
					children: meta
				}) : null,
				detail ? (0, import_jsx_runtime.jsx)("div", {
					className: "mt-1 line-clamp-1 text-[11px] leading-snug text-muted/60",
					children: detail
				}) : null
			]
		})]
	});
	if (!onClick) return (0, import_jsx_runtime.jsx)("div", {
		className: "px-3 py-2 text-xs-tight",
		children: content
	});
	return (0, import_jsx_runtime.jsx)("button", {
		type: "button",
		onClick,
		className: "w-full px-3 py-2 text-left text-xs-tight transition-colors hover:bg-bg-muted/40",
		children: content
	});
}
function HeroEmptyState({ ideas, onSubmit, drafts, onSelectDraft, onDeleteDraft, t }) {
	const [value, setValue] = useState("");
	const textareaRef = useRef(null);
	const submit = useCallback(() => {
		const text = value.trim();
		if (text.length === 0) return;
		setValue("");
		onSubmit(text);
	}, [onSubmit, value]);
	const handleChipSelect = useCallback((idea) => {
		setValue(idea.prompt);
		textareaRef.current?.focus();
	}, []);
	const canSubmit = value.trim().length > 0;
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-10",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "w-full max-w-[560px] space-y-3",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "relative",
				children: [(0, import_jsx_runtime.jsx)(Textarea, {
					ref: textareaRef,
					value,
					onChange: (event) => setValue(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
					},
					placeholder: "Describe a task or workflow…",
					rows: 2,
					variant: "form",
					className: "resize-none pr-12"
				}), (0, import_jsx_runtime.jsx)(Button, {
					type: "button",
					variant: "ghost",
					size: "sm",
					className: "absolute bottom-2 right-2 h-7 w-7 p-0",
					onClick: submit,
					disabled: !canSubmit,
					"aria-label": "Submit",
					children: (0, import_jsx_runtime.jsx)(ArrowRight, {
						className: "h-4 w-4",
						"aria-hidden": true
					})
				})]
			}), (0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-wrap gap-2",
				children: ideas.map((idea) => (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: () => handleChipSelect(idea),
					className: "rounded-full border border-border/50 bg-bg-accent px-2.5 py-1 text-xs text-txt transition-colors hover:border-accent/40 hover:bg-accent/5",
					children: idea.label
				}, idea.label))
			})]
		}), drafts.length > 0 && (0, import_jsx_runtime.jsx)("div", {
			className: "w-full max-w-[560px]",
			children: (0, import_jsx_runtime.jsx)(DetailSection, {
				title: "Drafts in progress",
				children: (0, import_jsx_runtime.jsx)("div", {
					className: "divide-y divide-border/20",
					children: drafts.map((item) => (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-stretch gap-1",
						children: [(0, import_jsx_runtime.jsx)("div", {
							className: "min-w-0 flex-1",
							children: (0, import_jsx_runtime.jsx)(OverviewListItem, {
								onClick: () => onSelectDraft(item),
								title: getOverviewDisplayTitle(item),
								badge: "Draft",
								meta: formatRelativePast(item.updatedAt, t),
								detail: item.description.trim() || "Open it and keep shaping it in the sidebar agent.",
								tone: "warning"
							})
						}), onDeleteDraft && (0, import_jsx_runtime.jsx)(Button, {
							type: "button",
							variant: "ghost",
							size: "sm",
							className: "h-auto w-8 shrink-0 self-center text-muted hover:bg-danger/10 hover:text-danger",
							onClick: () => void onDeleteDraft(item),
							"aria-label": "Delete draft",
							title: "Delete draft",
							children: (0, import_jsx_runtime.jsx)(Trash2, {
								className: "h-3.5 w-3.5",
								"aria-hidden": true
							})
						})]
					}, item.id))
				})
			})
		})]
	});
}
function AutomationDraftPane({ automation, onSeedPrompt, onDeleteDraft, isGenerating }) {
	const chatChrome = useAppWorkspaceChatChrome();
	const openSidebarDraftChat = useCallback((prompt) => {
		chatChrome?.openChat();
		onSeedPrompt(prompt);
	}, [chatChrome, onSeedPrompt]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-4 px-4 pt-6",
		children: [
			isGenerating && (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-start gap-3 rounded-xl border border-accent/40 bg-accent/5 px-4 py-3 text-sm",
				children: [(0, import_jsx_runtime.jsx)(Spinner, { className: "mt-0.5 h-4 w-4 shrink-0 text-accent" }), (0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0 flex-1",
					children: [(0, import_jsx_runtime.jsx)("div", {
						className: "font-semibold text-txt",
						children: "Building your workflow…"
					}), (0, import_jsx_runtime.jsx)("div", {
						className: "mt-0.5 text-xs text-muted",
						children: "Generations usually take 10–30 seconds. Hooking up connectors, picking nodes, and wiring the graph."
					})]
				})]
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-start justify-between gap-3",
				children: [(0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-1",
					children: [(0, import_jsx_runtime.jsx)("h2", {
						className: "text-lg font-semibold text-txt",
						children: getAutomationDisplayTitle(automation)
					}), (0, import_jsx_runtime.jsx)("p", {
						className: "max-w-2xl text-xs-tight text-muted/80",
						children: "Use the sidebar agent to turn this draft into a task or workflow. Say what should start it and what result you want."
					})]
				}), (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-wrap gap-2",
					children: [(0, import_jsx_runtime.jsx)(Button, {
						variant: "outline",
						size: "sm",
						className: "h-8 gap-1.5 px-3 text-sm",
						onClick: () => openSidebarDraftChat(DESCRIBE_WORKFLOW_PROMPT),
						children: DESCRIBE_WORKFLOW_PROMPT
					}), (0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						className: "h-8 px-3 text-sm text-danger hover:bg-danger/10 hover:text-danger",
						onClick: () => void onDeleteDraft(automation),
						children: "Delete draft"
					})]
				})]
			}),
			(0, import_jsx_runtime.jsx)("div", {
				className: "grid gap-1.5 sm:grid-cols-2",
				children: AUTOMATION_DRAFT_EXAMPLES.map((example) => {
					const Icon = example.icon;
					return (0, import_jsx_runtime.jsxs)("button", {
						type: "button",
						onClick: () => openSidebarDraftChat(example.prompt),
						className: "group flex items-start gap-2 rounded-[var(--radius-sm)] border border-border/25 bg-bg/30 px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-accent/5",
						children: [(0, import_jsx_runtime.jsx)(Icon, {
							className: "mt-0.5 h-3.5 w-3.5 shrink-0 text-accent/80",
							"aria-hidden": true
						}), (0, import_jsx_runtime.jsxs)("div", {
							className: "min-w-0 flex-1 space-y-0.5",
							children: [(0, import_jsx_runtime.jsx)("div", {
								className: "text-xs-tight font-semibold text-txt",
								children: example.label
							}), (0, import_jsx_runtime.jsx)("div", {
								className: "line-clamp-2 text-[11px] leading-snug text-muted/70",
								children: example.prompt
							})]
						})]
					}, example.label);
				})
			}),
			(0, import_jsx_runtime.jsx)("p", {
				className: "px-1 text-[11px] text-muted/60",
				children: "The draft updates here as the automation takes shape."
			})
		]
	});
}
function IconAction({ icon, label, onClick, tone, disabled, ariaBusy }) {
	const toneClass = tone === "warning" ? "text-warning hover:bg-warning/10" : tone === "ok" ? "text-ok hover:bg-ok/10" : tone === "danger" ? "text-danger hover:bg-danger/10" : "text-muted hover:text-txt hover:bg-bg-muted/50";
	return (0, import_jsx_runtime.jsx)("button", {
		type: "button",
		onClick,
		"aria-label": label,
		"aria-busy": ariaBusy,
		title: label,
		disabled,
		className: `inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClass}`,
		children: icon
	});
}
function DetailHeader({ icon, title, description, status, actions }) {
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex items-start gap-3 border-b border-border/20 pb-3",
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "min-w-0 flex-1 space-y-0.5",
			children: [(0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-1.5 text-muted",
				children: [
					icon,
					(0, import_jsx_runtime.jsx)("h2", {
						className: "truncate text-base font-semibold text-txt",
						children: title
					}),
					status
				]
			}), description ? (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs-tight leading-snug text-muted/80",
				children: description
			}) : null]
		}), actions ? (0, import_jsx_runtime.jsx)("div", {
			className: "flex shrink-0 items-center gap-0.5",
			children: actions
		}) : null]
	});
}
function DetailStatusIndicator({ label, tone, dotOnly = false }) {
	if (dotOnly) return (0, import_jsx_runtime.jsxs)("span", {
		className: "inline-flex items-center",
		children: [(0, import_jsx_runtime.jsx)(StatusDot, { tone }), (0, import_jsx_runtime.jsx)("span", {
			className: "sr-only",
			children: label
		})]
	});
	return (0, import_jsx_runtime.jsx)(StatusBadge, {
		label,
		variant: tone,
		withDot: true
	});
}
function DetailSection({ title, action, children, className }) {
	return (0, import_jsx_runtime.jsxs)("section", {
		className: `rounded-[var(--radius-sm)] border border-border/25 bg-bg/20 ${className ?? ""}`,
		children: [(0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center justify-between gap-2 border-b border-border/20 px-3 py-1.5",
			children: [(0, import_jsx_runtime.jsx)("div", {
				className: "text-2xs font-semibold uppercase tracking-[0.14em] text-muted",
				children: title
			}), action]
		}), (0, import_jsx_runtime.jsx)("div", {
			className: "py-1",
			children
		})]
	});
}
function DetailFactList({ items }) {
	return (0, import_jsx_runtime.jsx)("dl", {
		className: "divide-y divide-border/20",
		children: items.map((item) => (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-start justify-between gap-3 px-3 py-2 text-xs-tight",
			children: [(0, import_jsx_runtime.jsx)("dt", {
				className: "shrink-0 text-muted/70",
				children: item.label
			}), (0, import_jsx_runtime.jsx)("dd", {
				className: "min-w-0 text-right text-txt",
				children: item.value
			})]
		}, item.label))
	});
}
function getWorkflowFlowNodes(workflow) {
	return [...workflow?.nodes ?? []].sort((left, right) => {
		const leftX = left.position?.[0] ?? 0;
		const rightX = right.position?.[0] ?? 0;
		if (leftX !== rightX) return leftX - rightX;
		const leftY = left.position?.[1] ?? 0;
		const rightY = right.position?.[1] ?? 0;
		if (leftY !== rightY) return leftY - rightY;
		return left.name.localeCompare(right.name);
	}).map((node) => ({
		id: node.id ?? node.name,
		label: node.name,
		type: (node.type ?? "node").split(".").pop() ?? "node"
	}));
}
function WorkflowDataFlowStrip({ workflow }) {
	const flowNodes = getWorkflowFlowNodes(workflow);
	if (flowNodes.length === 0) return (0, import_jsx_runtime.jsx)("div", {
		className: "px-4 py-3 text-xs-tight text-muted/70",
		children: "Generate the workflow to see its data path."
	});
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-wrap items-center gap-2 px-3 py-3",
		children: [(0, import_jsx_runtime.jsx)("span", {
			className: "rounded-full border border-border/25 bg-bg/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted",
			children: "Input"
		}), flowNodes.map((node, index) => (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-center gap-2",
			children: [
				(0, import_jsx_runtime.jsx)(ArrowRight, {
					className: "h-3 w-3 text-muted/50",
					"aria-hidden": true
				}),
				(0, import_jsx_runtime.jsx)("span", {
					className: "max-w-[12rem] truncate rounded-full border border-border/25 bg-bg/45 px-2.5 py-1 text-xs text-txt",
					children: node.label
				}),
				(0, import_jsx_runtime.jsx)("span", {
					className: "hidden rounded bg-bg/40 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-muted/60 sm:inline",
					children: node.type
				}),
				index === flowNodes.length - 1 ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [(0, import_jsx_runtime.jsx)(ArrowRight, {
					className: "h-3 w-3 text-muted/50",
					"aria-hidden": true
				}), (0, import_jsx_runtime.jsx)("span", {
					className: "rounded-full border border-border/25 bg-bg/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted",
					children: "Output"
				})] }) : null
			]
		}, node.id))]
	});
}
function TriggerAutomationDetailPane({ automation, onPromoteToWorkflow }) {
	const { t, uiLanguage, openEditTrigger, onRunSelectedTrigger, onToggleTriggerEnabled, onDeleteTrigger, loadTriggerRuns, triggerRunsById, setForm, setEditorOpen, setEditingId, setSelectedItemId, setSelectedItemKind } = useAutomationsViewContext();
	const trigger = automation.trigger;
	const triggerId = trigger?.id;
	const selectedRuns = triggerId ? triggerRunsById[triggerId] ?? [] : [];
	const hasLoadedRuns = triggerId ? Object.hasOwn(triggerRunsById, triggerId) : false;
	useEffect(() => {
		if (triggerId && !hasLoadedRuns) loadTriggerRuns(triggerId);
	}, [
		hasLoadedRuns,
		loadTriggerRuns,
		triggerId
	]);
	if (!trigger) return null;
	const { failureCount, successCount } = selectedRuns.reduce((counts, run) => {
		const tone = toneForLastStatus(run.status);
		if (tone === "success") counts.successCount += 1;
		else if (tone === "danger") counts.failureCount += 1;
		return counts;
	}, {
		failureCount: 0,
		successCount: 0
	});
	const nextRunLabel = trigger.nextRunAtMs ? trigger.triggerType === "event" ? `On ${humanizeEventKind(trigger.eventKind ?? "event")}` : formatRelativeFuture(trigger.nextRunAtMs, t) : "Event or manual";
	const whatRuns = trigger.kind === "workflow" ? trigger.workflowName || "Selected workflow" : trigger.instructions || "No prompt yet.";
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-4",
		children: [
			(0, import_jsx_runtime.jsx)(DetailHeader, {
				icon: (0, import_jsx_runtime.jsx)(Clock3, {
					className: "h-3.5 w-3.5",
					"aria-hidden": true
				}),
				title: getAutomationDisplayTitle(automation),
				description: automation.description,
				status: (0, import_jsx_runtime.jsx)(DetailStatusIndicator, {
					label: trigger.enabled ? "Active" : "Paused",
					tone: trigger.enabled ? "success" : "muted",
					dotOnly: trigger.enabled
				}),
				actions: (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: trigger.enabled ? "Pause" : "Resume",
						onClick: () => void onToggleTriggerEnabled(trigger.id, trigger.enabled),
						icon: trigger.enabled ? (0, import_jsx_runtime.jsx)(Pause, { className: "h-3.5 w-3.5" }) : (0, import_jsx_runtime.jsx)(Play, { className: "h-3.5 w-3.5" }),
						tone: trigger.enabled ? "warning" : "ok"
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: t("triggersview.RunNow"),
						onClick: () => void onRunSelectedTrigger(trigger.id),
						icon: (0, import_jsx_runtime.jsx)(Zap, { className: "h-3.5 w-3.5" })
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: t("common.edit"),
						onClick: () => openEditTrigger(trigger),
						icon: (0, import_jsx_runtime.jsx)(Edit, { className: "h-3.5 w-3.5" })
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: t("heartbeatsview.duplicate"),
						onClick: () => {
							setForm({
								...formFromTrigger(trigger),
								displayName: `${trigger.displayName} (copy)`
							});
							setEditorOpen(true);
							setEditingId(null);
							setSelectedItemId(null);
							setSelectedItemKind(null);
						},
						icon: (0, import_jsx_runtime.jsx)(Copy, { className: "h-3.5 w-3.5" })
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: "Compile to Workflow",
						onClick: () => void onPromoteToWorkflow(automation),
						icon: (0, import_jsx_runtime.jsx)(GitBranch, { className: "h-3.5 w-3.5" })
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: t("common.delete"),
						onClick: () => void onDeleteTrigger(trigger.id, trigger.displayName),
						icon: (0, import_jsx_runtime.jsx)(Trash2, { className: "h-3.5 w-3.5" }),
						tone: "danger"
					})
				] })
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-2 sm:grid-cols-2 xl:grid-cols-5",
				children: [
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Runs",
						value: (0, import_jsx_runtime.jsx)("span", {
							className: "tabular-nums",
							children: selectedRuns.length
						}),
						detail: `${successCount} successful · ${failureCount} failed`,
						tone: failureCount > 0 ? "danger" : successCount > 0 ? "ok" : "default"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Starts",
						value: getTriggerStartModeLabel(trigger),
						detail: scheduleLabel(trigger, t, uiLanguage)
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "When it fires",
						value: getTriggerWakeModeLabel(trigger),
						detail: trigger.enabled ? "Enabled" : "Paused",
						tone: trigger.enabled ? "ok" : "default"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Next run",
						value: nextRunLabel,
						detail: trigger.triggerType === "event" ? "Waiting for event input" : formatDateTime(trigger.nextRunAtMs, {
							fallback: "No time-based run queued",
							locale: uiLanguage
						}),
						tone: trigger.nextRunAtMs || trigger.triggerType === "event" ? "ok" : "default"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Last run",
						value: formatRelativePast(trigger.lastRunAtIso, t),
						detail: formatDateTime(trigger.lastRunAtIso, {
							fallback: "Not run yet",
							locale: uiLanguage
						})
					})
				]
			}),
			(0, import_jsx_runtime.jsx)(DetailSection, {
				title: trigger.kind === "workflow" ? "Runs this workflow" : "Prompt",
				children: (0, import_jsx_runtime.jsx)("div", {
					className: "min-h-[8rem] px-4 py-4 text-sm leading-relaxed text-muted/85 whitespace-pre-wrap",
					children: whatRuns
				})
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.95fr)]",
				children: [(0, import_jsx_runtime.jsx)(DetailSection, {
					title: "Run history",
					className: "h-full",
					action: (0, import_jsx_runtime.jsx)(IconAction, {
						label: t("common.refresh"),
						onClick: () => void loadTriggerRuns(trigger.id),
						icon: (0, import_jsx_runtime.jsx)(RefreshCw, { className: "h-3.5 w-3.5" })
					}),
					children: !hasLoadedRuns ? (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2 px-3 py-2 text-xs-tight text-muted/70",
						children: [(0, import_jsx_runtime.jsx)("div", { className: "h-3 w-3 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" }), t("appsview.Loading")]
					}) : selectedRuns.length === 0 ? (0, import_jsx_runtime.jsx)("div", {
						className: "px-3 py-3 text-xs-tight text-muted/60",
						children: "No runs yet."
					}) : (0, import_jsx_runtime.jsx)("div", {
						className: "divide-y divide-border/20",
						children: selectedRuns.map((run) => (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-wrap items-center gap-2 px-3 py-2 text-xs-tight",
							children: [
								(0, import_jsx_runtime.jsx)(StatusBadge, {
									label: localizedExecutionStatus(run.status, t),
									variant: toneForLastStatus(run.status)
								}),
								(0, import_jsx_runtime.jsx)("span", {
									className: "text-muted/70 tabular-nums",
									children: formatDateTime(run.startedAt, { locale: uiLanguage })
								}),
								(0, import_jsx_runtime.jsx)("span", {
									className: "text-muted/60",
									children: formatDurationMs(run.latencyMs, { t })
								}),
								(0, import_jsx_runtime.jsx)("span", {
									className: "ml-auto rounded bg-bg/40 px-1 py-0.5 font-mono text-[10px] text-muted/60",
									children: run.source
								}),
								run.error ? (0, import_jsx_runtime.jsx)("div", {
									className: "basis-full whitespace-pre-wrap rounded border border-danger/20 bg-danger/10 px-2 py-1 font-mono text-[11px] text-danger/90",
									children: run.error
								}) : null
							]
						}, run.triggerRunId))
					})
				}), (0, import_jsx_runtime.jsx)(DetailSection, {
					title: "Schedule & behavior",
					className: "h-full",
					children: (0, import_jsx_runtime.jsx)(DetailFactList, { items: [
						{
							label: "Schedule",
							value: scheduleLabel(trigger, t, uiLanguage)
						},
						{
							label: "Trigger type",
							value: getTriggerStartModeLabel(trigger)
						},
						...trigger.triggerType === "event" ? [{
							label: "Event",
							value: trigger.eventKind ? humanizeEventKind(trigger.eventKind) : "Unknown"
						}] : [],
						{
							label: "Wake mode",
							value: getTriggerWakeModeLabel(trigger)
						},
						{
							label: "Status",
							value: trigger.enabled ? "Enabled" : "Paused"
						},
						{
							label: "Max runs",
							value: trigger.maxRuns ? String(trigger.maxRuns) : "Unlimited"
						}
					] })
				})]
			})
		]
	});
}
function WorkflowAutomationDetailPane({ automation, n8nStatus, workflowFetchError, workflowBusyId, workflowOpsBusy, onDeleteDraft, onDeleteWorkflow, onDuplicateWorkflow, onGenerateWorkflow, onRefreshWorkflows, onScheduleWorkflow, onStartLocalN8n, onToggleWorkflowActive }) {
	const { t, uiLanguage } = useApp();
	const chatChrome = useAppWorkspaceChatChrome();
	const [fullWorkflow, setFullWorkflow] = useState(automation.workflow ?? null);
	const [workflowLoading, setWorkflowLoading] = useState(false);
	const [workflowPrompt, setWorkflowPrompt] = useState("");
	const [workflowPromptError, setWorkflowPromptError] = useState(null);
	const [workflowPromptSaving, setWorkflowPromptSaving] = useState(false);
	const workflowGenerating = useWorkflowGenerationState(automation.workflowId);
	const busy = workflowOpsBusy || automation.workflowId != null && workflowBusyId === automation.workflowId;
	const graphWorkflow = fullWorkflow ?? automation.workflow ?? null;
	const nodeCount = graphWorkflow?.nodeCount ?? graphWorkflow?.nodes?.length ?? getWorkflowNodeCount(automation);
	const workflowIsActive = graphWorkflow?.active ?? automation.enabled;
	const nextWorkflowRun = automation.schedules.filter(isTimeBasedTrigger).map((schedule) => schedule.nextRunAtMs ?? 0).filter((value) => value > 0).sort((left, right) => left - right)[0];
	const workflowIdeas = AUTOMATION_DRAFT_EXAMPLES.filter((idea) => idea.kind === "workflow");
	const showWorkflowStarterIdeas = automation.isDraft || nodeCount === 0;
	const showWorkflowPromptBox = automation.isDraft || nodeCount === 0;
	const handleDescribeWorkflow = useCallback(() => {
		chatChrome?.openChat();
		prefillPageChat(DESCRIBE_WORKFLOW_PROMPT, { select: true });
	}, [chatChrome]);
	const handleUseWorkflowIdea = useCallback((idea) => {
		chatChrome?.openChat();
		prefillPageChat(idea.prompt, { select: true });
	}, [chatChrome]);
	const submitWorkflowPrompt = useCallback(async () => {
		const prompt = workflowPrompt.trim();
		if (!prompt) {
			setWorkflowPromptError("Describe what this workflow should do.");
			return;
		}
		setWorkflowPromptError(null);
		setWorkflowPromptSaving(true);
		try {
			await onGenerateWorkflow(automation, prompt);
			setWorkflowPrompt("");
			chatChrome?.openChat();
			prefillPageChat(prompt, { select: false });
		} catch (error) {
			setWorkflowPromptError(error instanceof Error ? error.message : "Failed to generate workflow.");
		} finally {
			setWorkflowPromptSaving(false);
		}
	}, [
		automation,
		chatChrome,
		onGenerateWorkflow,
		workflowPrompt
	]);
	useEffect(() => {
		let cancelled = false;
		setFullWorkflow(automation.workflow ?? null);
		if (!automation.workflowId || !automation.hasBackingWorkflow) {
			setWorkflowLoading(false);
			return;
		}
		setWorkflowLoading(true);
		client.getN8nWorkflow(automation.workflowId).then((workflow) => {
			if (!cancelled) setFullWorkflow(workflow);
		}).catch(() => {
			if (!cancelled) setFullWorkflow(automation.workflow ?? null);
		}).finally(() => {
			if (!cancelled) setWorkflowLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [
		automation.hasBackingWorkflow,
		automation.workflow,
		automation.workflowId
	]);
	return (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-4",
		children: [
			(0, import_jsx_runtime.jsx)(WorkflowRuntimeNotice, {
				status: n8nStatus,
				workflowFetchError,
				busy,
				onRefresh: () => void onRefreshWorkflows(),
				onStartLocal: () => void onStartLocalN8n()
			}),
			(0, import_jsx_runtime.jsx)(DetailHeader, {
				icon: (0, import_jsx_runtime.jsx)(Workflow, {
					className: "h-3.5 w-3.5",
					"aria-hidden": true
				}),
				title: getAutomationDisplayTitle(automation),
				description: null,
				status: (0, import_jsx_runtime.jsx)(DetailStatusIndicator, {
					label: automation.isDraft ? "Draft" : automation.enabled ? "Active" : "Paused",
					tone: automation.isDraft ? "warning" : automation.enabled ? "success" : "muted",
					dotOnly: !automation.isDraft && automation.enabled
				}),
				actions: automation.isDraft ? (0, import_jsx_runtime.jsx)(IconAction, {
					label: "Delete draft",
					onClick: () => void onDeleteDraft(automation),
					icon: (0, import_jsx_runtime.jsx)(Trash2, { className: "h-3.5 w-3.5" }),
					tone: "danger"
				}) : automation.workflowId ? (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: busy ? t("common.updating", { defaultValue: "Updating..." }) : workflowIsActive ? t("automations.n8n.deactivate", { defaultValue: "Deactivate" }) : t("automations.n8n.activate", { defaultValue: "Activate" }),
						onClick: () => void onToggleWorkflowActive(automation),
						disabled: busy,
						ariaBusy: busy,
						icon: workflowIsActive ? (0, import_jsx_runtime.jsx)(Pause, { className: "h-3.5 w-3.5" }) : (0, import_jsx_runtime.jsx)(Play, { className: "h-3.5 w-3.5" }),
						tone: workflowIsActive ? "warning" : "ok"
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: "Schedule workflow",
						onClick: () => onScheduleWorkflow(automation),
						disabled: busy,
						icon: (0, import_jsx_runtime.jsx)(Clock3, { className: "h-3.5 w-3.5" })
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: "Duplicate workflow",
						onClick: () => void onDuplicateWorkflow(automation),
						disabled: busy,
						icon: (0, import_jsx_runtime.jsx)(Copy, { className: "h-3.5 w-3.5" })
					}),
					(0, import_jsx_runtime.jsx)(IconAction, {
						label: busy ? t("common.updating", { defaultValue: "Updating..." }) : t("automations.n8n.deleteWorkflow", { defaultValue: "Delete workflow" }),
						onClick: () => void onDeleteWorkflow(automation),
						disabled: busy,
						ariaBusy: busy,
						icon: (0, import_jsx_runtime.jsx)(Trash2, { className: "h-3.5 w-3.5" }),
						tone: "danger"
					})
				] }) : null
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-2 sm:grid-cols-2 xl:grid-cols-5",
				children: [
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Status",
						value: automation.isDraft ? "Draft" : workflowIsActive ? "Active" : "Paused",
						detail: automation.schedules.length > 0 ? formatScheduleCount(automation.schedules.length) : "No schedule attached",
						tone: automation.isDraft ? "warning" : workflowIsActive ? "ok" : "default"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Nodes",
						value: (0, import_jsx_runtime.jsx)("span", {
							className: "tabular-nums",
							children: nodeCount
						}),
						detail: nodeCount > 0 ? "Visible in the graph below" : "Still blank"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Starts",
						value: automation.schedules.length > 0 ? formatScheduleCount(automation.schedules.length) : "Event or manual",
						detail: automation.schedules.length > 0 ? scheduleLabel(automation.schedules[0], t, uiLanguage) : "No time-based schedule yet"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Next run",
						value: nextWorkflowRun ? formatRelativeFuture(nextWorkflowRun, t) : "Not queued",
						detail: nextWorkflowRun ? formatDateTime(nextWorkflowRun, {
							fallback: "—",
							locale: uiLanguage
						}) : "Trigger it from an event or attach a schedule",
						tone: nextWorkflowRun ? "ok" : "default"
					}),
					(0, import_jsx_runtime.jsx)(OverviewMetricCard, {
						label: "Updated",
						value: formatRelativePast(automation.updatedAt, t),
						detail: formatDateTime(automation.updatedAt, {
							fallback: "—",
							locale: uiLanguage
						})
					})
				]
			}),
			showWorkflowPromptBox && (0, import_jsx_runtime.jsx)(DetailSection, {
				title: "Create workflow",
				children: (0, import_jsx_runtime.jsxs)("div", {
					className: "p-3",
					children: [(0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-col gap-2 rounded-full border border-border/30 bg-bg/50 p-1.5 shadow-sm sm:flex-row sm:items-center",
						children: [(0, import_jsx_runtime.jsx)(Input, {
							"data-workflow-prompt-input": "true",
							value: workflowPrompt,
							onChange: (event) => setWorkflowPrompt(event.target.value),
							onKeyDown: (event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									submitWorkflowPrompt();
								}
							},
							placeholder: WORKFLOW_PROMPT_PLACEHOLDER,
							className: "min-h-10 flex-1 border-0 bg-transparent px-4 shadow-none focus-visible:ring-0",
							autoFocus: automation.isDraft
						}), (0, import_jsx_runtime.jsx)(Button, {
							variant: "default",
							size: "sm",
							className: "h-10 shrink-0 rounded-full px-5",
							disabled: workflowPromptSaving || busy,
							onClick: () => void submitWorkflowPrompt(),
							children: workflowPromptSaving ? "Generating..." : "Generate"
						})]
					}), workflowPromptError && (0, import_jsx_runtime.jsx)("div", {
						className: "mt-2 text-xs text-danger",
						children: workflowPromptError
					})]
				})
			}),
			(0, import_jsx_runtime.jsx)(DetailSection, {
				title: "Workflow graph",
				action: automation.isDraft || nodeCount === 0 ? (0, import_jsx_runtime.jsx)(Button, {
					variant: "ghost",
					size: "sm",
					className: "h-7 px-2 text-xs",
					onClick: () => {
						const input = document.querySelector("[data-workflow-prompt-input='true']");
						input?.focus();
						if (!input) handleDescribeWorkflow();
					},
					children: DESCRIBE_WORKFLOW_PROMPT
				}) : void 0,
				children: (0, import_jsx_runtime.jsx)("div", {
					className: "p-3",
					children: (0, import_jsx_runtime.jsx)(WorkflowGraphViewer, {
						workflow: graphWorkflow,
						loading: workflowLoading,
						isGenerating: workflowGenerating,
						emptyStateActionLabel: DESCRIBE_WORKFLOW_PROMPT,
						emptyStateHelpText: "Describe it above to generate the graph.",
						onEmptyStateAction: () => {
							const input = document.querySelector("[data-workflow-prompt-input='true']");
							input?.focus();
							if (!input) handleDescribeWorkflow();
						},
						status: n8nStatus
					})
				})
			}),
			(0, import_jsx_runtime.jsx)(DetailSection, {
				title: "Data flow",
				children: (0, import_jsx_runtime.jsx)(WorkflowDataFlowStrip, { workflow: graphWorkflow })
			}),
			(0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.95fr)]",
				children: [(0, import_jsx_runtime.jsx)(DetailSection, {
					title: "Starts when",
					className: "h-full",
					children: automation.schedules.length > 0 ? (0, import_jsx_runtime.jsx)("div", {
						className: "divide-y divide-border/20",
						children: automation.schedules.map((schedule) => (0, import_jsx_runtime.jsx)(OverviewListItem, {
							title: schedule.displayName,
							meta: scheduleLabel(schedule, t, uiLanguage),
							detail: formatDateTime(schedule.nextRunAtMs ?? null, {
								fallback: "No next run queued",
								locale: uiLanguage
							}),
							trailing: schedule.enabled ? "Live" : "Paused",
							tone: schedule.enabled ? "success" : "muted"
						}, schedule.id))
					}) : (0, import_jsx_runtime.jsx)("div", {
						className: "px-4 py-4 text-xs-tight text-muted/70",
						children: "No schedule yet. Start it from an event or add one in the sidebar."
					})
				}), showWorkflowStarterIdeas ? (0, import_jsx_runtime.jsx)(DetailSection, {
					title: "Starter ideas",
					className: "h-full",
					children: (0, import_jsx_runtime.jsx)("div", {
						className: "p-2",
						children: (0, import_jsx_runtime.jsx)(OverviewIdeaGrid, {
							ideas: workflowIdeas,
							onSelect: handleUseWorkflowIdea
						})
					})
				}) : (0, import_jsx_runtime.jsx)(DetailSection, {
					title: "Details",
					className: "h-full",
					children: (0, import_jsx_runtime.jsx)(DetailFactList, { items: [
						{
							label: "Type",
							value: automation.isDraft ? "Draft" : "n8n workflow"
						},
						{
							label: "Nodes",
							value: String(nodeCount)
						},
						{
							label: "Schedules",
							value: String(automation.schedules.length)
						},
						{
							label: "Updated",
							value: formatRelativePast(automation.updatedAt, t)
						}
					] })
				})]
			})
		]
	});
}
function AutomationSidebarItem({ item, selected, onClick, onDoubleClick }) {
	let Icon = Zap;
	let tone = "muted";
	let titleClass = "text-txt";
	if (item.type === "n8n_workflow") {
		Icon = Workflow;
		tone = item.isDraft ? "warning" : item.enabled ? "success" : "muted";
	} else if (item.type === "automation_draft") {
		Icon = FileText;
		tone = "warning";
	} else if (item.trigger) {
		Icon = Clock3;
		tone = item.trigger.enabled ? "success" : "muted";
		if (item.trigger.lastStatus) {
			if (toneForLastStatus(item.trigger.lastStatus) === "danger") tone = "danger";
		}
	} else if (item.task) if (item.system) {
		Icon = Settings;
		tone = "muted";
		titleClass = "text-muted";
	} else if (item.task.isCompleted) {
		Icon = CheckCircle2;
		tone = "muted";
		titleClass = "text-muted line-through";
	} else {
		Icon = Circle;
		tone = "success";
	}
	else return null;
	return (0, import_jsx_runtime.jsxs)("button", {
		type: "button",
		onClick,
		onDoubleClick,
		"aria-current": selected ? "page" : void 0,
		className: `group flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] py-1 pl-2 pr-1.5 text-left transition-colors ${selected ? "bg-accent/15 text-txt" : "text-txt hover:bg-bg-muted/50"} ${item.system ? "opacity-60" : ""}`,
		children: [
			(0, import_jsx_runtime.jsx)(Icon, {
				className: "h-3.5 w-3.5 shrink-0 text-muted/70",
				"aria-hidden": true
			}),
			(0, import_jsx_runtime.jsx)("span", {
				className: `truncate text-xs-tight ${titleClass}`,
				children: getAutomationDisplayTitle(item)
			}),
			(0, import_jsx_runtime.jsx)(StatusDot, {
				tone,
				className: "ml-auto h-1.5 w-1.5 shrink-0"
			})
		]
	});
}
function AutomationsSidebarChatGuideActions() {
	return (0, import_jsx_runtime.jsx)(Button, {
		variant: "outline",
		size: "sm",
		className: "h-8 gap-1.5 px-3 text-sm",
		onClick: () => prefillPageChat(DESCRIBE_WORKFLOW_PROMPT, { select: true }),
		children: DESCRIBE_WORKFLOW_PROMPT
	});
}
function AutomationsSidebarChat({ activeItem }) {
	const { activeConversationId, conversations, t } = useApp();
	const { refreshAutomations } = useAutomationsViewContext();
	const [overviewVisible, setOverviewVisible] = useState(false);
	const scopedActiveItem = overviewVisible ? null : activeItem;
	useEffect(() => {
		const overviewWindow = window;
		setOverviewVisible(Boolean(overviewWindow.__elizaAutomationsOverviewVisible));
		const handleOverviewVisibility = (event) => {
			const detail = event.detail;
			setOverviewVisible(Boolean(detail?.visible));
		};
		window.addEventListener(AUTOMATIONS_OVERVIEW_VISIBILITY_EVENT, handleOverviewVisibility);
		return () => window.removeEventListener(AUTOMATIONS_OVERVIEW_VISIBILITY_EVENT, handleOverviewVisibility);
	}, []);
	const automationConversationAdapter = useMemo(() => {
		if (!scopedActiveItem) return null;
		const bridgeConversationId = getAutomationBridgeIdForItem(scopedActiveItem, activeConversationId, conversations);
		if (scopedActiveItem.type === "n8n_workflow") {
			const metadata = scopedActiveItem.workflowId ? buildWorkflowConversationMetadata(scopedActiveItem.workflowId, scopedActiveItem.title, bridgeConversationId) : buildWorkflowDraftConversationMetadata(scopedActiveItem.draftId ?? scopedActiveItem.id, bridgeConversationId);
			return {
				allowClear: false,
				buildRoutingMetadata: () => buildAutomationResponseRoutingMetadata(metadata),
				identityKey: JSON.stringify({
					metadata,
					title: scopedActiveItem.title
				}),
				onAfterSend: () => void refreshAutomations(),
				resolveConversation: () => resolveAutomationConversation({
					title: scopedActiveItem.title,
					metadata
				})
			};
		}
		if (scopedActiveItem.type === "automation_draft") {
			const metadata = buildAutomationDraftConversationMetadata(scopedActiveItem.draftId ?? scopedActiveItem.id, bridgeConversationId);
			return {
				allowClear: false,
				buildRoutingMetadata: () => buildAutomationResponseRoutingMetadata(metadata),
				identityKey: JSON.stringify({
					metadata,
					title: getAutomationDisplayTitle(scopedActiveItem)
				}),
				onAfterSend: () => void refreshAutomations(),
				resolveConversation: () => resolveAutomationConversation({
					title: getAutomationDisplayTitle(scopedActiveItem),
					metadata
				})
			};
		}
		return null;
	}, [
		scopedActiveItem,
		activeConversationId,
		conversations,
		refreshAutomations
	]);
	if (scopedActiveItem?.type === "n8n_workflow") return (0, import_jsx_runtime.jsx)(PageScopedChatPane, {
		scope: "page-automations",
		conversationAdapter: automationConversationAdapter ?? void 0,
		introOverride: {
			title: scopedActiveItem.isDraft ? "Workflow draft" : "Workflow",
			body: scopedActiveItem.isDraft ? "Describe the trigger and steps. The graph updates here." : "Ask to inspect, change, or troubleshoot this workflow.",
			actions: scopedActiveItem.isDraft ? (0, import_jsx_runtime.jsx)(AutomationsSidebarChatGuideActions, {}) : void 0
		},
		placeholderOverride: scopedActiveItem.isDraft ? DESCRIBE_WORKFLOW_PROMPT : t("automations.chat.placeholder"),
		systemAddendumOverride: WORKFLOW_SYSTEM_ADDENDUM
	});
	if (scopedActiveItem?.type === "automation_draft") return (0, import_jsx_runtime.jsx)(PageScopedChatPane, {
		scope: "page-automations",
		conversationAdapter: automationConversationAdapter ?? void 0,
		introOverride: {
			title: "Draft",
			body: "Describe the result and what should start it."
		},
		placeholderOverride: "Describe your automation",
		systemAddendumOverride: AUTOMATION_DRAFT_SYSTEM_ADDENDUM
	});
	return (0, import_jsx_runtime.jsx)(PageScopedChatPane, {
		scope: "page-automations",
		placeholderOverride: "Describe your workflow, task, or schedule",
		introOverride: {
			title: "Automations",
			body: "Create or inspect a task or workflow.",
			actions: (0, import_jsx_runtime.jsx)(AutomationsSidebarChatGuideActions, {})
		}
	});
}
function AutomationsLayout() {
	const { activeConversationId, conversations, setTab } = useApp();
	const ctx = useAutomationsViewContext();
	const { closeEditor, editorEnabled, editingId, editingTaskId, editorOpen, editorMode, form, formError, loadTriggerRuns, modalTitle, onDeleteTrigger, onRunSelectedTrigger, onSubmitTrigger, onToggleTriggerEnabled, openCreateTrigger, openCreateTask, saveFormAsTemplate, selectedItemId, setEditingId, setEditorOpen, setEditorMode, setField, setFilter, setForm, setFormError, setSelectedItemId, setSelectedItemKind, showDetailPane, showFirstRunEmptyState, resolvedSelectedItem, t, templateNotice, triggers, filteredItems, triggerRunsById, triggersSaving, automationNodes, combinedError, isLoading, n8nStatus, workflowFetchError } = ctx;
	const [showDashboard, setShowDashboard] = useState(true);
	const [collapsedSections, setCollapsedSections] = useState(() => new Set(["agent-owned"]));
	const toggleSectionCollapsed = useCallback((key) => {
		setCollapsedSections((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);
	const [pageNotice, setPageNotice] = useState(null);
	const [missingCredentials, setMissingCredentials] = useState(null);
	const [clarification, setClarification] = useState(null);
	const [workflowBusyId, setWorkflowBusyId] = useState(null);
	const [workflowOpsBusy, setWorkflowOpsBusy] = useState(false);
	const [activeWorkflowConversation, setActiveWorkflowConversation] = useState(null);
	const [createDialogMode, setCreateDialogMode] = useState(null);
	const [templatesModalOpen, setTemplatesModalOpen] = useState(false);
	const [activeSubpage, setActiveSubpage] = useState(() => getAutomationSubpageFromPath(getNavigationPathFromWindow()));
	const visibleItems = filteredItems;
	useEffect(() => {
		if (!showDashboard) return;
		setSelectedItemId(null);
		setSelectedItemKind(null);
	}, [
		setSelectedItemId,
		setSelectedItemKind,
		showDashboard
	]);
	useEffect(() => {
		window.__elizaAutomationsOverviewVisible = showDashboard;
		window.dispatchEvent(new CustomEvent(AUTOMATIONS_OVERVIEW_VISIBILITY_EVENT, { detail: { visible: showDashboard } }));
	}, [showDashboard]);
	const syncSubpageFromLocation = useCallback(() => {
		const pathname = getNavigationPathFromWindow();
		const nextSubpage = getAutomationSubpageFromPath(pathname);
		setActiveSubpage((previous) => previous === nextSubpage ? previous : nextSubpage);
		if (normalizeAutomationPath(pathname) === "/node-catalog") syncAutomationSubpagePath("node-catalog", "replace");
	}, []);
	useEffect(() => {
		syncSubpageFromLocation();
		window.addEventListener("popstate", syncSubpageFromLocation);
		window.addEventListener("hashchange", syncSubpageFromLocation);
		return () => {
			window.removeEventListener("popstate", syncSubpageFromLocation);
			window.removeEventListener("hashchange", syncSubpageFromLocation);
		};
	}, [syncSubpageFromLocation]);
	const showAutomationsList = useCallback((mode = "push") => {
		setActiveSubpage("list");
		syncAutomationSubpagePath("list", mode);
	}, []);
	const showNodeCatalog = useCallback((mode = "push") => {
		setEditorOpen(false);
		setEditingId(null);
		ctx.setEditingTaskId(null);
		setActiveSubpage("node-catalog");
		syncAutomationSubpagePath("node-catalog", mode);
	}, [
		ctx,
		setEditingId,
		setEditorOpen
	]);
	const mobileSidebarLabel = activeSubpage === "node-catalog" ? "Nodes" : showDashboard ? "Overview" : editorOpen || editingId || editingTaskId ? modalTitle : resolvedSelectedItem ? getAutomationDisplayTitle(resolvedSelectedItem) : "Automations";
	const selectItem = useCallback((item) => {
		showAutomationsList();
		setShowDashboard(false);
		setSelectedItemId(item.id);
		setSelectedItemKind(getSelectionKind(item));
		setEditorOpen(false);
		setEditingId(null);
		ctx.setEditingTaskId(null);
		if (item.trigger) loadTriggerRuns(item.trigger.id);
	}, [
		ctx,
		loadTriggerRuns,
		setEditingId,
		setEditorOpen,
		setSelectedItemId,
		setSelectedItemKind,
		showAutomationsList
	]);
	const showOverview = useCallback(() => {
		showAutomationsList();
		setShowDashboard(true);
		setSelectedItemId(null);
		setSelectedItemKind(null);
		setEditorOpen(false);
		setEditingId(null);
		ctx.setEditingTaskId(null);
	}, [
		ctx,
		setEditingId,
		setEditorOpen,
		setSelectedItemId,
		setSelectedItemKind,
		showAutomationsList
	]);
	useEffect(() => {
		const handler = (event) => {
			const { workflowId } = event.detail;
			const match = filteredItems.find((item) => item.workflowId === workflowId || item.id === workflowId);
			if (match) selectItem(match);
		};
		window.addEventListener(VISUALIZE_WORKFLOW_EVENT, handler);
		return () => window.removeEventListener(VISUALIZE_WORKFLOW_EVENT, handler);
	}, [filteredItems, selectItem]);
	const findAutomationForConversation = useCallback((data, conversationId) => data?.automations.find((item) => item.room?.conversationId === conversationId) ?? null, []);
	const refreshAutomationsWithDraftBinding = useCallback(async (draftConversation) => {
		const previousWorkflowIds = new Set(ctx.allItems.filter((item) => item.type === "n8n_workflow" && item.workflowId != null && !item.isDraft).map((item) => item.workflowId));
		const previousTriggerIds = new Set(ctx.allItems.filter((item) => item.trigger?.id).map((item) => item.trigger?.id));
		const previousTaskIds = new Set(ctx.allItems.filter((item) => item.task?.id).map((item) => item.task?.id));
		const data = await ctx.refreshAutomations();
		const draftScope = draftConversation?.metadata?.scope;
		if (!draftConversation || !draftScope) return data;
		const bridgeConversationId = draftConversation.metadata?.terminalBridgeConversationId;
		if (draftScope === "automation-workflow-draft" && draftConversation.metadata?.automationType === "n8n_workflow") {
			const createdWorkflows = data?.automations.filter((item) => item.type === "n8n_workflow" && item.workflowId != null && !item.isDraft && !previousWorkflowIds.has(item.workflowId)) ?? [];
			if (createdWorkflows.length !== 1) return data;
			const created = createdWorkflows[0];
			const reboundMetadata = buildWorkflowConversationMetadata(created.workflowId, created.title, bridgeConversationId);
			const { conversation } = await client.updateConversation(draftConversation.id, {
				title: created.title,
				metadata: reboundMetadata
			});
			setActiveWorkflowConversation(conversation);
			return await ctx.refreshAutomations();
		}
		if (draftScope === "automation-draft") {
			const createdTriggers = data?.automations.filter((item) => item.trigger != null && !previousTriggerIds.has(item.trigger.id)) ?? [];
			const createdTasks = data?.automations.filter((item) => item.task != null && !item.system && !previousTaskIds.has(item.task.id)) ?? [];
			const createdWorkflows = data?.automations.filter((item) => item.type === "n8n_workflow" && item.workflowId != null && !item.isDraft && !previousWorkflowIds.has(item.workflowId)) ?? [];
			if (createdTriggers.length + createdTasks.length + createdWorkflows.length !== 1) return data;
			const draftWasSelected = selectedItemId === `automation-draft:${draftConversation.metadata?.draftId ?? ""}`;
			const followSelection = (nextItemId, kind) => {
				if (!draftWasSelected) return;
				setSelectedItemId(nextItemId);
				setSelectedItemKind(kind);
			};
			if (createdTriggers.length === 1) {
				const created = createdTriggers[0];
				const trigger = created.trigger;
				if (!trigger) return await ctx.refreshAutomations();
				const reboundMetadata = buildCoordinatorTriggerConversationMetadata(trigger.id, bridgeConversationId);
				await client.updateConversation(draftConversation.id, {
					title: created.title,
					metadata: reboundMetadata
				});
				followSelection(created.id, "trigger");
				return await ctx.refreshAutomations();
			}
			if (createdTasks.length === 1) {
				const created = createdTasks[0];
				const task = created.task;
				if (!task) return await ctx.refreshAutomations();
				const reboundMetadata = buildCoordinatorConversationMetadata(task.id, bridgeConversationId);
				await client.updateConversation(draftConversation.id, {
					title: created.title,
					metadata: reboundMetadata
				});
				followSelection(created.id, "task");
				return await ctx.refreshAutomations();
			}
			if (createdWorkflows.length === 1) {
				const created = createdWorkflows[0];
				const reboundMetadata = buildWorkflowConversationMetadata(created.workflowId, created.title, bridgeConversationId);
				const { conversation } = await client.updateConversation(draftConversation.id, {
					title: created.title,
					metadata: reboundMetadata
				});
				setActiveWorkflowConversation(conversation);
				followSelection(created.id, "workflow");
				return await ctx.refreshAutomations();
			}
		}
		return data;
	}, [
		ctx,
		selectedItemId,
		setSelectedItemId,
		setSelectedItemKind
	]);
	const bindConversationToWorkflow = useCallback(async (conversation, workflow, bridgeConversationId) => {
		const reboundMetadata = buildWorkflowConversationMetadata(workflow.id, workflow.name, bridgeConversationId ?? void 0);
		const { conversation: reboundConversation } = await client.updateConversation(conversation.id, {
			title: workflow.name,
			metadata: reboundMetadata
		});
		setActiveWorkflowConversation(reboundConversation);
		return reboundConversation;
	}, []);
	const selectWorkflowById = useCallback((workflowId) => {
		setShowDashboard(false);
		setSelectedItemId(`workflow:${workflowId}`);
		setSelectedItemKind("workflow");
		setEditorOpen(false);
		setEditingId(null);
		ctx.setEditingTaskId(null);
	}, [
		ctx,
		setEditingId,
		setEditorOpen,
		setSelectedItemId,
		setSelectedItemKind
	]);
	const generateWorkflowFromPrompt = useCallback(async ({ prompt, title, conversation, bridgeConversationId, workflowId }) => {
		setWorkflowOpsBusy(true);
		setPageNotice(null);
		setMissingCredentials(null);
		setClarification(null);
		try {
			const result = await client.generateN8nWorkflow({
				prompt,
				...title?.trim() ? { name: title.trim() } : {},
				...workflowId ? { workflowId } : {},
				...bridgeConversationId ? { bridgeConversationId } : {}
			});
			if (isMissingCredentialsResponse(result)) {
				setMissingCredentials(result.missingCredentials);
				return null;
			}
			if (isNeedsClarificationResponse(result)) {
				setClarification({
					response: result,
					currentIndex: 0,
					busy: false
				});
				return null;
			}
			if (conversation) await bindConversationToWorkflow(conversation, result, bridgeConversationId);
			await ctx.refreshAutomations();
			selectWorkflowById(result.id);
			return result;
		} finally {
			setWorkflowOpsBusy(false);
		}
	}, [
		bindConversationToWorkflow,
		ctx,
		selectWorkflowById
	]);
	const resolveClarificationChoice = useCallback(async (paramPath, value) => {
		setClarification((prev) => prev ? {
			...prev,
			busy: true,
			error: void 0
		} : prev);
		try {
			const draftRecord = clarification?.response.draft;
			if (!draftRecord) {
				setClarification((prev) => prev ? {
					...prev,
					busy: false
				} : prev);
				return;
			}
			const result = await client.resolveN8nClarification({
				draft: draftRecord,
				resolutions: [{
					paramPath,
					value
				}]
			});
			if (isMissingCredentialsResponse(result)) {
				setClarification(null);
				setMissingCredentials(result.missingCredentials);
				return;
			}
			if (isNeedsClarificationResponse(result)) {
				setClarification({
					response: result,
					currentIndex: 0,
					busy: false
				});
				return;
			}
			setClarification(null);
			try {
				await ctx.refreshAutomations();
				selectWorkflowById(result.id);
			} catch (refreshErr) {
				setPageNotice(`Workflow deployed but the automations list could not refresh: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setClarification((prev) => prev ? {
				...prev,
				busy: false,
				error: message
			} : prev);
		}
	}, [
		clarification,
		ctx,
		selectWorkflowById
	]);
	const dismissClarification = useCallback(() => {
		setClarification(null);
	}, []);
	const createWorkflowDraft = useCallback(async (options) => {
		setPageNotice(null);
		showAutomationsList();
		const draftId = createWorkflowDraftId();
		setShowDashboard(false);
		setFilter("all");
		setSelectedItemId(`workflow-draft:${draftId}`);
		setSelectedItemKind("workflow");
		setEditorOpen(false);
		setEditingId(null);
		ctx.setEditingTaskId(null);
		const bridgeConversationId = getAutomationBridgeIdForItem(resolvedSelectedItem, activeConversationId, conversations);
		const metadata = buildWorkflowDraftConversationMetadata(draftId, bridgeConversationId);
		try {
			const conversation = await resolveAutomationConversation({
				title: options?.title?.trim() || WORKFLOW_DRAFT_TITLE,
				metadata
			});
			setActiveWorkflowConversation(conversation);
			if (options?.initialPrompt?.trim()) {
				await generateWorkflowFromPrompt({
					prompt: options.initialPrompt.trim(),
					title: options.title?.trim() || void 0,
					conversation,
					bridgeConversationId
				});
				return;
			}
			setSelectedItemId(findAutomationForConversation(await ctx.refreshAutomations(), conversation.id)?.id ?? `workflow-draft:${draftId}`);
			setSelectedItemKind("workflow");
		} catch (error) {
			setPageNotice(error instanceof Error ? error.message : "Failed to create the workflow draft room.");
		}
	}, [
		activeConversationId,
		conversations,
		ctx,
		findAutomationForConversation,
		generateWorkflowFromPrompt,
		resolvedSelectedItem,
		setFilter,
		setEditingId,
		setEditorOpen,
		setSelectedItemId,
		setSelectedItemKind,
		showAutomationsList
	]);
	const promoteAutomationToWorkflow = useCallback(async (item) => {
		await createWorkflowDraft({
			title: `${item.title} Workflow`,
			initialPrompt: buildWorkflowCompilationPrompt(item)
		});
	}, [createWorkflowDraft]);
	const handleTemplateSelected = useCallback(async (seedPrompt) => {
		setTemplatesModalOpen(false);
		await createWorkflowDraft({ initialPrompt: seedPrompt });
	}, [createWorkflowDraft]);
	const handleZeroStateNewTrigger = useCallback(() => {
		showAutomationsList();
		openCreateTrigger();
	}, [openCreateTrigger, showAutomationsList]);
	const handleZeroStateNewTask = useCallback(() => {
		showAutomationsList();
		openCreateTask();
	}, [openCreateTask, showAutomationsList]);
	useCallback((idea) => {
		showAutomationsList();
		openCreateTrigger();
		setForm({
			...emptyForm,
			displayName: idea.label,
			instructions: idea.prompt
		});
	}, [
		openCreateTrigger,
		setForm,
		showAutomationsList
	]);
	const handleDescribeAutomation = useCallback(async (prompt) => {
		const trimmed = prompt.trim();
		if (!trimmed) return;
		if (inferAutomationPromptKind(trimmed) === "workflow") {
			await createWorkflowDraft({
				title: titleFromAutomationPrompt(trimmed),
				initialPrompt: trimmed
			});
			return;
		}
		showAutomationsList();
		openCreateTrigger();
		setForm({
			...emptyForm,
			displayName: titleFromAutomationPrompt(trimmed),
			instructions: trimmed
		});
	}, [
		createWorkflowDraft,
		openCreateTrigger,
		setForm,
		showAutomationsList
	]);
	const handleRefreshWorkflows = useCallback(async () => {
		setPageNotice(null);
		if (!await refreshAutomationsWithDraftBinding(activeWorkflowConversation) && ctx.automationsError) setPageNotice(ctx.automationsError);
	}, [
		activeWorkflowConversation,
		ctx.automationsError,
		refreshAutomationsWithDraftBinding
	]);
	const handleStartLocalN8n = useCallback(async () => {
		setWorkflowOpsBusy(true);
		setPageNotice(null);
		try {
			await client.startN8nSidecar();
			await ctx.refreshAutomations();
		} catch (error) {
			setPageNotice(error instanceof Error ? error.message : t("automations.n8n.startFailed", { defaultValue: "Failed to start local automations." }));
		} finally {
			setWorkflowOpsBusy(false);
		}
	}, [ctx, t]);
	const handleToggleWorkflowActive = useCallback(async (item) => {
		if (!item.workflowId) return;
		setWorkflowBusyId(item.workflowId);
		setPageNotice(null);
		try {
			if (item.enabled) await client.deactivateN8nWorkflow(item.workflowId);
			else await client.activateN8nWorkflow(item.workflowId);
			await ctx.refreshAutomations();
		} catch (error) {
			setPageNotice(error instanceof Error ? error.message : t("automations.n8n.updateStateFailed", { defaultValue: "Failed to update workflow state." }));
		} finally {
			setWorkflowBusyId(null);
		}
	}, [ctx, t]);
	const handleGenerateWorkflow = useCallback(async (item, prompt) => {
		const conversationId = item.room?.conversationId;
		const conversation = conversationId ? conversations.find((candidate) => candidate.id === conversationId) ?? null : null;
		await generateWorkflowFromPrompt({
			prompt,
			title: item.title.trim() && item.title !== WORKFLOW_DRAFT_TITLE ? item.title : void 0,
			conversation,
			bridgeConversationId: item.room?.terminalBridgeConversationId,
			workflowId: item.hasBackingWorkflow ? item.workflowId : null
		});
	}, [conversations, generateWorkflowFromPrompt]);
	const handleScheduleWorkflow = useCallback((item) => {
		if (!item.workflowId) {
			setPageNotice("Generate the workflow before scheduling it.");
			return;
		}
		setForm({
			...emptyForm,
			displayName: `Run ${item.title}`,
			kind: "workflow",
			workflowId: item.workflowId,
			workflowName: item.title
		});
		setEditorMode("trigger");
		setEditingId(null);
		ctx.setEditingTaskId(null);
		setSelectedItemId(null);
		setSelectedItemKind(null);
		setEditorOpen(true);
		setShowDashboard(false);
	}, [
		ctx,
		setEditingId,
		setEditorMode,
		setEditorOpen,
		setForm,
		setSelectedItemId,
		setSelectedItemKind
	]);
	const handleDeleteWorkflow = useCallback(async (item) => {
		if (!item.workflowId) return;
		if (!await confirmDesktopAction({
			title: t("automations.n8n.deleteWorkflow", { defaultValue: "Delete workflow" }),
			message: item.schedules.length > 0 ? `Delete "${item.title}" and ${item.schedules.length} attached schedule${item.schedules.length === 1 ? "" : "s"}? This cannot be undone.` : t("automations.n8n.deleteConfirmWorkflow", {
				defaultValue: "Delete \"{{name}}\"? This cannot be undone.",
				name: item.title
			}),
			confirmLabel: t("automations.n8n.deleteWorkflow", { defaultValue: "Delete workflow" }),
			cancelLabel: t("common.cancel"),
			type: "warning"
		})) return;
		setWorkflowBusyId(item.workflowId);
		setPageNotice(null);
		try {
			await client.deleteN8nWorkflow(item.workflowId);
			await Promise.all(item.schedules.map((schedule) => client.deleteTrigger(schedule.id)));
			const conversationId = item.room?.conversationId;
			if (conversationId) try {
				await client.deleteConversation(conversationId);
			} catch (roomErr) {
				setPageNotice(`Workflow deleted, but its chat room could not be removed: ${roomErr instanceof Error ? roomErr.message : String(roomErr)}`);
			}
			if (selectedItemId === item.id) {
				setSelectedItemId(null);
				setSelectedItemKind(null);
			}
			if (conversationId && activeWorkflowConversation?.id === conversationId) setActiveWorkflowConversation(null);
			await ctx.refreshAutomations();
		} catch (error) {
			setPageNotice(error instanceof Error ? error.message : t("automations.n8n.deleteFailed", { defaultValue: "Failed to delete workflow." }));
		} finally {
			setWorkflowBusyId(null);
		}
	}, [
		activeWorkflowConversation?.id,
		ctx,
		selectedItemId,
		setSelectedItemId,
		setSelectedItemKind,
		t
	]);
	const handleDuplicateWorkflow = useCallback(async (item) => {
		if (!item.workflowId) return;
		setPageNotice(null);
		try {
			const workflow = await client.getN8nWorkflow(item.workflowId);
			const copy = await client.createN8nWorkflow(buildWorkflowCopyRequest(workflow, `${item.title} Copy`));
			await ctx.refreshAutomations();
			selectWorkflowById(copy.id);
		} catch (error) {
			setPageNotice(error instanceof Error ? error.message : "Failed to duplicate workflow.");
		}
	}, [ctx, selectWorkflowById]);
	const handleDeleteDraft = useCallback(async (item) => {
		const conversationId = item.room?.conversationId ?? activeWorkflowConversation?.id ?? null;
		if (!conversationId) {
			setPageNotice("This draft is missing its automation room.");
			return;
		}
		if (!await confirmDesktopAction({
			title: "Delete draft",
			message: `Delete "${getAutomationDisplayTitle(item)}"? This removes the draft room and its conversation.`,
			confirmLabel: "Delete draft",
			cancelLabel: t("common.cancel"),
			type: "warning"
		})) return;
		setPageNotice(null);
		try {
			await client.deleteConversation(conversationId);
			if (selectedItemId === item.id) {
				setSelectedItemId(null);
				setSelectedItemKind(null);
			}
			if (activeWorkflowConversation?.id === conversationId) setActiveWorkflowConversation(null);
			await ctx.refreshAutomations();
			setShowDashboard(true);
		} catch (error) {
			setPageNotice(error instanceof Error ? error.message : "Failed to delete draft.");
		}
	}, [
		activeWorkflowConversation?.id,
		ctx,
		selectedItemId,
		setSelectedItemId,
		setSelectedItemKind,
		t
	]);
	const workflowItems = useMemo(() => visibleItems.filter((item) => item.type === "n8n_workflow"), [visibleItems]);
	const taskItems = useMemo(() => visibleItems.filter((item) => item.type === "automation_draft" || item.trigger != null), [visibleItems]);
	const agentOwnedItems = useMemo(() => visibleItems.filter((item) => item.task != null && item.system), [visibleItems]);
	const allDraftItems = useMemo(() => ctx.allItems.filter((item) => item.type === "automation_draft"), [ctx.allItems]);
	useEffect(() => {
		if (allDraftItems.length === 0) return void 0;
		const draftConversations = allDraftItems.map((item) => {
			const conversationId = item.room?.conversationId;
			if (!conversationId) return null;
			return conversations.find((c) => c.id === conversationId) ?? null;
		}).filter((c) => c != null);
		if (draftConversations.length === 0) return void 0;
		const interval = window.setInterval(() => {
			for (const draftConversation of draftConversations) refreshAutomationsWithDraftBinding(draftConversation);
		}, 5e3);
		return () => window.clearInterval(interval);
	}, [
		allDraftItems,
		conversations,
		refreshAutomationsWithDraftBinding
	]);
	const renderItem = (item) => (0, import_jsx_runtime.jsx)(AutomationSidebarItem, {
		item,
		selected: selectedItemId === item.id,
		onClick: () => selectItem(item),
		onDoubleClick: item.task && !item.system ? () => {
			showAutomationsList();
			ctx.openEditTask(item.task);
		} : item.trigger ? () => {
			showAutomationsList();
			ctx.openEditTrigger(item.trigger);
			loadTriggerRuns(item.trigger.id);
		} : void 0
	}, item.id);
	const nodeCatalogActive = activeSubpage === "node-catalog";
	const nodeCatalogLabel = t("automations.nodeCatalog", { defaultValue: "Nodes" });
	const automationsSidebar = (0, import_jsx_runtime.jsx)(AppPageSidebar, {
		testId: "automations-sidebar",
		collapsible: true,
		contentIdentity: "automations",
		collapseButtonTestId: "automations-sidebar-collapse-toggle",
		expandButtonTestId: "automations-sidebar-expand-toggle",
		collapseButtonAriaLabel: t("automations.collapse", { defaultValue: "Collapse automations" }),
		expandButtonAriaLabel: t("automations.expand", { defaultValue: "Expand automations" }),
		bottomAction: (0, import_jsx_runtime.jsxs)("button", {
			type: "button",
			onClick: () => showNodeCatalog(),
			"aria-pressed": nodeCatalogActive,
			title: nodeCatalogLabel,
			className: `inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] bg-transparent px-1.5 text-2xs font-semibold uppercase tracking-[0.12em] transition-colors ${nodeCatalogActive ? "text-txt" : "text-muted hover:text-txt"}`,
			children: [(0, import_jsx_runtime.jsx)(Grid3x3, {
				className: "h-3.5 w-3.5",
				"aria-hidden": true
			}), (0, import_jsx_runtime.jsx)("span", { children: nodeCatalogLabel })]
		}),
		collapsedRailAction: (0, import_jsx_runtime.jsx)(SidebarCollapsedActionButton, {
			"aria-label": "Create task or workflow",
			onClick: () => setCreateDialogMode("all"),
			children: (0, import_jsx_runtime.jsx)(Plus, { className: "h-4 w-4" })
		}),
		collapsedRailItems: visibleItems.map((item) => (0, import_jsx_runtime.jsx)(SidebarContent.RailItem, {
			"aria-label": getAutomationDisplayTitle(item),
			title: getAutomationDisplayTitle(item),
			active: item.id === selectedItemId,
			indicatorTone: getAutomationIndicatorTone(item),
			onClick: () => selectItem(item),
			children: railMonogram(getAutomationDisplayTitle(item))
		}, item.id)),
		children: (0, import_jsx_runtime.jsx)(SidebarScrollRegion, {
			className: "!px-0 !pb-2 !pt-0 [scrollbar-gutter:auto]",
			style: { scrollbarGutter: "auto" },
			children: (0, import_jsx_runtime.jsxs)(SidebarPanel, {
				className: "bg-transparent gap-0 p-0 shadow-none",
				children: [
					isLoading && (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2 px-2 py-1.5 text-2xs text-muted",
						children: [(0, import_jsx_runtime.jsx)("div", { className: "h-3 w-3 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" }), t("common.loading")]
					}),
					(0, import_jsx_runtime.jsxs)("button", {
						type: "button",
						onClick: showOverview,
						"aria-current": showDashboard ? "page" : void 0,
						className: `mt-0 flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left text-xs-tight transition-colors ${showDashboard ? "bg-accent/15 text-txt" : "text-txt hover:bg-bg-muted/50"}`,
						children: [(0, import_jsx_runtime.jsx)(LayoutDashboard, {
							className: "h-3.5 w-3.5 shrink-0 text-muted/70",
							"aria-hidden": true
						}), (0, import_jsx_runtime.jsx)("span", {
							className: "truncate",
							children: "Overview"
						})]
					}),
					(0, import_jsx_runtime.jsxs)("div", {
						className: "mt-0.5 space-y-1",
						children: [
							(0, import_jsx_runtime.jsx)(AutomationCollapsibleSection, {
								sectionKey: "tasks",
								label: "Tasks",
								icon: (0, import_jsx_runtime.jsx)(FileText, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								}),
								count: taskItems.length,
								collapsed: collapsedSections.has("tasks"),
								onToggleCollapsed: toggleSectionCollapsed,
								onAdd: handleZeroStateNewTask,
								addLabel: "Create task",
								emptyLabel: "No tasks",
								children: taskItems.map(renderItem)
							}),
							(0, import_jsx_runtime.jsx)(AutomationCollapsibleSection, {
								sectionKey: "workflows",
								label: "Workflows",
								icon: (0, import_jsx_runtime.jsx)(Workflow, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								}),
								count: workflowItems.length,
								collapsed: collapsedSections.has("workflows"),
								onToggleCollapsed: toggleSectionCollapsed,
								onAdd: () => void createWorkflowDraft(),
								addLabel: "Create workflow",
								emptyLabel: "No workflows",
								children: workflowItems.map(renderItem)
							}),
							(0, import_jsx_runtime.jsx)(AutomationCollapsibleSection, {
								sectionKey: "agent-owned",
								label: "Internal",
								icon: (0, import_jsx_runtime.jsx)(SquareTerminal, {
									className: "h-3.5 w-3.5",
									"aria-hidden": true
								}),
								count: agentOwnedItems.length,
								collapsed: collapsedSections.has("agent-owned"),
								onToggleCollapsed: toggleSectionCollapsed,
								emptyLabel: "No internal automations",
								children: agentOwnedItems.map(renderItem)
							})
						]
					})
				]
			})
		})
	});
	return (0, import_jsx_runtime.jsxs)(PageLayout, {
		className: "h-full bg-transparent",
		"data-testid": "automations-shell",
		sidebar: automationsSidebar,
		contentInnerClassName: "w-full",
		footer: (0, import_jsx_runtime.jsx)(WidgetHost, {
			slot: "automations",
			className: "py-2"
		}),
		mobileSidebarLabel,
		children: [
			(0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-h-0 flex-1 flex-col",
				children: [
					activeSubpage === "node-catalog" || !showDashboard && showDetailPane ? (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						className: "mb-3 flex items-center gap-2 rounded-2xl border border-border/30 bg-bg/25 px-4 py-3 text-base font-medium text-muted hover:text-txt md:hidden",
						onClick: () => {
							if (activeSubpage === "node-catalog") {
								showAutomationsList();
								return;
							}
							setSelectedItemId(null);
							setSelectedItemKind(null);
							setEditorOpen(false);
							setEditingId(null);
							ctx.setEditingTaskId(null);
						},
						children: "← Back"
					}) : null,
					missingCredentials && missingCredentials.length > 0 && (0, import_jsx_runtime.jsx)(PagePanel, {
						variant: "padded",
						className: "mb-4 border border-warn/40 bg-warn-subtle",
						children: (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-start justify-between gap-3",
							children: [(0, import_jsx_runtime.jsxs)("div", {
								className: "space-y-1",
								children: [
									(0, import_jsx_runtime.jsxs)("p", {
										className: "text-sm font-semibold text-warn",
										children: [
											"Workflow needs ",
											missingCredentials.length,
											" credential",
											missingCredentials.length === 1 ? "" : "s"
										]
									}),
									(0, import_jsx_runtime.jsxs)("p", {
										className: "text-xs text-muted",
										children: [
											"Connect",
											" ",
											missingCredentials.map((cred) => prettyCredName(cred.credType)).join(", "),
											" ",
											"to activate this workflow."
										]
									}),
									(0, import_jsx_runtime.jsx)("div", {
										className: "mt-2 flex flex-wrap gap-2",
										children: missingCredentials.map((cred) => (0, import_jsx_runtime.jsxs)(Button, {
											size: "sm",
											variant: "outline",
											onClick: () => {
												setTab("connectors");
												dispatchFocusConnector(providerFromCredType(cred.credType));
												setMissingCredentials(null);
											},
											children: [
												"Connect ",
												prettyCredName(cred.credType),
												" →"
											]
										}, cred.credType))
									})
								]
							}), (0, import_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								className: "text-muted hover:text-txt",
								onClick: () => setMissingCredentials(null),
								children: "Dismiss"
							})]
						})
					}),
					clarification ? (0, import_jsx_runtime.jsx)(ClarificationPanel, {
						state: clarification,
						onChoose: resolveClarificationChoice,
						onDismiss: dismissClarification
					}) : null,
					(pageNotice || combinedError) && (0, import_jsx_runtime.jsx)(PagePanel, {
						variant: "padded",
						className: "mb-4 border border-danger/20 bg-danger/5",
						children: (0, import_jsx_runtime.jsxs)("div", {
							className: "flex items-center justify-between gap-3",
							children: [(0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-danger",
								children: pageNotice ?? combinedError
							}), pageNotice && (0, import_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								size: "sm",
								className: "text-danger hover:bg-danger/10",
								onClick: () => setPageNotice(null),
								children: "Dismiss"
							})]
						})
					}),
					editorOpen || editingId || editingTaskId ? editorMode === "task" || editingTaskId ? (0, import_jsx_runtime.jsx)(TaskForm, {}) : (0, import_jsx_runtime.jsx)(HeartbeatForm, {
						form,
						editingId,
						editorEnabled,
						modalTitle,
						formError,
						triggersSaving,
						templateNotice,
						triggers,
						triggerRunsById,
						t,
						selectedTriggerId: editingId,
						setField,
						setForm,
						setFormError,
						closeEditor,
						onSubmit: onSubmitTrigger,
						onDelete: onDeleteTrigger,
						onRunSelectedTrigger,
						onToggleTriggerEnabled,
						saveFormAsTemplate,
						loadTriggerRuns,
						kickerLabelCreate: form.kind === "workflow" ? "New schedule" : "New task",
						kickerLabelEdit: form.kind === "workflow" ? "Edit schedule" : "Edit task",
						submitLabelCreate: form.kind === "workflow" ? "Create schedule" : "Create task",
						submitLabelEdit: form.kind === "workflow" ? "Save schedule" : "Save task"
					}) : activeSubpage === "node-catalog" ? (0, import_jsx_runtime.jsx)(AutomationNodeCatalogPane, { nodes: automationNodes }) : showDashboard ? (0, import_jsx_runtime.jsx)(HeroEmptyState, {
						ideas: AUTOMATION_DRAFT_EXAMPLES,
						onSubmit: (text) => void createWorkflowDraft({ initialPrompt: text }),
						drafts: ctx.allItems.filter((item) => item.isDraft).slice(0, 4),
						onSelectDraft: selectItem,
						onDeleteDraft: handleDeleteDraft,
						t
					}) : resolvedSelectedItem?.type === "automation_draft" ? (0, import_jsx_runtime.jsx)(AutomationDraftPane, {
						automation: resolvedSelectedItem,
						onSeedPrompt: (prompt) => prefillPageChat(prompt, { select: true }),
						onDeleteDraft: handleDeleteDraft,
						isGenerating: workflowOpsBusy
					}) : resolvedSelectedItem?.type === "n8n_workflow" ? (0, import_jsx_runtime.jsx)(WorkflowAutomationDetailPane, {
						automation: resolvedSelectedItem,
						n8nStatus,
						workflowFetchError,
						workflowBusyId,
						workflowOpsBusy,
						onDeleteDraft: handleDeleteDraft,
						onDeleteWorkflow: handleDeleteWorkflow,
						onDuplicateWorkflow: handleDuplicateWorkflow,
						onGenerateWorkflow: handleGenerateWorkflow,
						onRefreshWorkflows: handleRefreshWorkflows,
						onScheduleWorkflow: handleScheduleWorkflow,
						onStartLocalN8n: handleStartLocalN8n,
						onToggleWorkflowActive: handleToggleWorkflowActive
					}) : resolvedSelectedItem?.trigger ? (0, import_jsx_runtime.jsx)(TriggerAutomationDetailPane, {
						automation: resolvedSelectedItem,
						onPromoteToWorkflow: promoteAutomationToWorkflow
					}) : resolvedSelectedItem?.task ? (0, import_jsx_runtime.jsx)(TaskAutomationDetailPane, {
						automation: resolvedSelectedItem,
						onPromoteToWorkflow: promoteAutomationToWorkflow
					}) : showFirstRunEmptyState ? (0, import_jsx_runtime.jsx)(AutomationsZeroState, {
						onBrowseTemplates: () => setTemplatesModalOpen(true),
						onNewTrigger: handleZeroStateNewTrigger,
						onNewTask: handleZeroStateNewTask
					}) : (0, import_jsx_runtime.jsx)("div", {
						className: "flex min-h-0 flex-1 items-center justify-center px-8 py-10 text-center",
						children: (0, import_jsx_runtime.jsx)("div", {
							className: "space-y-3",
							children: (0, import_jsx_runtime.jsx)("h3", {
								className: "text-lg font-semibold text-txt-strong",
								children: "Select a task or workflow"
							})
						})
					})
				]
			}),
			(0, import_jsx_runtime.jsx)(CreateAutomationDialog, {
				open: createDialogMode !== null,
				onOpenChange: (open) => {
					if (!open) setCreateDialogMode(null);
				},
				onCreateTask: () => {
					setCreateDialogMode(null);
					handleZeroStateNewTask();
				},
				onCreateWorkflow: () => {
					setCreateDialogMode(null);
					createWorkflowDraft();
				},
				onDescribeAutomation: handleDescribeAutomation
			}),
			(0, import_jsx_runtime.jsx)(WorkflowTemplatesModal, {
				open: templatesModalOpen,
				onOpenChange: setTemplatesModalOpen,
				onSelectTemplate: (seedPrompt) => void handleTemplateSelected(seedPrompt),
				onSelectCustom: () => {
					setTemplatesModalOpen(false);
					createWorkflowDraft();
				}
			})
		]
	});
}
function AutomationsView() {
	const controller = useAutomationsViewController();
	return (0, import_jsx_runtime.jsx)(AutomationsViewContext.Provider, {
		value: controller,
		children: (0, import_jsx_runtime.jsx)(AutomationsLayout, {})
	});
}
function AutomationsDesktopShell() {
	const controller = useAutomationsViewController();
	const hasScopedItem = controller.resolvedSelectedItem != null;
	const [userCollapsedWhenSelected, setUserCollapsedWhenSelected] = useState(false);
	useEffect(() => {
		if (!hasScopedItem) setUserCollapsedWhenSelected(false);
	}, [hasScopedItem]);
	const chatCollapsed = hasScopedItem ? userCollapsedWhenSelected : true;
	const handleToggleChat = useCallback((next) => {
		if (hasScopedItem) setUserCollapsedWhenSelected(next);
	}, [hasScopedItem]);
	return (0, import_jsx_runtime.jsx)(AutomationsViewContext.Provider, {
		value: controller,
		children: (0, import_jsx_runtime.jsx)(AppWorkspaceChrome, {
			testId: "automations-workspace",
			chat: (0, import_jsx_runtime.jsx)(AutomationsSidebarChat, { activeItem: controller.resolvedSelectedItem }),
			chatCollapsed,
			onToggleChat: handleToggleChat,
			hideCollapseButton: !hasScopedItem,
			main: (0, import_jsx_runtime.jsx)("div", {
				className: "flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden",
				children: (0, import_jsx_runtime.jsx)(AutomationsLayout, {})
			})
		})
	});
}

//#endregion
export { toneForLastStatus as _, BUILT_IN_TEMPLATES as a, isMissingCredentialsResponse as b, emptyForm as c, getTemplateName as d, loadUserTemplates as f, scheduleLabel as g, saveUserTemplates as h, HeartbeatForm as i, formFromTrigger as l, railMonogram as m, AutomationsView as n, buildCreateRequest as o, localizedExecutionStatus as p, AutomationsView_exports as r, buildUpdateRequest as s, AutomationsDesktopShell as t, getTemplateInstructions as u, validateForm as v, isNeedsClarificationResponse as x, WidgetHost as y };