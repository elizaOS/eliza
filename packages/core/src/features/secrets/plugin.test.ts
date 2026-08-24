/**
 * Exercises the `secrets` plugin assembly itself: the planner- and
 * runtime-facing registration contract (actions, providers, services) and the
 * init/dispose lifecycle orchestration against a deterministic runtime stub.
 * Every binding asserted is the real imported symbol; no handler, service,
 * provider, database, or secret store is mocked.
 */

import { describe, expect, test } from "vitest";
import { secretsAction } from "./actions/manage-secret";
import defaultExport, { secretsManagerPlugin } from "./plugin";
import {
	secretsInfoProvider,
	secretsStatusProvider,
} from "./providers/secrets-status";
import {
	PLUGIN_ACTIVATOR_SERVICE_TYPE,
	PluginActivatorService,
} from "./services/plugin-activator";
import { SECRETS_SERVICE_TYPE, SecretsService } from "./services/secrets";
import { updateSettingsAction } from "./setup/action";
import {
	missingSecretsProvider,
	setupSettingsProvider,
} from "./setup/provider";
import { SETUP_SERVICE_TYPE, SetupService } from "./setup/service";

describe("secrets plugin assembly", () => {
	test("publishes the runtime-facing registration contract", () => {
		expect(secretsManagerPlugin.name).toBe("secrets");
		expect(secretsManagerPlugin.description).toBeTruthy();
		expect(secretsManagerPlugin.actions?.[0]).toBe(secretsAction);
		expect(secretsManagerPlugin.actions?.[1]).toBe(updateSettingsAction);
		expect(secretsManagerPlugin.providers?.[0]).toBe(secretsStatusProvider);
		expect(secretsManagerPlugin.providers?.[1]).toBe(secretsInfoProvider);
		expect(secretsManagerPlugin.providers?.[2]).toBe(setupSettingsProvider);
		expect(secretsManagerPlugin.providers?.[3]).toBe(missingSecretsProvider);
	});

	test("registers exactly the two planner-visible actions", () => {
		expect(secretsManagerPlugin.actions?.map((action) => action.name)).toEqual([
			"SECRETS",
			"SECRETS_UPDATE_SETTINGS",
		]);
	});

	test("registers the four context-injection providers in order", () => {
		expect(
			secretsManagerPlugin.providers?.map((provider) => provider.name),
		).toEqual([
			"SECRETS_STATUS",
			"SECRETS_INFO",
			"SETUP_SETTINGS",
			"MISSING_SECRETS",
		]);
	});

	test("declares its three owning services", () => {
		expect(secretsManagerPlugin.services).toEqual([
			SecretsService,
			PluginActivatorService,
			SetupService,
		]);
	});

	test("exposes the same plugin through the default export", () => {
		expect(defaultExport).toBe(secretsManagerPlugin);
	});
});

describe("secrets plugin lifecycle", () => {
	test("init resolves with a full configuration object", async () => {
		await expect(
			secretsManagerPlugin.init?.(
				{
					enableEncryption: true,
					encryptionSalt: "unit-test-salt",
					enableAccessLogging: false,
					enableAutoActivation: false,
					activationPollingMs: 1000,
				} as never,
				{} as never,
			),
		).resolves.toBeUndefined();
	});

	function createRecordingRuntime(events: string[]) {
		return {
			getService(type: string) {
				events.push(`lookup:${type}`);
				return {
					stop: async () => {
						events.push(`stopped:${type}`);
					},
				};
			},
		};
	}

	test("dispose stops every owned service once, keyed by its service type", async () => {
		const events: string[] = [];
		await secretsManagerPlugin.dispose(createRecordingRuntime(events) as never);
		expect(events).toEqual([
			`lookup:${PLUGIN_ACTIVATOR_SERVICE_TYPE}`,
			`stopped:${PLUGIN_ACTIVATOR_SERVICE_TYPE}`,
			`lookup:${SECRETS_SERVICE_TYPE}`,
			`stopped:${SECRETS_SERVICE_TYPE}`,
			`lookup:${SETUP_SERVICE_TYPE}`,
			`stopped:${SETUP_SERVICE_TYPE}`,
		]);
	});

	test("dispose resolves when no services are registered", async () => {
		await expect(
			secretsManagerPlugin.dispose({
				getService: () => null,
			} as never),
		).resolves.toBeUndefined();
	});

	test("dispose skips only the services that are absent", async () => {
		const events: string[] = [];
		await secretsManagerPlugin.dispose({
			getService: (type: string) => {
				events.push(`lookup:${type}`);
				return type === PLUGIN_ACTIVATOR_SERVICE_TYPE
					? {
							stop: async () => {
								events.push(`stopped:${type}`);
							},
						}
					: null;
			},
		} as never);
		expect(events).toEqual([
			`lookup:${PLUGIN_ACTIVATOR_SERVICE_TYPE}`,
			`stopped:${PLUGIN_ACTIVATOR_SERVICE_TYPE}`,
			`lookup:${SECRETS_SERVICE_TYPE}`,
			`lookup:${SETUP_SERVICE_TYPE}`,
		]);
	});

	test("dispose awaits each stop before proceeding to the next service", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const events: string[] = [];
		const runtime = {
			getService(type: string) {
				events.push(`lookup:${type}`);
				return {
					stop: async () => {
						if (type === PLUGIN_ACTIVATOR_SERVICE_TYPE) {
							await blocked;
						}
						events.push(`stopped:${type}`);
					},
				};
			},
		};
		const disposal = secretsManagerPlugin.dispose(runtime as never);

		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		expect(events).toEqual([`lookup:${PLUGIN_ACTIVATOR_SERVICE_TYPE}`]);

		release();
		await disposal;
		expect(events).toEqual([
			`lookup:${PLUGIN_ACTIVATOR_SERVICE_TYPE}`,
			`stopped:${PLUGIN_ACTIVATOR_SERVICE_TYPE}`,
			`lookup:${SECRETS_SERVICE_TYPE}`,
			`stopped:${SECRETS_SERVICE_TYPE}`,
			`lookup:${SETUP_SERVICE_TYPE}`,
			`stopped:${SETUP_SERVICE_TYPE}`,
		]);
	});
});
