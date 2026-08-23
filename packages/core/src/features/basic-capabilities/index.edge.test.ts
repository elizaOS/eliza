/**
 * Deterministic unit coverage for the Workerd basic-capabilities composition.
 * The suite exercises the real exported registries and every configuration
 * branch without booting a runtime or replacing collaborators with mocks.
 */

import { describe, expect, it } from "vitest";
import { EvaluatorService } from "../../services/evaluator.ts";
import { ignoreAction } from "./actions/ignore.ts";
import { noneAction } from "./actions/none.ts";
import { replyAction } from "./actions/reply.ts";
import { resolveCapabilityConfig as resolveCapabilityConfigDirect } from "./config.ts";
import {
	basicActions,
	basicCapabilities,
	basicEvaluators,
	basicProviders,
	basicServices,
	type CapabilityConfig,
	type CapabilitySettingFlags,
	createBasicCapabilitiesPlugin,
	default as defaultBasicCapabilities,
	type ExplicitCapabilityOptions,
	resolveCapabilityConfig,
} from "./index.edge.ts";
import { actionStateProvider } from "./providers/actionState.ts";
import { actionsProvider } from "./providers/actions.ts";
import { characterProvider } from "./providers/character.ts";
import { currentTimeProvider } from "./providers/currentTime.ts";
import {
	platformChatContextProvider,
	platformUserContextProvider,
} from "./providers/platformContext.ts";
import { providersProvider } from "./providers/providers.ts";
import { recentMessagesProvider } from "./providers/recentMessages.ts";
import { replyContextProvider } from "./providers/replyContext.ts";
import { runtimeModelContextProvider } from "./providers/runtimeModelContext.ts";

const unsupportedFlags = [
	"enableExtended",
	"advancedCapabilities",
	"enableAutonomy",
	"enableTrust",
	"enableSecretsManager",
	"enablePluginManager",
] as const satisfies ReadonlyArray<keyof CapabilityConfig>;

describe("Workerd basic-capabilities exports", () => {
	it("exports the providers in their registration order", () => {
		expect(basicProviders).toEqual([
			actionsProvider,
			actionStateProvider,
			characterProvider,
			currentTimeProvider,
			platformChatContextProvider,
			platformUserContextProvider,
			providersProvider,
			recentMessagesProvider,
			replyContextProvider,
			runtimeModelContextProvider,
		]);
	});

	it("exports canonically documented actions in registration order", () => {
		expect(basicActions.map((action) => action.name)).toEqual([
			replyAction.name,
			ignoreAction.name,
			noneAction.name,
		]);
		for (const action of basicActions) {
			expect(action.descriptionCompressed).toEqual(expect.any(String));
		}
	});

	it("exports the empty evaluator registry and evaluator service", () => {
		expect(basicEvaluators).toEqual([]);
		expect(basicServices).toEqual([EvaluatorService]);
	});

	it("assembles the named and default capability objects from the registries", () => {
		expect(basicCapabilities).toEqual({
			providers: basicProviders,
			actions: basicActions,
			evaluators: basicEvaluators,
			services: basicServices,
		});
		expect(defaultBasicCapabilities).toBe(basicCapabilities);
	});

	it("re-exports the shared configuration types and resolver", () => {
		const options: ExplicitCapabilityOptions = { disableBasic: true };
		const settings: CapabilitySettingFlags = {
			DISABLE_BASIC_CAPABILITIES: false,
		};
		const config: CapabilityConfig = resolveCapabilityConfig(options, settings);

		expect(resolveCapabilityConfig).toBe(resolveCapabilityConfigDirect);
		expect(config.disableBasic).toBe(true);
	});
});

describe("createBasicCapabilitiesPlugin", () => {
	it("returns the complete Workerd composition by default", () => {
		expect(createBasicCapabilitiesPlugin()).toEqual({
			name: "basic-capabilities",
			description: "Workerd conversational core actions and context providers.",
			actions: basicActions,
			providers: basicProviders,
			evaluators: basicEvaluators,
			services: basicServices,
		});
	});

	it("removes only the character provider while preserving provider order", () => {
		const plugin = createBasicCapabilitiesPlugin({
			skipCharacterProvider: true,
		});

		expect(plugin.providers).toEqual(
			basicProviders.filter((provider) => provider !== characterProvider),
		);
		expect(basicProviders).toContain(characterProvider);
		expect(plugin.actions).toBe(basicActions);
	});

	it("removes actions and providers when basic capabilities are disabled", () => {
		const plugin = createBasicCapabilitiesPlugin({
			disableBasic: true,
			skipCharacterProvider: true,
		});

		expect(plugin.actions).toEqual([]);
		expect(plugin.providers).toEqual([]);
		expect(plugin.evaluators).toBe(basicEvaluators);
		expect(plugin.services).toBe(basicServices);
	});

	it.each(unsupportedFlags)("rejects the unsupported %s flag", (flag) => {
		expect(() => createBasicCapabilitiesPlugin({ [flag]: true })).toThrow(
			`Workerd runtime does not support core capability flags: ${flag}`,
		);
	});

	it("reports multiple unsupported flags in canonical order", () => {
		expect(() =>
			createBasicCapabilitiesPlugin({
				enablePluginManager: true,
				enableExtended: true,
				enableTrust: true,
			}),
		).toThrow(
			"Workerd runtime does not support core capability flags: enableExtended, enableTrust, enablePluginManager",
		);
	});

	it("accepts explicitly false unsupported flags", () => {
		expect(
			createBasicCapabilitiesPlugin({
				enableExtended: false,
				advancedCapabilities: false,
				enableAutonomy: false,
				enableTrust: false,
				enableSecretsManager: false,
				enablePluginManager: false,
			}),
		).toEqual(createBasicCapabilitiesPlugin());
	});
});
