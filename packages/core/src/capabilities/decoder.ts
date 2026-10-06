/** Capability boundary validation; imported directly by internal consumers. */

import type { JsonObject, JsonValue } from "../types/primitives";
import type {
	PageLayoutManifest,
	SurfaceCapability,
} from "../types/surface-manifest";
import {
	type CapabilityEndpointSelection,
	CapabilityError,
	type FileListParams,
	type FileStat,
	type GitOperation,
	type PluginGetProviderResult,
	type PluginInvokeActionResult,
	type PluginResponseHandlerFieldEvaluatorHandleResult,
	type RemotePluginActionManifest,
	type RemotePluginAppBridgeHook,
	type RemotePluginAppBridgeManifest,
	type RemotePluginAppManifest,
	type RemotePluginAppNavTabManifest,
	type RemotePluginAppSessionManifest,
	type RemotePluginAppViewerManifest,
	type RemotePluginComponentTypeManifest,
	type RemotePluginConfigMap,
	type RemotePluginEvaluatorManifest,
	type RemotePluginEventManifest,
	type RemotePluginJsonSchemaDefinition,
	type RemotePluginLifecycleHook,
	type RemotePluginLifecycleManifest,
	type RemotePluginModelManifest,
	type RemotePluginModuleManifest,
	type RemotePluginModuleProvenance,
	type RemotePluginProviderManifest,
	type RemotePluginResponseHandlerEvaluatorManifest,
	type RemotePluginResponseHandlerFieldEvaluatorManifest,
	type RemotePluginRouteManifest,
	type RemotePluginServiceManifest,
	type RemotePluginSurfaceManifest,
	type RemotePluginViewManifest,
	type RemotePluginWidgetManifest,
} from "./protocol.js";

export function endpointSelection(
	params: CapabilityEndpointSelection,
): JsonObject {
	if (params.endpointId === undefined) return {};
	validateRemotePluginCallTarget(
		params.endpointId,
		"endpointId",
		"capability.endpoint",
	);
	validateControlSafeString(
		params.endpointId,
		"endpointId",
		"capability.endpoint",
	);
	return { endpointId: params.endpointId };
}

export function requireObject(
	value: JsonValue | undefined,
	method: string,
): JsonObject {
	if (isJsonObject(value)) return value;
	throw decodeError(method, "Expected object response.");
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(
	object: JsonObject,
	key: string,
	method: string,
): string {
	const value = object[key];
	if (typeof value === "string") return value;
	throw decodeError(method, `${key} must be a string.`);
}

export function requireNonEmptyString(
	object: JsonObject,
	key: string,
	method: string,
): string {
	const value = requireString(object, key, method);
	if (value.trim().length > 0) return value;
	throw decodeError(method, `${key} must be a non-empty string.`);
}

function requireRemotePluginModuleId(
	object: JsonObject,
	key: string,
	method: string,
): string {
	const value = requireNonEmptyString(object, key, method);
	validateRemotePluginModuleId(value, key, method);
	return value;
}

export function optionalString(
	object: JsonObject,
	key: string,
	method: string,
): string | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	throw decodeError(method, `${key} must be a string when present.`);
}

function optionalNonEmptyString(
	object: JsonObject,
	key: string,
	method: string,
): string | undefined {
	const value = optionalString(object, key, method);
	if (value === undefined) return undefined;
	if (value.trim().length > 0) return value;
	throw decodeError(method, `${key} must be a non-empty string when present.`);
}

export function optionalJsonObject(
	object: JsonObject,
	key: string,
	method: string,
): JsonObject | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (isJsonObject(value)) return value;
	throw decodeError(method, `${key} must be an object when present.`);
}

function optionalRemotePluginConfig(
	object: JsonObject,
	key: string,
	method: string,
): RemotePluginConfigMap | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) {
		throw decodeError(method, `${key} must be an object when present.`);
	}
	const config: RemotePluginConfigMap = {};
	for (const [configKey, configValue] of Object.entries(value)) {
		if (
			typeof configValue === "string" ||
			(typeof configValue === "number" && Number.isFinite(configValue)) ||
			typeof configValue === "boolean" ||
			configValue === null
		) {
			config[configKey] = configValue;
			continue;
		}
		throw decodeError(
			method,
			`${key}.${configKey} must be a string, number, boolean, or null.`,
		);
	}
	return config;
}

function requireJsonObject(
	object: JsonObject,
	key: string,
	method: string,
): JsonObject {
	const value = object[key];
	if (isJsonObject(value)) return value;
	throw decodeError(method, `${key} must be an object.`);
}

export function optionalNumber(
	object: JsonObject,
	key: string,
	method: string,
): number | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw decodeError(method, `${key} must be a finite number when present.`);
}

export function requireNumber(
	object: JsonObject,
	key: string,
	method: string,
): number {
	const value = object[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw decodeError(method, `${key} must be a finite number.`);
}

export function requireObjectArray(
	object: JsonObject,
	key: string,
	method: string,
): JsonObject[] {
	const value = object[key];
	if (
		Array.isArray(value) &&
		value.every((entry): entry is JsonObject => isJsonObject(entry))
	) {
		return value;
	}
	throw decodeError(method, `${key} must be an object array.`);
}

export function requireFileStatArray(
	object: JsonObject,
	key: string,
	method: string,
): FileStat[] {
	const value = object[key];
	if (!Array.isArray(value)) {
		throw decodeError(method, `${key} must be an array.`);
	}
	return value.map((entry) => requireFileStat(entry, `${method}.${key}`));
}

function requireFileStat(value: JsonValue, method: string): FileStat {
	const object = requireObject(value, method);
	const kind = requireString(object, "kind", method);
	if (
		kind !== "file" &&
		kind !== "directory" &&
		kind !== "symlink" &&
		kind !== "other"
	) {
		throw decodeError(method, "kind must be a valid file entry kind.");
	}
	const modifiedAt = optionalString(object, "modifiedAt", method);
	const isText = optionalBoolean(object, "isText", method);
	return {
		path: requireString(object, "path", method),
		name: requireString(object, "name", method),
		kind,
		size: requireNumber(object, "size", method),
		...(modifiedAt === undefined ? {} : { modifiedAt }),
		...(isText === undefined ? {} : { isText }),
	};
}

function requireStringArray(
	object: JsonObject,
	key: string,
	method: string,
): string[] {
	const value = object[key];
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	) {
		return value;
	}
	throw decodeError(method, `${key} must be a string array.`);
}

