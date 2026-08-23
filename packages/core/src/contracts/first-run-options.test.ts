/**
 * First-run option tests exercise the real provider catalog, normalization,
 * connection, migration, credential, and runtime-registration contracts.
 */
import { describe, expect, it } from "vitest";
import {
	CHARACTER_LANGUAGES,
	DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER,
	deriveFirstRunCredentialPersistencePlan,
	FIRST_RUN_CLOUD_PROVIDER_OPTIONS,
	FIRST_RUN_PROVIDER_CATALOG,
	getDirectAccountProviderForFirstRunProvider,
	getFirstRunProviderFamily,
	getFirstRunProviderOption,
	getFirstRunProviderSignalEnvKeys,
	getProviderOptions,
	getStoredFirstRunProviderId,
	getStoredSubscriptionProvider,
	getStoredSubscriptionProviderForRequest,
	getSubscriptionProviderFamily,
	hasExplicitCanonicalRuntimeConfig,
	inferCompatibilityFirstRunConnection,
	inferFirstRunConnectionFromConfig,
	isCloudInferenceSelectedInConfig,
	isCloudManagedConnection,
	isFirstRunConnectionComplete,
	isLocalProviderConnection,
	isRemoteProviderConnection,
	isSubscriptionProviderSelectionId,
	migrateLegacyRuntimeConfig,
	normalizeFirstRunCredentialInputs,
	normalizeFirstRunProviderId,
	normalizePersistedFirstRunConnection,
	normalizeSubscriptionProviderSelectionId,
	type ProviderOption,
	readFirstRunEnvSecret,
	readFirstRunEnvString,
	registerProviderOption,
	requiresAdditionalRuntimeProvider,
	resolveDeploymentTargetInConfig,
	resolveLinkedAccountsInConfig,
	resolveServiceRoutingInConfig,
	SUBSCRIPTION_PROVIDER_SELECTIONS,
	sortFirstRunProviders,
	stripFirstRunConnectionSecrets,
} from "./first-run-options.ts";

function providerOption(
	id: string,
	order: number,
	recommended = false,
): ProviderOption {
	return {
		id,
		name: id,
		envKey: `${id.toUpperCase()}_API_KEY`,
		pluginName: `@test/plugin-${id}`,
		keyPrefix: null,
		description: `${id} provider`,
		family: id,
		authMode: "api-key",
		group: "local",
		order,
		recommended,
	};
}

describe("first-run provider metadata", () => {
	it("publishes the supported character languages and cloud choice", () => {
		expect(CHARACTER_LANGUAGES).toEqual([
			"en",
			"zh-CN",
			"ko",
			"es",
			"pt",
			"vi",
			"tl",
		]);
		expect(FIRST_RUN_CLOUD_PROVIDER_OPTIONS).toEqual([
			expect.objectContaining({ id: "elizacloud" }),
		]);
	});

	it("keeps subscription selections aligned with catalog entries", () => {
		for (const selection of SUBSCRIPTION_PROVIDER_SELECTIONS) {
			expect(FIRST_RUN_PROVIDER_CATALOG).toContainEqual(
				expect.objectContaining({
					id: selection.id,
					family: selection.family,
					storedProvider: selection.storedProvider,
				}),
			);
		}
	});

	it("maps direct-account providers only for supported API-key choices", () => {
		expect(DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER).toEqual({
			anthropic: "anthropic-api",
			openai: "openai-api",
			deepseek: "deepseek-api",
			zai: "zai-api",
			moonshot: "moonshot-api",
			cerebras: "cerebras-api",
		});
	});
});

