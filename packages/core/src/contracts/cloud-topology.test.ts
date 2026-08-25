/**
 * Covers the Eliza Cloud topology derivation: account linkage, deployment
 * runtime, which services are routed through the cloud proxy, and whether the
 * eliza-cloud plugin should load.
 *
 * Two properties are load-bearing. Linkage must treat a `[REDACTED]` API key as
 * unset — the redaction placeholder is what a sanitized/exported config carries,
 * so accepting it would report an unlinked account as linked. And a service
 * counts as cloud-routed only when BOTH its transport is `cloud-proxy` and its
 * backend is `elizacloud`; either half alone must not load the plugin.
 *
 * Pure derivation over plain config records — no runtime, no network, no IO.
 */
import { describe, expect, it } from "vitest";

import {
	ELIZA_CLOUD_SERVICES,
	isElizaCloudLinkedInConfig,
	isElizaCloudServiceSelectedInConfig,
	resolveElizaCloudTopology,
	shouldLoadElizaCloudPluginInConfig,
} from "./cloud-topology.ts";

/**
 * The topology service names are not the routing keys: `inference` is derived
 * from the `llmText` routing entry. Pinning that mapping here is part of the
 * contract — a rename on either side should fail this suite.
 */
const ROUTING_KEY: Record<string, string> = {
	inference: "llmText",
	tts: "tts",
	media: "media",
	embeddings: "embeddings",
	rpc: "rpc",
};

const cloudRouted = (service: string) => ({
	serviceRouting: {
		[ROUTING_KEY[service] ?? service]: {
			backend: "elizacloud",
			transport: "cloud-proxy",
		},
	},
});

describe("isElizaCloudLinkedInConfig", () => {
	it("is false for an absent or empty config", () => {
		expect(isElizaCloudLinkedInConfig(null)).toBe(false);
		expect(isElizaCloudLinkedInConfig(undefined)).toBe(false);
		expect(isElizaCloudLinkedInConfig({})).toBe(false);
	});

	it("is true when the linked-accounts record marks elizacloud linked", () => {
		expect(
			isElizaCloudLinkedInConfig({
				linkedAccounts: { elizacloud: { status: "linked" } },
			}),
		).toBe(true);
	});

	it("is true when a cloud API key is present", () => {
		expect(isElizaCloudLinkedInConfig({ cloud: { apiKey: "sk-live" } })).toBe(
			true,
		);
	});

	it("treats the redaction placeholder as unset, in any case", () => {
		// A sanitized/exported config carries this placeholder; accepting it would
		// report an unlinked account as linked.
		expect(
			isElizaCloudLinkedInConfig({ cloud: { apiKey: "[REDACTED]" } }),
		).toBe(false);
		expect(
			isElizaCloudLinkedInConfig({ cloud: { apiKey: "[redacted]" } }),
		).toBe(false);
	});

	it("treats whitespace-only and non-string keys as unset", () => {
		expect(isElizaCloudLinkedInConfig({ cloud: { apiKey: "   " } })).toBe(
			false,
		);
		expect(isElizaCloudLinkedInConfig({ cloud: { apiKey: 12345 } })).toBe(
			false,
		);
		expect(isElizaCloudLinkedInConfig({ cloud: { apiKey: null } })).toBe(false);
	});

	it("ignores a non-object cloud section", () => {
		expect(isElizaCloudLinkedInConfig({ cloud: "nope" })).toBe(false);
		expect(isElizaCloudLinkedInConfig({ cloud: ["a"] })).toBe(false);
	});
});

describe("resolveElizaCloudTopology", () => {
	it("defaults to local runtime, no provider, and no routed services", () => {
		const topology = resolveElizaCloudTopology({});
		expect(topology.runtime).toBe("local");
		expect(topology.provider).toBeNull();
		expect(Object.values(topology.services).some(Boolean)).toBe(false);
		expect(topology.shouldLoadPlugin).toBe(false);
	});

	it("reports every known service key regardless of routing", () => {
		const topology = resolveElizaCloudTopology({});
		expect(Object.keys(topology.services).sort()).toEqual(
			[...ELIZA_CLOUD_SERVICES].sort(),
		);
	});

	it("marks a service routed only when transport and backend both point at cloud", () => {
		for (const service of ELIZA_CLOUD_SERVICES) {
			expect(
				isElizaCloudServiceSelectedInConfig(cloudRouted(service), service),
			).toBe(true);
		}
	});

	it("does not mark a service routed on transport alone", () => {
		expect(
			isElizaCloudServiceSelectedInConfig(
				{
					serviceRouting: {
						tts: { backend: "openai", transport: "cloud-proxy" },
					},
				},
				"tts",
			),
		).toBe(false);
	});

	it("does not mark a service routed on backend alone", () => {
		expect(
			isElizaCloudServiceSelectedInConfig(
				{
					serviceRouting: {
						tts: { backend: "elizacloud", transport: "direct" },
					},
				},
				"tts",
			),
		).toBe(false);
	});

	it("reports cloud runtime when the deployment target selects it", () => {
		const topology = resolveElizaCloudTopology({
			deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
		});
		expect(topology.runtime).toBe("cloud");
		expect(topology.provider).toBe("elizacloud");
	});

	it("keeps linkage independent of routing", () => {
		const topology = resolveElizaCloudTopology(cloudRouted("media"));
		expect(topology.services.media).toBe(true);
		expect(topology.linked).toBe(false);
	});
});

describe("shouldLoadElizaCloudPluginInConfig", () => {
	it("is false for a bare local config", () => {
		expect(shouldLoadElizaCloudPluginInConfig({})).toBe(false);
	});

	it("is true when a cloud deployment target is selected", () => {
		expect(
			shouldLoadElizaCloudPluginInConfig({
				deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
			}),
		).toBe(true);
	});

	it("is true when any single service is cloud-routed", () => {
		for (const service of ELIZA_CLOUD_SERVICES) {
			expect(shouldLoadElizaCloudPluginInConfig(cloudRouted(service))).toBe(
				true,
			);
		}
	});

	it("is false when a cloud runtime is selected with a non-cloud provider", () => {
		expect(
			shouldLoadElizaCloudPluginInConfig({
				deploymentTarget: { runtime: "cloud", provider: "other" },
			}),
		).toBe(false);
	});
});