function optionalStringArray(
	object: JsonObject,
	key: string,
	method: string,
): string[] | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	) {
		return value;
	}
	throw decodeError(method, `${key} must be a string array when present.`);
}

export function optionalStringRecord(
	object: JsonObject,
	key: string,
	method: string,
): Record<string, string> | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (
		isJsonObject(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	) {
		return value as Record<string, string>;
	}
	throw decodeError(method, `${key} must be a string record when present.`);
}

export function nullableNumber(
	object: JsonObject,
	key: string,
	method: string,
): number | null {
	const value = object[key];
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw decodeError(method, `${key} must be a finite number or null.`);
}

function optionalNullableNumber(
	object: JsonObject,
	key: string,
	method: string,
): number | null | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw decodeError(
		method,
		`${key} must be a finite number or null when present.`,
	);
}

function optionalNullableString(
	object: JsonObject,
	key: string,
	method: string,
): string | null | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value === "string") return value;
	throw decodeError(method, `${key} must be a string or null when present.`);
}

export function requireBoolean(
	object: JsonObject,
	key: string,
	method: string,
): boolean {
	const value = object[key];
	if (typeof value === "boolean") return value;
	throw decodeError(method, `${key} must be a boolean.`);
}

export function optionalBoolean(
	object: JsonObject,
	key: string,
	method: string,
): boolean | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	throw decodeError(method, `${key} must be a boolean when present.`);
}

function optionalSurfaceManifest(
	object: JsonObject,
	key: string,
	method: string,
): RemotePluginSurfaceManifest | undefined {
	const value = optionalJsonObject(object, key, method);
	if (value === undefined) return undefined;

	const background = optionalString(value, "background", `${method}.${key}`);
	if (
		background !== undefined &&
		background !== "opaque" &&
		background !== "shared"
	) {
		throw decodeError(
			method,
			`${key}.background must be "opaque" or "shared".`,
		);
	}

	const header = optionalString(value, "header", `${method}.${key}`);
	if (
		header !== undefined &&
		header !== "normal" &&
		header !== "fullscreen" &&
		header !== "modal" &&
		header !== "immersive"
	) {
		throw decodeError(
			method,
			`${key}.header must be "normal", "fullscreen", "modal", or "immersive".`,
		);
	}

	const isolation = optionalString(value, "isolation", `${method}.${key}`);
	if (
		isolation !== undefined &&
		isolation !== "in-process" &&
		isolation !== "sandboxed-iframe" &&
		isolation !== "native-webview" &&
		isolation !== "immersive"
	) {
		throw decodeError(method, `${key}.isolation is not supported.`);
	}

	const lifecycle = optionalString(value, "lifecycle", `${method}.${key}`);
	if (
		lifecycle !== undefined &&
		lifecycle !== "ephemeral" &&
		lifecycle !== "retained"
	) {
		throw decodeError(
			method,
			`${key}.lifecycle must be "ephemeral" or "retained".`,
		);
	}

	const capabilities = optionalSurfaceCapabilities(
		value,
		"capabilities",
		`${method}.${key}`,
	);
	const layout = optionalPageLayoutManifest(
		value,
		"layout",
		`${method}.${key}`,
	);

	return {
		...(background === undefined ? {} : { background }),
		...(header === undefined ? {} : { header }),
		...(isolation === undefined ? {} : { isolation }),
		...(lifecycle === undefined ? {} : { lifecycle }),
		...(capabilities === undefined ? {} : { capabilities }),
		...(layout === undefined ? {} : { layout }),
	};
}

function optionalPageLayoutManifest(
	object: JsonObject,
	key: string,
	method: string,
): PageLayoutManifest | undefined {
	const value = optionalJsonObject(object, key, method);
	if (value === undefined) return undefined;
	const kind = requireString(value, "kind", `${method}.${key}`);
	const width = requireString(value, "width", `${method}.${key}`);
	const scroll = requireString(value, "scroll", `${method}.${key}`);
	const topology = optionalString(value, "topology", `${method}.${key}`);
	const gutter = optionalString(value, "gutter", `${method}.${key}`);
	if (
		topology !== undefined &&
		topology !== "framed" &&
		topology !== "ambient"
	) {
		throw decodeError(method, `${key}.topology must be "framed" or "ambient".`);
	}
	if (gutter !== undefined && gutter !== "standard" && gutter !== "none") {
		throw decodeError(method, `${key}.gutter must be "standard" or "none".`);
	}
	if (
		kind === "content" &&
		["reading", "standard", "wide"].includes(width) &&
		(scroll === "shell" || scroll === "view")
	) {
		return {
			kind,
			...(topology === undefined ? {} : { topology }),
			width: width as "reading" | "standard" | "wide",
			scroll,
			...(gutter === undefined ? {} : { gutter }),
		};
	}
	if (
		kind === "workspace" &&
		["wide", "full"].includes(width) &&
		scroll === "view"
	) {
		return {
			kind,
			...(topology === undefined ? {} : { topology }),
			width: width as "wide" | "full",
			scroll,
			...(gutter === undefined ? {} : { gutter }),
		};
	}
	if (
		kind === "immersive" &&
		width === "full" &&
		scroll === "view" &&
		gutter === "none"
	) {
		return {
			kind,
			...(topology === undefined ? {} : { topology }),
			width,
			scroll,
			gutter,
		};
	}
	throw decodeError(method, `${key} is not a valid page layout manifest.`);
}