describe("subscription provider helpers", () => {
	it("recognizes only exact selection ids", () => {
		expect(isSubscriptionProviderSelectionId("openai-subscription")).toBe(true);
		expect(isSubscriptionProviderSelectionId("OPENAI-SUBSCRIPTION")).toBe(
			false,
		);
		expect(isSubscriptionProviderSelectionId(null)).toBe(false);
	});

	it("normalizes selection aliases and rejects non-subscription providers", () => {
		expect(normalizeSubscriptionProviderSelectionId(" openai-codex ")).toBe(
			"openai-subscription",
		);
		expect(
			normalizeSubscriptionProviderSelectionId("google-subscription"),
		).toBe("gemini-subscription");
		expect(normalizeSubscriptionProviderSelectionId("openai")).toBeNull();
	});

	it("maps selections and stored request ids", () => {
		expect(getStoredSubscriptionProvider("openai-subscription")).toBe(
			"openai-codex",
		);
		expect(getStoredSubscriptionProviderForRequest(" GEMINI-CLI ")).toBe(
			"gemini-cli",
		);
		expect(getStoredSubscriptionProviderForRequest("unknown")).toBeNull();
		expect(getStoredSubscriptionProviderForRequest(5)).toBeNull();
	});

	it("reports subscription families and additional runtime requirements", () => {
		expect(getSubscriptionProviderFamily("kimi-coding-subscription")).toBe(
			"moonshot",
		);
		expect(requiresAdditionalRuntimeProvider("anthropic-subscription")).toBe(
			true,
		);
		expect(requiresAdditionalRuntimeProvider("openai-codex")).toBe(false);
		expect(requiresAdditionalRuntimeProvider("openai")).toBe(false);
	});
});

describe("provider lookup and ordering", () => {
	it("normalizes aliases, package names, plugin names, and invalid input", () => {
		expect(normalizeFirstRunProviderId(" XAI ")).toBe("grok");
		expect(normalizeFirstRunProviderId("@elizaos/plugin-openrouter")).toBe(
			"openrouter",
		);
		expect(normalizeFirstRunProviderId("@elizaos/plugin-openai")).toBe(
			"openai",
		);
		expect(normalizeFirstRunProviderId("llama_local")).toBe("ollama");
		expect(normalizeFirstRunProviderId(" ")).toBeNull();
		expect(normalizeFirstRunProviderId({})).toBeNull();
	});

	it("returns provider metadata, family, storage id, and direct account id", () => {
		expect(getFirstRunProviderOption("openai-codex")).toEqual(
			expect.objectContaining({ id: "openai-subscription" }),
		);
		expect(getFirstRunProviderFamily("near.ai")).toBe("nearai");
		expect(getStoredFirstRunProviderId("openai-subscription")).toBe(
			"openai-codex",
		);
		expect(getStoredFirstRunProviderId("openai")).toBe("openai");
		expect(getDirectAccountProviderForFirstRunProvider("CEREBRAS-API")).toBe(
			"cerebras-api",
		);
		expect(getDirectAccountProviderForFirstRunProvider("ollama")).toBeNull();
		expect(getFirstRunProviderOption("unknown")).toBeNull();
		expect(getFirstRunProviderFamily("unknown")).toBeNull();
		expect(getStoredFirstRunProviderId("unknown")).toBeNull();
	});

	it("sorts recommended providers first and then by order without mutation", () => {
		const later = providerOption("later", 30);
		const recommendedLater = providerOption("recommended-later", 20, true);
		const recommendedEarlier = providerOption("recommended-earlier", 10, true);
		const input = [later, recommendedLater, recommendedEarlier] as const;

		expect(sortFirstRunProviders(input).map(({ id }) => id)).toEqual([
			"recommended-earlier",
			"recommended-later",
			"later",
		]);
		expect(input).toEqual([later, recommendedLater, recommendedEarlier]);
	});

	it("preserves input order for ties and handles empty and single lists", () => {
		const first = providerOption("first", 10);
		const second = providerOption("second", 10);
		expect(sortFirstRunProviders([first, second])).toEqual([first, second]);
		expect(sortFirstRunProviders([])).toEqual([]);
		expect(sortFirstRunProviders([first])).toEqual([first]);
	});

	it("returns provider-specific signal environment keys", () => {
		expect(getFirstRunProviderSignalEnvKeys("ollama")).toEqual([
			"OLLAMA_BASE_URL",
		]);
		expect(getFirstRunProviderSignalEnvKeys("zai")).toEqual([
			"ZAI_API_KEY",
			"Z_AI_API_KEY",
		]);
		expect(getFirstRunProviderSignalEnvKeys("openai")).toEqual([
			"OPENAI_API_KEY",
		]);
		expect(getFirstRunProviderSignalEnvKeys("openai-subscription")).toEqual([]);
	});
});

