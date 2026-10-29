import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderStatus } from "@elizaos/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CompatRuntimeState } from "./compat-helpers";
import { handleLocalInferenceCompatRoutes } from "./local-inference-compat-routes";

const KEY_NAMES = [
	"ELIZAOS_CLOUD_API_KEY",
	"ELIZA_CLOUD_TOKEN",
	"ELIZACLOUD_TOKEN",
	"ELIZAOS_API_KEY",
	"GROK_API_KEY",
	"XAI_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
] as const;
const savedEnv = new Map(KEY_NAMES.map((name) => [name, process.env[name]]));

const state = {
	current: null,
	authorizeRequest: async () => true,
} as unknown as CompatRuntimeState;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		void handleLocalInferenceCompatRoutes(req, res, state).then((handled) => {
			if (!handled) {
				res.statusCode = 404;
				res.end();
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function setKeys(keys: Partial<Record<(typeof KEY_NAMES)[number], string>>) {
	for (const name of KEY_NAMES) delete process.env[name];
	Object.assign(process.env, keys);
}

async function enableState(providerId: string) {
	const response = await fetch(`${baseUrl}/api/local-inference/providers`);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { providers: ProviderStatus[] };
	return body.providers.find((provider) => provider.id === providerId)
		?.enableState;
}

describe("GET /api/local-inference/providers key status", () => {
	it("shows Eliza Cloud as signed in with the key that linking Cloud writes", async () => {
		// provider-switch-config.ts persistLinkedCloudApiKey sets this variable.
		setKeys({ ELIZAOS_CLOUD_API_KEY: "eliza_cloud_key" });
		expect(await enableState("elizacloud")).toEqual({
			enabled: true,
			reason: "Cloud token set",
		});
	});

	it("shows Eliza Cloud as not signed in without a Cloud key", async () => {
		setKeys({});
		expect(await enableState("elizacloud")).toEqual({
			enabled: false,
			reason: "Not signed in",
		});
	});

	it.each([
		["grok", { GROK_API_KEY: " ", XAI_API_KEY: "xai-key" }],
		["google", { GOOGLE_API_KEY: "", GEMINI_API_KEY: "gemini-key" }],
	] as const)(
		"reads the second key name for %s when the first is blank",
		async (providerId, keys) => {
			setKeys(keys);
			expect(await enableState(providerId)).toEqual({
				enabled: true,
				reason: "API key set",
			});
		},
	);
});