function optionalSurfaceCapabilities(
	object: JsonObject,
	key: string,
	method: string,
): SurfaceCapability[] | undefined {
	const values = optionalStringArray(object, key, method);
	if (values === undefined) return undefined;
	const allowed = new Set<SurfaceCapability>([
		"wallpaper",
		"background:apply",
		"navigate",
		"storage",
		"agent-surface",
	]);
	const capabilities: SurfaceCapability[] = [];
	for (const value of values) {
		if (!allowed.has(value as SurfaceCapability)) {
			throw decodeError(method, `${key} contains unsupported capability.`);
		}
		capabilities.push(value as SurfaceCapability);
	}
	return capabilities;
}

export function requireResponseHandlerFieldEffect(
	value: JsonValue,
	method: string,
): NonNullable<PluginResponseHandlerFieldEvaluatorHandleResult["effect"]> {
	const object = requireObject(value, method);
	const patch = optionalJsonObject(object, "patch", method);
	const preempt =
		object.preempt === undefined
			? undefined
			: requireResponseHandlerFieldPreempt(object.preempt, `${method}.preempt`);
	const debug = optionalStringArray(object, "debug", method);
	return {
		...(patch === undefined ? {} : { patch }),
		...(preempt === undefined ? {} : { preempt }),
		...(debug === undefined ? {} : { debug }),
	};
}

function requireResponseHandlerFieldPreempt(
	value: JsonValue,
	method: string,
): NonNullable<
	NonNullable<
		PluginResponseHandlerFieldEvaluatorHandleResult["effect"]
	>["preempt"]
> {
	const object = requireObject(value, method);
	const mode = requireString(object, "mode", method);
	if (mode !== "ack-and-stop" && mode !== "ignore" && mode !== "direct-reply") {
		throw decodeError(method, "preempt.mode is not supported.");
	}
	return {
		mode,
		reason: requireString(object, "reason", method),
	};
}

export function requireGitOperation(
	value: JsonValue | undefined,
	method: string,
): GitOperation {
	const object = requireObject(value, method);
	const status = requireString(object, "status", method);
	if (status !== "running" && status !== "completed" && status !== "failed") {
		throw decodeError(method, "status must be a valid Git operation status.");
	}
	const exitCode = optionalNullableNumber(object, "exitCode", method);
	const signal = optionalNullableString(object, "signal", method);
	const completedAt = optionalString(object, "completedAt", method);
	const error = optionalString(object, "error", method);
	return {
		id: requireString(object, "id", method),
		name: requireString(object, "name", method),
		cwd: requireString(object, "cwd", method),
		command: requireStringArray(object, "command", method),
		status,
		stdout: requireString(object, "stdout", method),
		stderr: requireString(object, "stderr", method),
		...(exitCode === undefined ? {} : { exitCode }),
		...(signal === undefined ? {} : { signal }),
		startedAt: requireString(object, "startedAt", method),
		...(completedAt === undefined ? {} : { completedAt }),
		...(error === undefined ? {} : { error }),
	};
}

export function requireRemotePluginModuleArray(
	object: JsonObject,
	key: string,
	method: string,
): RemotePluginModuleManifest[] {
	const value = object[key];
	if (!Array.isArray(value))
		throw decodeError(method, `${key} must be an array.`);
	return value.map((entry) =>
		requireRemotePluginModule(entry, `${method}.${key}`),
	);
}

function requireRemotePluginModule(
	value: JsonValue,
	method: string,
): RemotePluginModuleManifest {
	const object = requireObject(value, method);
	const capabilityEndpointId = optionalString(
		object,
		"capabilityEndpointId",
		method,
	);
	const version = optionalString(object, "version", method);
	const description = optionalString(object, "description", method);
	const priority = optionalNumber(object, "priority", method);
	const contexts = optionalStringArray(object, "contexts", method);
	const config = optionalRemotePluginConfig(object, "config", method);
	const schema = optionalJsonObject(object, "schema", method);
	const actions = optionalArray(
		object,
		"actions",
		method,
		requireRemotePluginAction,
	);
	const providers = optionalArray(
		object,
		"providers",
		method,
		requireRemotePluginProvider,
	);
	const evaluators = optionalArray(
		object,
		"evaluators",
		method,
		requireRemotePluginEvaluator,
	);
	const responseHandlerEvaluators = optionalArray(
		object,
		"responseHandlerEvaluators",
		method,
		requireRemotePluginResponseHandlerEvaluator,
	);
	const responseHandlerFieldEvaluators = optionalArray(
		object,
		"responseHandlerFieldEvaluators",
		method,
		requireRemotePluginResponseHandlerFieldEvaluator,
	);
	const events = optionalArray(
		object,
		"events",
		method,
		requireRemotePluginEvent,
	);
	const models = optionalArray(
		object,
		"models",
		method,
		requireRemotePluginModel,
	);
	const services = optionalArray(
		object,
		"services",
		method,
		requireRemotePluginService,
	);
	const componentTypes = optionalArray(
		object,
		"componentTypes",
		method,
		requireRemotePluginComponentType,
	);
	const widgets = optionalArray(
		object,
		"widgets",
		method,
		requireRemotePluginWidget,
	);
	const app =
		object.app === undefined
			? undefined
			: requireRemotePluginApp(object.app, `${method}.app`);
	const appBridge =
		object.appBridge === undefined
			? undefined
			: requireRemotePluginAppBridge(object.appBridge, `${method}.appBridge`);
	const lifecycle =
		object.lifecycle === undefined
			? undefined
			: requireRemotePluginLifecycle(object.lifecycle, `${method}.lifecycle`);
	const routes = optionalArray(
		object,
		"routes",
		method,
		requireRemotePluginRoute,
	);
	const views = optionalArray(object, "views", method, requireRemotePluginView);
	const provenance =
		object.provenance === undefined
			? undefined
			: requireRemotePluginModuleProvenance(
					object.provenance,
					`${method}.provenance`,
				);
	const metadata = optionalJsonObject(object, "metadata", method);
	return {
		id: requireRemotePluginModuleId(object, "id", method),
		name: requireNonEmptyString(object, "name", method),
		...(capabilityEndpointId === undefined ? {} : { capabilityEndpointId }),
		...(version === undefined ? {} : { version }),
		...(description === undefined ? {} : { description }),
		...(priority === undefined ? {} : { priority }),
		...(contexts === undefined ? {} : { contexts }),
		...(config === undefined ? {} : { config }),
		...(schema === undefined ? {} : { schema }),
		...(actions === undefined ? {} : { actions }),
		...(providers === undefined ? {} : { providers }),
		...(evaluators === undefined ? {} : { evaluators }),
		...(responseHandlerEvaluators === undefined
			? {}
			: { responseHandlerEvaluators }),
		...(responseHandlerFieldEvaluators === undefined
			? {}
			: { responseHandlerFieldEvaluators }),
		...(events === undefined ? {} : { events }),
		...(models === undefined ? {} : { models }),
		...(services === undefined ? {} : { services }),
		...(componentTypes === undefined ? {} : { componentTypes }),
		...(widgets === undefined ? {} : { widgets }),
		...(app === undefined ? {} : { app }),
		...(appBridge === undefined ? {} : { appBridge }),
		...(lifecycle === undefined ? {} : { lifecycle }),
		...(routes === undefined ? {} : { routes }),
		...(views === undefined ? {} : { views }),
		...(provenance === undefined ? {} : { provenance }),
		...(metadata === undefined ? {} : { metadata }),
	};
}