describe("connection guards and normalization", () => {
	it("narrows each connection kind and rejects absent connections", () => {
		const cloud = {
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
		} as const;
		const local = { kind: "local-provider", provider: "openai" } as const;
		const remote = {
			kind: "remote-provider",
			remoteApiBase: "https://agent.example",
		} as const;

		expect(isCloudManagedConnection(cloud)).toBe(true);
		expect(isLocalProviderConnection(local)).toBe(true);
		expect(isRemoteProviderConnection(remote)).toBe(true);
		expect(isCloudManagedConnection(undefined)).toBe(false);
		expect(isLocalProviderConnection(remote)).toBe(false);
	});

	it("checks completeness according to connection kind", () => {
		expect(
			isFirstRunConnectionComplete({
				kind: "local-provider",
				provider: "ollama",
			}),
		).toBe(true);
		expect(
			isFirstRunConnectionComplete({
				kind: "remote-provider",
				remoteApiBase: "  ",
			}),
		).toBe(false);
		expect(
			isFirstRunConnectionComplete({
				kind: "remote-provider",
				remoteApiBase: " https://agent.example ",
			}),
		).toBe(true);
		expect(
			isFirstRunConnectionComplete({
				kind: "cloud-managed",
				cloudProvider: "elizacloud",
				smallModel: "small",
				largeModel: "large",
			}),
		).toBe(true);
		expect(
			isFirstRunConnectionComplete({
				kind: "cloud-managed",
				cloudProvider: "elizacloud",
				smallModel: "small",
			}),
		).toBe(false);
		expect(isFirstRunConnectionComplete(null)).toBe(false);
	});

	it("normalizes persisted cloud, local, and remote connections", () => {
		expect(
			normalizePersistedFirstRunConnection({
				kind: "cloud-managed",
				apiKey: " cloud-secret ",
				smallModel: " small ",
				largeModel: "large",
			}),
		).toEqual({
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
			apiKey: "cloud-secret",
			smallModel: "small",
			largeModel: "large",
		});
		expect(
			normalizePersistedFirstRunConnection({
				kind: "local-provider",
				provider: " XAI ",
				apiKey: "[REDACTED]",
				primaryModel: " grok-4 ",
			}),
		).toEqual({
			kind: "local-provider",
			provider: "grok",
			apiKey: undefined,
			primaryModel: "grok-4",
		});
		expect(
			normalizePersistedFirstRunConnection({
				kind: "remote-provider",
				remoteApiBase: " https://agent.example ",
				remoteAccessToken: " token ",
				provider: "google-genai",
			}),
		).toEqual({
			kind: "remote-provider",
			remoteApiBase: "https://agent.example",
			remoteAccessToken: "token",
			provider: "gemini",
			apiKey: undefined,
			primaryModel: undefined,
		});
	});

	it("rejects malformed persisted connections", () => {
		expect(normalizePersistedFirstRunConnection(null)).toBeNull();
		expect(
			normalizePersistedFirstRunConnection({
				kind: "local-provider",
				provider: "elizacloud",
			}),
		).toBeNull();
		expect(
			normalizePersistedFirstRunConnection({
				kind: "remote-provider",
				remoteApiBase: " ",
			}),
		).toBeNull();
		expect(
			normalizePersistedFirstRunConnection({ kind: "unknown" }),
		).toBeNull();
	});

	it("strips every secret while retaining routing and model choices", () => {
		expect(
			stripFirstRunConnectionSecrets({
				kind: "cloud-managed",
				cloudProvider: "elizacloud",
				apiKey: "secret",
				smallModel: "small",
				largeModel: "large",
			}),
		).toEqual({
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
			smallModel: "small",
			largeModel: "large",
		});
		expect(
			stripFirstRunConnectionSecrets({
				kind: "local-provider",
				provider: "openai",
				apiKey: "secret",
				primaryModel: "gpt",
			}),
		).toEqual({
			kind: "local-provider",
			provider: "openai",
			primaryModel: "gpt",
		});
		expect(
			stripFirstRunConnectionSecrets({
				kind: "remote-provider",
				remoteApiBase: "https://agent.example",
				remoteAccessToken: "token",
				apiKey: "secret",
				provider: "openai",
				primaryModel: "gpt",
			}),
		).toEqual({
			kind: "remote-provider",
			remoteApiBase: "https://agent.example",
			provider: "openai",
			primaryModel: "gpt",
		});
	});
});

