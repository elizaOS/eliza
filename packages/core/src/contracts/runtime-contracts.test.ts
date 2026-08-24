/**
 * Covers the cloud-topology decisions exactly as consumers receive them
 * through the `runtime-contracts` barrel (`@elizaos/core/contracts/*`):
 * provider precedence between service routing and the deployment target,
 * redacted-secret linkage, multi-service routing, and non-object configs.
 *
 * Real derivation over plain config records — no mocks, no network, no IO.
 */
import { describe, expect, it } from "vitest";

import {
	isElizaCloudLinkedInConfig,
	isElizaCloudServiceSelectedInConfig,
	resolveElizaCloudTopology,
	shouldLoadElizaCloudPluginInConfig,
} from "./runtime-contracts.js";

describe("resolveElizaCloudTopology via the runtime-contracts barrel", () => {
	it("prefers an elizacloud llmText route over the deployment target for provider", () => {
		const topology = resolveElizaCloudTopology({
			deploymentTarget: { runtime: "local", provider: "elizacloud" },
			serviceRouting: {
				llmText: {
					backend: "@elizaos/plugin-elizacloud",
					transport: "cloud-proxy",
				},
			},
		});
		expect(topology.provider).toBe("elizacloud");
		expect(topology.services.inference).toBe(true);
		expect(topology.services.tts).toBe(false);
		expect(topology.shouldLoadPlugin).toBe(true);
	});

	it("falls back to the deployment-target provider when routing points elsewhere", () => {
		const topology = resolveElizaCloudTopology({
			deploymentTarget: { runtime: "local", provider: "elizacloud" },
			serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
		});
		expect(topology.provider).toBe("elizacloud");
		expect(topology.services.inference).toBe(false);
	});

	it("reports a null provider when neither routing nor deployment target selects elizacloud", () => {
		const topology = resolveElizaCloudTopology({
			serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
		});
		expect(topology.provider).toBeNull();
		expect(topology.runtime).toBe("local");
	});

	it("maps a remote deployment target onto a local runtime with no provider", () => {
		const topology = resolveElizaCloudTopology({
			deploymentTarget: {
				runtime: "remote",
				provider: "remote",
				remoteApiBase: "https://remote.example.com",
			},
		});
		expect(topology.runtime).toBe("local");
		expect(topology.provider).toBeNull();
		expect(topology.shouldLoadPlugin).toBe(false);
	});

	it("resolves every routed service at once", () => {
		const cloudRoute = { backend: "elizacloud", transport: "cloud-proxy" };
		const topology = resolveElizaCloudTopology({
			serviceRouting: {
				llmText: cloudRoute,
				tts: cloudRoute,
				media: cloudRoute,
				embeddings: cloudRoute,
				rpc: cloudRoute,
			},
		});
		expect(topology.services).toEqual({
			inference: true,
			tts: true,
			media: true,
			embeddings: true,
			rpc: true,
		});
		expect(topology.linked).toBe(false);
		expect(topology.shouldLoadPlugin).toBe(true);
	});

	it("rejects a top-level array config like any other non-object", () => {
		// The resolver defends against non-object roots; arrays must fall through
		// to local defaults rather than crash or partially match.
		const arrayConfig = ["cloud"] as unknown as Record<string, unknown>;
		const topology = resolveElizaCloudTopology(arrayConfig);
		expect(topology.runtime).toBe("local");
		expect(topology.provider).toBeNull();
		expect(topology.shouldLoadPlugin).toBe(false);
	});
});

describe("isElizaCloudLinkedInConfig via the runtime-contracts barrel", () => {
	it("links through either source: the linked flag or a live API key", () => {
		const unlinkedFlagOnly = {
			linkedAccounts: { elizacloud: { status: "unlinked" } },
		};
		expect(isElizaCloudLinkedInConfig(unlinkedFlagOnly)).toBe(false);

		expect(
			isElizaCloudLinkedInConfig({
				...unlinkedFlagOnly,
				cloud: { apiKey: "sk-live" },
			}),
		).toBe(true);

		expect(
			isElizaCloudLinkedInConfig({
				linkedAccounts: { elizacloud: { status: "linked" } },
			}),
		).toBe(true);
	});

	it("treats the redaction placeholder as unset even with no other signal", () => {
		// Sanitized/exported configs carry this placeholder; accepting it would
		// report an unlinked account as linked.
		expect(
			isElizaCloudLinkedInConfig({ cloud: { apiKey: "[REDACTED]" } }),
		).toBe(false);
	});
});

describe("per-service selection and plugin load via the runtime-contracts barrel", () => {
	it("derives inference from the llmText routing entry", () => {
		const config = {
			serviceRouting: {
				llmText: { backend: "elizacloud", transport: "cloud-proxy" },
			},
		};
		expect(isElizaCloudServiceSelectedInConfig(config, "inference")).toBe(true);
		expect(isElizaCloudServiceSelectedInConfig(config, "rpc")).toBe(false);
	});

	it("withholds the plugin when only the backend names cloud", () => {
		const config = {
			serviceRouting: {
				llmText: { backend: "elizacloud", transport: "direct" },
			},
		};
		expect(shouldLoadElizaCloudPluginInConfig(config)).toBe(false);
		expect(resolveElizaCloudTopology(config).services.inference).toBe(false);
	});
});