function requireRemotePluginModuleProvenance(
	value: JsonValue,
	method: string,
): RemotePluginModuleProvenance {
	const object = requireObject(value, method);
	const digestSha256 = requireNonEmptyString(object, "digestSha256", method);
	if (!/^[0-9a-f]{64}$/i.test(digestSha256)) {
		throw decodeError(method, "digestSha256 must be a SHA-256 hex digest.");
	}
	return {
		issuer: requireNonEmptyString(object, "issuer", method),
		subject: requireNonEmptyString(object, "subject", method),
		digestSha256: digestSha256.toLowerCase(),
		signatureAlgorithm: requireNonEmptyString(
			object,
			"signatureAlgorithm",
			method,
		),
		signature: requireNonEmptyString(object, "signature", method),
	};
}

function optionalArray<T>(
	object: JsonObject,
	key: string,
	method: string,
	decode: (value: JsonValue, method: string) => T,
): T[] | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw decodeError(method, `${key} must be an array when present.`);
	}
	return value.map((entry) => decode(entry, `${method}.${key}`));
}

function requireRemotePluginAction(
	value: JsonValue,
	method: string,
): RemotePluginActionManifest {
	const object = requireObject(value, method);
	const descriptionCompressed = optionalString(
		object,
		"descriptionCompressed",
		method,
	);
	const similes = optionalStringArray(object, "similes", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		description: requireNonEmptyString(object, "description", method),
		...(descriptionCompressed === undefined ? {} : { descriptionCompressed }),
		...(similes === undefined ? {} : { similes }),
		...(object.parameters === undefined
			? {}
			: { parameters: object.parameters }),
	};
}

function requireRemotePluginProvider(
	value: JsonValue,
	method: string,
): RemotePluginProviderManifest {
	const object = requireObject(value, method);
	const description = optionalString(object, "description", method);
	const descriptionCompressed = optionalString(
		object,
		"descriptionCompressed",
		method,
	);
	const dynamic = optionalBoolean(object, "dynamic", method);
	const isPrivate = optionalBoolean(object, "private", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		...(description === undefined ? {} : { description }),
		...(descriptionCompressed === undefined ? {} : { descriptionCompressed }),
		...(dynamic === undefined ? {} : { dynamic }),
		...(isPrivate === undefined ? {} : { private: isPrivate }),
	};
}

function requireRemotePluginEvaluator(
	value: JsonValue,
	method: string,
): RemotePluginEvaluatorManifest {
	const object = requireObject(value, method);
	const similes = optionalStringArray(object, "similes", method);
	const priority = optionalNumber(object, "priority", method);
	const providers = optionalStringArray(object, "providers", method);
	const modelType = optionalString(object, "modelType", method);
	const hasPrepare = optionalBoolean(object, "hasPrepare", method);
	const hasProcessor = optionalBoolean(object, "hasProcessor", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		description: requireNonEmptyString(object, "description", method),
		prompt: requireNonEmptyString(object, "prompt", method),
		...(similes === undefined ? {} : { similes }),
		...(priority === undefined ? {} : { priority }),
		...(providers === undefined ? {} : { providers }),
		schema: requireJsonObject(object, "schema", method),
		...(modelType === undefined ? {} : { modelType }),
		...(hasPrepare === undefined ? {} : { hasPrepare }),
		...(hasProcessor === undefined ? {} : { hasProcessor }),
	};
}

function requireRemotePluginResponseHandlerEvaluator(
	value: JsonValue,
	method: string,
): RemotePluginResponseHandlerEvaluatorManifest {
	const object = requireObject(value, method);
	const description = optionalString(object, "description", method);
	const priority = optionalNumber(object, "priority", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		...(description === undefined ? {} : { description }),
		...(priority === undefined ? {} : { priority }),
	};
}