describe("environment and canonical config helpers", () => {
	it("reads nested vars before env values and trims strings", () => {
		const config = {
			env: {
				OPENAI_API_KEY: " outer ",
				vars: { OPENAI_API_KEY: " nested " },
			},
		};
		expect(readFirstRunEnvString(config, "OPENAI_API_KEY")).toBe("nested");
		expect(readFirstRunEnvString({ env: { VALUE: " value " } }, "VALUE")).toBe(
			"value",
		);
		expect(readFirstRunEnvString({ env: [] }, "VALUE")).toBeUndefined();
	});

	it("rejects blank and redacted secrets", () => {
		expect(
			readFirstRunEnvSecret({ env: { SECRET: " [redacted] " } }, "SECRET"),
		).toBeUndefined();
		expect(
			readFirstRunEnvSecret({ env: { SECRET: " value " } }, "SECRET"),
		).toBe("value");
		expect(readFirstRunEnvSecret(undefined, "SECRET")).toBeUndefined();
	});

	it("detects explicit canonical keys by ownership", () => {
		expect(hasExplicitCanonicalRuntimeConfig({ deploymentTarget: null })).toBe(
			true,
		);
		expect(hasExplicitCanonicalRuntimeConfig({ linkedAccounts: {} })).toBe(
			true,
		);
		expect(hasExplicitCanonicalRuntimeConfig({ serviceRouting: {} })).toBe(
			true,
		);
		expect(hasExplicitCanonicalRuntimeConfig({ cloud: {} })).toBe(false);
		expect(hasExplicitCanonicalRuntimeConfig(null)).toBe(false);
	});
});

describe("config resolution and migration", () => {
	it("resolves linked cloud accounts without overwriting explicit status", () => {
		expect(
			resolveLinkedAccountsInConfig({ cloud: { apiKey: " secret " } }),
		).toEqual({ elizacloud: { status: "linked", source: "api-key" } });
		expect(
			resolveLinkedAccountsInConfig({
				linkedAccounts: {
					elizacloud: { status: "unlinked", source: "oauth" },
				},
				cloud: { apiKey: "secret" },
			}),
		).toEqual({ elizacloud: { status: "unlinked", source: "oauth" } });
		expect(resolveLinkedAccountsInConfig({})).toBeNull();
	});

	it("resolves valid deployment targets and defaults invalid input to local", () => {
		expect(
			resolveDeploymentTargetInConfig({
				deploymentTarget: {
					runtime: "remote",
					provider: "remote",
					remoteApiBase: "https://agent.example",
				},
			}),
		).toEqual({
			runtime: "remote",
			provider: "remote",
			remoteApiBase: "https://agent.example",
		});
		expect(
			resolveDeploymentTargetInConfig({ deploymentTarget: "bad" }),
		).toEqual({ runtime: "local" });
	});

	it("fills missing service routing from remote and local config signals", () => {
		expect(
			resolveServiceRoutingInConfig({
				deploymentTarget: {
					runtime: "remote",
					provider: "remote",
					remoteApiBase: "https://agent.example",
				},
				agents: { defaults: { model: { primary: "remote-model" } } },
			}),
		).toEqual({
			llmText: {
				backend: "remote",
				transport: "remote",
				remoteApiBase: "https://agent.example",
				primaryModel: "remote-model",
			},
		});
		expect(
			resolveServiceRoutingInConfig({
				env: { vars: { OPENAI_API_KEY: "secret" } },
				agents: { defaults: { model: { primary: "gpt" } } },
			}),
		).toEqual({
			llmText: {
				backend: "openai",
				transport: "direct",
				primaryModel: "gpt",
			},
		});
		expect(resolveServiceRoutingInConfig({})).toBeNull();
	});

	it("migrates legacy cloud routing in place and prunes obsolete fields", () => {
		const config = {
			cloud: {
				enabled: true,
				provider: "elizacloud",
				apiKey: "secret",
				services: { inference: true, tts: true },
			},
			models: { small: "small", large: "large" },
			connection: { kind: "old" },
		};

		expect(migrateLegacyRuntimeConfig(config)).toBe(config);
		expect(config).toEqual({
			cloud: { enabled: true, apiKey: "secret" },
			models: { small: "small", large: "large" },
			linkedAccounts: {
				elizacloud: { status: "linked", source: "api-key" },
			},
			serviceRouting: {
				llmText: {
					backend: "elizacloud",
					transport: "cloud-proxy",
					accountId: "elizacloud",
					smallModel: "small",
					largeModel: "large",
				},
				tts: {
					backend: "elizacloud",
					transport: "cloud-proxy",
					accountId: "elizacloud",
				},
			},
		});
	});
});