function requireRemotePluginResponseHandlerFieldEvaluator(
	value: JsonValue,
	method: string,
): RemotePluginResponseHandlerFieldEvaluatorManifest {
	const object = requireObject(value, method);
	const priority = optionalNumber(object, "priority", method);
	const hasParse = optionalBoolean(object, "hasParse", method);
	const hasHandle = optionalBoolean(object, "hasHandle", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		description: requireNonEmptyString(object, "description", method),
		schema: requireObject(object.schema, `${method}.schema`),
		...(priority === undefined ? {} : { priority }),
		...(hasParse === undefined ? {} : { hasParse }),
		...(hasHandle === undefined ? {} : { hasHandle }),
	};
}

function requireRemotePluginEvent(
	value: JsonValue,
	method: string,
): RemotePluginEventManifest {
	const object = requireObject(value, method);
	return {
		eventName: requireNonEmptyString(object, "eventName", method),
	};
}

function requireRemotePluginModel(
	value: JsonValue,
	method: string,
): RemotePluginModelManifest {
	const object = requireObject(value, method);
	const priority = optionalNumber(object, "priority", method);
	return {
		modelType: requireNonEmptyString(object, "modelType", method),
		...(priority === undefined ? {} : { priority }),
	};
}

function requireRemotePluginService(
	value: JsonValue,
	method: string,
): RemotePluginServiceManifest {
	const object = requireObject(value, method);
	const capabilityDescription = optionalString(
		object,
		"capabilityDescription",
		method,
	);
	const methods = optionalStringArray(object, "methods", method);
	validateRemotePluginServiceMethods(methods, method);
	const config = optionalJsonObject(object, "config", method);
	return {
		serviceType: requireNonEmptyString(object, "serviceType", method),
		...(capabilityDescription === undefined ? {} : { capabilityDescription }),
		...(methods === undefined ? {} : { methods }),
		...(config === undefined ? {} : { config }),
	};
}

function requireRemotePluginComponentType(
	value: JsonValue,
	method: string,
): RemotePluginComponentTypeManifest {
	const object = requireObject(value, method);
	return {
		name: requireNonEmptyString(object, "name", method),
		schema: requireRemotePluginJsonSchemaDefinition(
			object.schema,
			`${method}.schema`,
		),
	};
}

function requireRemotePluginJsonSchemaDefinition(
	value: JsonValue,
	method: string,
): RemotePluginJsonSchemaDefinition {
	const object = requireObject(value, method);
	const propertiesValue = object.properties;
	const properties =
		propertiesValue === undefined
			? undefined
			: requireRemotePluginJsonSchemaProperties(propertiesValue, method);
	const items =
		object.items === undefined
			? undefined
			: requireRemotePluginJsonSchemaDefinition(
					object.items,
					`${method}.items`,
				);
	const required = optionalStringArray(object, "required", method);
	const enumValues = optionalStringArray(object, "enumValues", method);
	const description = optionalString(object, "description", method);
	return {
		type: requireNonEmptyString(object, "type", method),
		...(properties === undefined ? {} : { properties }),
		...(items === undefined ? {} : { items }),
		...(required === undefined ? {} : { required }),
		...(enumValues === undefined ? {} : { enumValues }),
		...(description === undefined ? {} : { description }),
	};
}

function requireRemotePluginJsonSchemaProperties(
	value: JsonValue,
	method: string,
): Record<string, RemotePluginJsonSchemaDefinition> {
	const object = requireObject(value, `${method}.properties`);
	const properties: Record<string, RemotePluginJsonSchemaDefinition> = {};
	for (const [key, property] of Object.entries(object)) {
		properties[key] = requireRemotePluginJsonSchemaDefinition(
			property,
			`${method}.properties.${key}`,
		);
	}
	return properties;
}

const REMOTE_SERVICE_RESERVED_METHODS = new Set([
	"callRemote",
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"toString",
	"valueOf",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"__proto__",
]);

export function validateRemotePluginServiceMethods(
	methods: string[] | undefined,
	method: string,
): void {
	if (methods === undefined) return;
	const seen = new Set<string>();
	for (const serviceMethod of methods) {
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(serviceMethod)) {
			throw decodeError(
				method,
				"methods must contain valid JavaScript method identifiers.",
			);
		}
		if (seen.has(serviceMethod)) {
			throw decodeError(
				method,
				"methods must not contain duplicate method names.",
			);
		}
		seen.add(serviceMethod);
		if (REMOTE_SERVICE_RESERVED_METHODS.has(serviceMethod)) {
			throw decodeError(
				method,
				"methods must not include reserved local service method names.",
			);
		}
	}
}

export function validateRemotePluginCallTarget(
	value: string,
	key: string,
	method: string,
): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw decodeError(method, `${key} must be a non-empty string.`);
	}
	if (key === "moduleId") {
		validateRemotePluginModuleId(value, key, method);
	}
}

function validateRemotePluginModuleId(
	value: string,
	key: string,
	method: string,
): void {
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		throw decodeError(
			method,
			`${key} must use letters, numbers, dots, underscores, or hyphens.`,
		);
	}
}

function optionalViewKind(
	object: Record<string, JsonValue>,
	method: string,
): import("../views/declarations.js").ViewKind | undefined {
	const value = optionalString(object, "viewKind", method);
	if (
		value === undefined ||
		value === "system" ||
		value === "release" ||
		value === "developer" ||
		value === "preview"
	)
		return value;
	throw decodeError(
		method,
		"viewKind must be system, release, developer, or preview.",
	);
}