describe("credential persistence", () => {
	it("normalizes credential strings and rejects empty inputs", () => {
		expect(
			normalizeFirstRunCredentialInputs({
				llmApiKey: " llm ",
				cloudApiKey: " [REDACTED] ",
			}),
		).toEqual({ llmApiKey: "llm" });
		expect(normalizeFirstRunCredentialInputs({ llmApiKey: " " })).toBeNull();
		expect(normalizeFirstRunCredentialInputs([])).toBeNull();
	});

	it("derives cloud-proxy persistence from the cloud credential", () => {
		expect(
			deriveFirstRunCredentialPersistencePlan({
				credentialInputs: { cloudApiKey: "cloud-secret" },
				serviceRouting: {
					llmText: {
						backend: "elizacloud",
						transport: "cloud-proxy",
						accountId: "elizacloud",
						smallModel: "small",
						largeModel: "large",
					},
				},
			}),
		).toEqual({
			llmSelection: {
				backend: "elizacloud",
				transport: "cloud-proxy",
				apiKey: "cloud-secret",
				smallModel: "small",
				largeModel: "large",
			},
			cloudApiKey: "cloud-secret",
		});
	});

	it("derives direct and remote persistence from the LLM credential", () => {
		expect(
			deriveFirstRunCredentialPersistencePlan({
				credentialInputs: {
					llmApiKey: "llm-secret",
					cloudApiKey: "cloud-secret",
				},
				serviceRouting: {
					llmText: {
						backend: "openai",
						transport: "direct",
						primaryModel: "gpt",
					},
				},
			}),
		).toEqual({
			llmSelection: {
				backend: "openai",
				transport: "direct",
				apiKey: "llm-secret",
				primaryModel: "gpt",
			},
			cloudApiKey: "cloud-secret",
		});

		expect(
			deriveFirstRunCredentialPersistencePlan({
				credentialInputs: { llmApiKey: "llm-secret" },
				deploymentTarget: {
					runtime: "remote",
					provider: "remote",
					remoteApiBase: "https://agent.example",
					remoteAccessToken: "remote-token",
				},
				serviceRouting: {
					llmText: { backend: "openai", transport: "remote" },
				},
			}),
		).toEqual({
			llmSelection: {
				backend: "openai",
				transport: "remote",
				remoteApiBase: "https://agent.example",
				remoteAccessToken: "remote-token",
				apiKey: "llm-secret",
			},
		});
	});

	it("returns no LLM selection when routing or credentials are insufficient", () => {
		expect(
			deriveFirstRunCredentialPersistencePlan({
				credentialInputs: { cloudApiKey: "cloud-secret" },
				serviceRouting: {
					llmText: { backend: "openai", transport: "direct" },
				},
			}),
		).toEqual({ llmSelection: null, cloudApiKey: "cloud-secret" });
		expect(deriveFirstRunCredentialPersistencePlan({})).toEqual({
			llmSelection: null,
		});
	});
});

describe("connection inference", () => {
	it("infers compatibility remote, cloud, local, and absent connections", () => {
		expect(
			inferCompatibilityFirstRunConnection({
				cloud: {
					remoteApiBase: " https://agent.example ",
					remoteAccessToken: " token ",
				},
				env: { OPENAI_API_KEY: " secret " },
			}),
		).toEqual({
			kind: "remote-provider",
			remoteApiBase: "https://agent.example",
			remoteAccessToken: "token",
			provider: "openai",
			apiKey: "secret",
			primaryModel: undefined,
		});
		expect(
			inferCompatibilityFirstRunConnection({
				cloud: { enabled: true, apiKey: "cloud-secret" },
				models: { small: "small", large: "large" },
			}),
		).toEqual({
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
			apiKey: "cloud-secret",
			nanoModel: undefined,
			smallModel: "small",
			mediumModel: undefined,
			largeModel: "large",
			megaModel: undefined,
		});
		expect(
			inferCompatibilityFirstRunConnection({
				cloud: { enabled: false },
				env: { OPENAI_API_KEY: "secret" },
			}),
		).toEqual({
			kind: "local-provider",
			provider: "openai",
			apiKey: "secret",
			primaryModel: undefined,
		});
		expect(inferCompatibilityFirstRunConnection({})).toBeNull();
	});

	it("infers canonical cloud, remote, and direct connections", () => {
		expect(
			inferFirstRunConnectionFromConfig({
				serviceRouting: {
					llmText: {
						backend: "elizacloud",
						transport: "cloud-proxy",
						accountId: "elizacloud",
						smallModel: "small",
						largeModel: "large",
					},
				},
			}),
		).toEqual({
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
			smallModel: "small",
			largeModel: "large",
		});
		expect(
			inferFirstRunConnectionFromConfig({
				deploymentTarget: {
					runtime: "remote",
					provider: "remote",
					remoteApiBase: "https://agent.example",
					remoteAccessToken: "token",
				},
			}),
		).toEqual({
			kind: "remote-provider",
			remoteApiBase: "https://agent.example",
			remoteAccessToken: "token",
		});
		expect(
			inferFirstRunConnectionFromConfig({
				serviceRouting: {
					llmText: { backend: "openai", transport: "direct" },
				},
				env: { OPENAI_API_KEY: "secret" },
			}),
		).toEqual({
			kind: "local-provider",
			provider: "openai",
			apiKey: "secret",
		});
		expect(inferFirstRunConnectionFromConfig({})).toBeNull();
	});

	it("detects only canonical cloud-proxy inference routes", () => {
		expect(
			isCloudInferenceSelectedInConfig({
				serviceRouting: {
					llmText: {
						backend: "elizacloud",
						transport: "cloud-proxy",
						accountId: "elizacloud",
					},
				},
			}),
		).toBe(true);
		expect(
			isCloudInferenceSelectedInConfig({
				serviceRouting: {
					llmText: { backend: "openai", transport: "direct" },
				},
			}),
		).toBe(false);
	});
});

describe("provider registry", () => {
	it("adds providers and replaces registrations with the same id", () => {
		const id = "unit-test-provider";
		const initial = providerOption(id, 900);
		const replacement = {
			...providerOption(id, 901, true),
			name: "Replacement provider",
		};

		registerProviderOption(initial);
		expect(getProviderOptions()).toContainEqual(initial);
		registerProviderOption(replacement);
		expect(getProviderOptions().filter((option) => option.id === id)).toEqual([
			replacement,
		]);
	});

	it("lets runtime registrations override catalog entries without duplicates", () => {
		const override = {
			...providerOption("openai", 999),
			name: "Runtime OpenAI",
		};

		registerProviderOption(override);
		const options = getProviderOptions();
		expect(options.filter((option) => option.id === "openai")).toEqual([
			override,
		]);
		expect(options).toHaveLength(FIRST_RUN_PROVIDER_CATALOG.length + 1);
	});
});