function requireRemotePluginWidget(
	value: JsonValue,
	method: string,
): RemotePluginWidgetManifest {
	const object = requireObject(value, method);
	const slot = requireString(object, "slot", method);
	if (slot !== "chat-sidebar" && slot !== "character" && slot !== "nav-page") {
		throw decodeError(method, "slot must be a valid plugin widget slot.");
	}
	const pluginId = optionalNonEmptyString(object, "pluginId", method);
	const icon = optionalString(object, "icon", method);
	const order = optionalNumber(object, "order", method);
	const defaultEnabled = optionalBoolean(object, "defaultEnabled", method);
	const navGroup = optionalString(object, "navGroup", method);
	const viewKind = optionalViewKind(object, method);
	const componentExport = optionalString(object, "componentExport", method);
	return {
		id: requireNonEmptyString(object, "id", method),
		...(pluginId === undefined ? {} : { pluginId }),
		slot,
		label: requireNonEmptyString(object, "label", method),
		...(icon === undefined ? {} : { icon }),
		...(order === undefined ? {} : { order }),
		...(defaultEnabled === undefined ? {} : { defaultEnabled }),
		...(navGroup === undefined ? {} : { navGroup }),
		...(viewKind === undefined ? {} : { viewKind }),
		...(componentExport === undefined ? {} : { componentExport }),
	};
}

function requireRemotePluginApp(
	value: JsonValue,
	method: string,
): RemotePluginAppManifest {
	const object = requireObject(value, method);
	const displayName = optionalNonEmptyString(object, "displayName", method);
	const category = optionalString(object, "category", method);
	const launchType = optionalString(object, "launchType", method);
	const launchUrl = optionalNullableString(object, "launchUrl", method);
	if (typeof launchUrl === "string") {
		validateRemotePluginBrowserUrl(launchUrl, "launchUrl", method);
	}
	const icon = optionalNullableString(object, "icon", method);
	const capabilities = optionalStringArray(object, "capabilities", method);
	const minPlayers = optionalNullableNumber(object, "minPlayers", method);
	const maxPlayers = optionalNullableNumber(object, "maxPlayers", method);
	const runtimePlugin = optionalString(object, "runtimePlugin", method);
	const viewer =
		object.viewer === undefined
			? undefined
			: requireRemotePluginAppViewer(object.viewer, `${method}.viewer`);
	const session =
		object.session === undefined
			? undefined
			: requireRemotePluginAppSession(object.session, `${method}.session`);
	const bridgeExport = optionalString(object, "bridgeExport", method);
	const uiExtension =
		object.uiExtension === undefined
			? undefined
			: requireRemotePluginAppUiExtension(
					object.uiExtension,
					`${method}.uiExtension`,
				);
	const viewKind = optionalViewKind(object, method);
	const visibleInAppStore = optionalBoolean(
		object,
		"visibleInAppStore",
		method,
	);
	const navTabs = optionalArray(
		object,
		"navTabs",
		method,
		requireRemotePluginAppNavTab,
	);
	return {
		...(displayName === undefined ? {} : { displayName }),
		...(category === undefined ? {} : { category }),
		...(launchType === undefined ? {} : { launchType }),
		...(launchUrl === undefined ? {} : { launchUrl }),
		...(icon === undefined ? {} : { icon }),
		...(capabilities === undefined ? {} : { capabilities }),
		...(minPlayers === undefined ? {} : { minPlayers }),
		...(maxPlayers === undefined ? {} : { maxPlayers }),
		...(runtimePlugin === undefined ? {} : { runtimePlugin }),
		...(viewer === undefined ? {} : { viewer }),
		...(session === undefined ? {} : { session }),
		...(bridgeExport === undefined ? {} : { bridgeExport }),
		...(uiExtension === undefined ? {} : { uiExtension }),
		...(viewKind === undefined ? {} : { viewKind }),
		...(visibleInAppStore === undefined ? {} : { visibleInAppStore }),
		...(navTabs === undefined ? {} : { navTabs }),
	};
}

function requireRemotePluginAppViewer(
	value: JsonValue,
	method: string,
): RemotePluginAppViewerManifest {
	const object = requireObject(value, method);
	const embedParams = optionalStringRecord(object, "embedParams", method);
	const postMessageAuth = optionalBoolean(object, "postMessageAuth", method);
	const sandbox = optionalString(object, "sandbox", method);
	const url = requireNonEmptyString(object, "url", method);
	validateRemotePluginBrowserUrl(url, "url", method);
	return {
		url,
		...(embedParams === undefined ? {} : { embedParams }),
		...(postMessageAuth === undefined ? {} : { postMessageAuth }),
		...(sandbox === undefined ? {} : { sandbox }),
	};
}

function validateRemotePluginBrowserUrl(
	value: string,
	key: string,
	method: string,
): void {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("invalid protocol");
		}
		if (parsed.username || parsed.password) {
			throw new Error("credentials are not allowed");
		}
	} catch {
		// error-policy:J3 Capability URLs are untrusted input and produce an
		// explicit decode error when invalid.
		throw decodeError(
			method,
			`${key} must be an absolute http(s) URL without embedded credentials.`,
		);
	}
}

function requireRemotePluginAppSession(
	value: JsonValue,
	method: string,
): RemotePluginAppSessionManifest {
	const object = requireObject(value, method);
	const mode = requireString(object, "mode", method);
	if (
		mode !== "viewer" &&
		mode !== "spectate-and-steer" &&
		mode !== "external"
	) {
		throw decodeError(method, "mode must be a valid plugin app session mode.");
	}
	const features = optionalStringArray(object, "features", method);
	if (
		features?.some(
			(feature) =>
				feature !== "commands" &&
				feature !== "telemetry" &&
				feature !== "pause" &&
				feature !== "resume" &&
				feature !== "suggestions",
		)
	) {
		throw decodeError(
			method,
			"features must be valid plugin app session features.",
		);
	}
	return {
		mode,
		...(features === undefined
			? {}
			: {
					features: features as RemotePluginAppSessionManifest["features"],
				}),
	};
}

function requireRemotePluginAppUiExtension(
	value: JsonValue,
	method: string,
): NonNullable<RemotePluginAppManifest["uiExtension"]> {
	const object = requireObject(value, method);
	const detailPanelId = optionalString(object, "detailPanelId", method);
	return {
		...(detailPanelId === undefined ? {} : { detailPanelId }),
	};
}

function requireRemotePluginAppNavTab(
	value: JsonValue,
	method: string,
): RemotePluginAppNavTabManifest {
	const object = requireObject(value, method);
	const icon = optionalString(object, "icon", method);
	const order = optionalNumber(object, "order", method);
	const viewKind = optionalViewKind(object, method);
	const group = optionalString(object, "group", method);
	const surface = optionalSurfaceManifest(object, "surface", method);
	const componentExport = optionalString(object, "componentExport", method);
	const path = requireNonEmptyString(object, "path", method);
	validateRemotePluginPath(path, "path", method);
	return {
		id: requireNonEmptyString(object, "id", method),
		label: requireNonEmptyString(object, "label", method),
		...(icon === undefined ? {} : { icon }),
		path,
		...(order === undefined ? {} : { order }),
		...(viewKind === undefined ? {} : { viewKind }),
		...(group === undefined ? {} : { group }),
		...(surface === undefined ? {} : { surface }),
		...(componentExport === undefined ? {} : { componentExport }),
	};
}

function requireRemotePluginAppBridge(
	value: JsonValue,
	method: string,
): RemotePluginAppBridgeManifest {
	const object = requireObject(value, method);
	const hooks = requireStringArray(object, "hooks", method);
	if (hooks.length === 0) {
		throw decodeError(method, "hooks must not be empty.");
	}
	if (hooks.some((hook) => !isRemotePluginAppBridgeHook(hook))) {
		throw decodeError(method, "hooks must be valid plugin app bridge hooks.");
	}
	return {
		hooks: hooks as RemotePluginAppBridgeHook[],
	};
}

export function isRemotePluginAppBridgeHook(
	value: string,
): value is RemotePluginAppBridgeHook {
	return (
		value === "prepareLaunch" ||
		value === "resolveViewerAuthMessage" ||
		value === "ensureRuntimeReady" ||
		value === "collectLaunchDiagnostics" ||
		value === "resolveLaunchSession" ||
		value === "refreshRunSession" ||
		value === "stopRun" ||
		value === "handleAppRoutes"
	);
}

function requireRemotePluginLifecycle(
	value: JsonValue,
	method: string,
): RemotePluginLifecycleManifest {
	const object = requireObject(value, method);
	const hooks = requireStringArray(object, "hooks", method);
	if (hooks.length === 0) {
		throw decodeError(method, "hooks must not be empty.");
	}
	if (hooks.some((hook) => !isRemotePluginLifecycleHook(hook))) {
		throw decodeError(method, "hooks must be valid plugin lifecycle hooks.");
	}
	return {
		hooks: hooks as RemotePluginLifecycleHook[],
	};
}

export function isRemotePluginLifecycleHook(
	value: string,
): value is RemotePluginLifecycleHook {
	return value === "init" || value === "dispose" || value === "applyConfig";
}

function requireRemotePluginRoute(
	value: JsonValue,
	method: string,
): RemotePluginRouteManifest {
	const object = requireObject(value, method);
	const routeMethod = requireString(object, "method", method);
	validateRemotePluginRouteMethod(routeMethod, "method", method, true);
	const name = optionalString(object, "name", method);
	const isPublic = optionalBoolean(object, "public", method);
	const publicReason = optionalString(object, "publicReason", method);
	const publicWrite = optionalString(object, "publicWrite", method);
	const description = optionalString(object, "description", method);
	const path = requireNonEmptyString(object, "path", method);
	validateRemotePluginPath(path, "path", method);
	if (isPublic === true && !publicReason?.trim()) {
		throw decodeError(
			method,
			"publicReason must be a non-empty string for public routes.",
		);
	}
	return {
		method: routeMethod,
		path,
		...(name === undefined ? {} : { name }),
		...(isPublic === undefined ? {} : { public: isPublic }),
		...(publicReason === undefined ? {} : { publicReason }),
		...(publicWrite === undefined ? {} : { publicWrite }),
		...(description === undefined ? {} : { description }),
	};
}

export function validateRemotePluginRouteMethod(
	value: string,
	key: string,
	method: string,
	allowStatic: boolean,
): asserts value is RemotePluginRouteManifest["method"] {
	if (
		value !== "GET" &&
		value !== "POST" &&
		value !== "PUT" &&
		value !== "PATCH" &&
		value !== "DELETE" &&
		(allowStatic ? value !== "STATIC" : true)
	) {
		throw decodeError(method, `${key} must be a valid plugin route method.`);
	}
}

export function validateRemotePluginPath(
	value: string,
	key: string,
	method: string,
): void {
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("?") ||
		value.includes("#") ||
		value.includes("\\") ||
		/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
	) {
		throw decodeError(
			method,
			`${key} must be an absolute app path without URL scheme, query, hash, or backslash.`,
		);
	}
	const segments = value === "/" ? [] : value.split("/").slice(1);
	if (
		segments.some((segment) => segment === "." || segment === ".." || !segment)
	) {
		throw decodeError(
			method,
			`${key} must not contain empty, current-directory, or parent-directory segments.`,
		);
	}
}

function requireRemotePluginView(
	value: JsonValue,
	method: string,
): RemotePluginViewManifest {
	const object = requireObject(value, method);
	const viewKind = optionalViewKind(object, method);
	const viewType = optionalString(object, "viewType", method);
	if (
		viewType !== undefined &&
		viewType !== "gui" &&
		viewType !== "tui" &&
		viewType !== "xr"
	) {
		throw decodeError(method, "viewType must be gui, tui, or xr when present.");
	}
	const bundlePath = optionalNonEmptyString(object, "bundlePath", method);
	const bundleUrl = optionalNonEmptyString(object, "bundleUrl", method);
	const framePath = optionalNonEmptyString(object, "framePath", method);
	const frameUrl = optionalNonEmptyString(object, "frameUrl", method);
	if (bundlePath !== undefined) {
		validateRemotePluginAssetPath(bundlePath, "bundlePath", method);
	}
	if (bundleUrl !== undefined) {
		validateRemotePluginBundleUrl(bundleUrl, "bundleUrl", method);
	}
	if (framePath !== undefined) {
		validateRemotePluginAssetPath(framePath, "framePath", method);
	}
	if (frameUrl !== undefined) {
		validateRemotePluginBundleUrl(frameUrl, "frameUrl", method);
	}
	const surface = optionalSurfaceManifest(object, "surface", method);
	const contentType = optionalString(object, "contentType", method);
	const integrity = optionalString(object, "integrity", method);
	return {
		id: requireNonEmptyString(object, "id", method),
		label: requireNonEmptyString(object, "label", method),
		...(viewType === undefined ? {} : { viewType }),
		...(viewKind === undefined ? {} : { viewKind }),
		...(surface === undefined ? {} : { surface }),
		...(bundlePath === undefined ? {} : { bundlePath }),
		...(bundleUrl === undefined ? {} : { bundleUrl }),
		...(framePath === undefined ? {} : { framePath }),
		...(frameUrl === undefined ? {} : { frameUrl }),
		...(contentType === undefined ? {} : { contentType }),
		...(integrity === undefined ? {} : { integrity }),
	};
}

function validateRemotePluginBundleUrl(
	value: string,
	key: string,
	method: string,
): void {
	if (value.startsWith("/")) {
		validateRemotePluginPath(value, key, method);
		return;
	}
	validateRemotePluginBrowserUrl(value, key, method);
}

export function validateRemotePluginAssetPath(
	value: string,
	key: string,
	method: string,
): void {
	const path = value.trim();
	if (
		!path ||
		path.includes("?") ||
		path.includes("#") ||
		path.includes("\\") ||
		path.startsWith("//") ||
		/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path)
	) {
		throw decodeError(
			method,
			`${key} must be an asset path without query, hash, URL scheme, or backslash.`,
		);
	}
	const segments = path.replace(/^\/+/, "").split("/");
	if (
		segments.length === 0 ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw decodeError(
			method,
			`${key} must not contain empty, current-directory, or parent-directory segments.`,
		);
	}
}

export function validateHeaderSafeString(
	value: string,
	key: string,
	method: string,
): void {
	if (!isControlSafeString(value)) {
		throw decodeError(method, `${key} must not contain control characters.`);
	}
}

function validateControlSafeString(
	value: string,
	key: string,
	method: string,
): void {
	if (!isControlSafeString(value)) {
		throw decodeError(method, `${key} must not contain control characters.`);
	}
}

function isControlSafeString(value: string): boolean {
	return !/[\r\n\0]/.test(value);
}

export function validateHeaderRecord(
	headers: Record<string, string>,
	key: string,
	method: string,
): void {
	for (const [headerName, headerValue] of Object.entries(headers)) {
		if (
			!headerName ||
			/[\r\n\0]/.test(headerName) ||
			!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)
		) {
			throw decodeError(method, `${key} must contain valid header names.`);
		}
		validateHeaderSafeString(headerValue, key, method);
	}
}

export function validateRouteQueryRecord(
	query: Record<string, string | string[]>,
	key: string,
	method: string,
): void {
	for (const [queryKey, queryValue] of Object.entries(query)) {
		if (!queryKey || !isControlSafeString(queryKey)) {
			throw decodeError(method, `${key} must contain valid query keys.`);
		}
		const values = Array.isArray(queryValue) ? queryValue : [queryValue];
		if (
			values.some(
				(value) => typeof value !== "string" || !isControlSafeString(value),
			)
		) {
			throw decodeError(method, `${key} must contain valid query values.`);
		}
	}
}

export function validateHttpStatusCode(
	value: number,
	key: string,
	method: string,
): void {
	if (!Number.isInteger(value) || value < 100 || value > 599) {
		throw decodeError(method, `${key} must be an integer HTTP status code.`);
	}
}

export function validateBase64String(
	value: string,
	key: string,
	method: string,
): void {
	if (
		value.length > 0 &&
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	) {
		throw decodeError(method, `${key} must be valid base64.`);
	}
}

export function requirePluginActionResult(
	value: JsonValue | undefined,
	method: string,
): PluginInvokeActionResult {
	const object = requireObject(value, method);
	const text = optionalString(object, "text", method);
	const actions = optionalStringArray(object, "actions", method);
	const values = optionalJsonObject(object, "values", method);
	const data = optionalJsonObject(object, "data", method);
	return {
		...(text === undefined ? {} : { text }),
		...(actions === undefined ? {} : { actions }),
		...(values === undefined ? {} : { values }),
		...(data === undefined ? {} : { data }),
	};
}

export function requirePluginProviderResult(
	value: JsonValue | undefined,
	method: string,
): PluginGetProviderResult {
	const object = requireObject(value, method);
	const text = optionalString(object, "text", method);
	const values = optionalJsonObject(object, "values", method);
	const data = optionalJsonObject(object, "data", method);
	return {
		...(text === undefined ? {} : { text }),
		...(values === undefined ? {} : { values }),
		...(data === undefined ? {} : { data }),
	};
}

export function decodeError(method: string, message: string): CapabilityError {
	return new CapabilityError({
		code: "CAPABILITY_DECODE_FAILED",
		message,
		method,
	});
}

export function paramsToDetails(
	params: FileListParams | undefined,
): JsonObject {
	if (!params) return {};
	return {
		...(params.path === undefined ? {} : { path: params.path }),
		...(params.rootId === undefined ? {} : { rootId: params.rootId }),
		...(params.limit === undefined ? {} : { limit: params.limit }),
		...(params.includeHidden === undefined
			? {}
			: { includeHidden: params.includeHidden }),
		...(params.ignore === undefined ? {} : { ignore: params.ignore }),
	};
}
