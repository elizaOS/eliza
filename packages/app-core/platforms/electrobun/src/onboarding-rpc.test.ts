/**
 * Typed-RPC contract tests for `getOnboardingStatus` and
 * `getOnboardingOptions`.
 *
 * Composers throw `AgentNotReadyError` rather than fabricating
 * `{complete: false}` / empty-catalog placeholders. See the file
 * header comment in onboarding-rpc.ts for the rationale.
 */

import { describe, expect, it } from "bun:test";
import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	type AgentJsonReader,
	composeOnboardingOptionsSnapshot,
	composeOnboardingStatusSnapshot,
	readOnboardingOptionsViaHttp,
	readOnboardingStatusViaHttp,
} from "./onboarding-rpc";
import type {
	OnboardingOptionsSnapshot,
	OnboardingStatusSnapshot,
} from "./rpc-schema";

const noReader: AgentJsonReader<OnboardingStatusSnapshot> = async () => null;
const noOptionsReader: AgentJsonReader<OnboardingOptionsSnapshot> = async () =>
	null;

describe("getOnboardingStatus typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeOnboardingStatusSnapshot(null, noReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("throws when reader returns null", async () => {
		await expect(
			composeOnboardingStatusSnapshot(31337, noReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards complete + cloudProvisioned when present", async () => {
		const reader: AgentJsonReader<OnboardingStatusSnapshot> = async () => ({
			complete: true,
			cloudProvisioned: true,
		});
		const snap = await composeOnboardingStatusSnapshot(31337, reader);
		const _typed: OnboardingStatusSnapshot = snap;
		void _typed;
		expect(snap.complete).toBe(true);
		expect(snap.cloudProvisioned).toBe(true);
	});

	it("omits cloudProvisioned when not present", async () => {
		const reader: AgentJsonReader<OnboardingStatusSnapshot> = async () => ({
			complete: true,
		});
		const snap = await composeOnboardingStatusSnapshot(31337, reader);
		expect(snap.complete).toBe(true);
		expect(snap.cloudProvisioned).toBeUndefined();
	});
});

describe("getOnboardingOptions typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeOnboardingOptionsSnapshot(null, noOptionsReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("throws when reader returns null", async () => {
		await expect(
			composeOnboardingOptionsSnapshot(31337, noOptionsReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards typed catalogs from the reader", async () => {
		const reader: AgentJsonReader<OnboardingOptionsSnapshot> = async () => ({
			names: ["Atlas", "Sage"],
			styles: [{ id: "concise" }],
			providers: [{ id: "openai" }],
			cloudProviders: [{ id: "elizacloud" }],
			models: {
				small: [{ id: "gpt-4o-mini" }],
				large: [{ id: "gpt-4o" }],
			},
			inventoryProviders: [],
			sharedStyleRules: "Be concise.",
			githubOAuthAvailable: true,
		});
		const snap = await composeOnboardingOptionsSnapshot(31337, reader);
		const _typed: OnboardingOptionsSnapshot = snap;
		void _typed;
		expect(snap.names).toEqual(["Atlas", "Sage"]);
		expect(snap.providers).toHaveLength(1);
		expect(snap.models.large).toHaveLength(1);
		expect(snap.sharedStyleRules).toBe("Be concise.");
		expect(snap.githubOAuthAvailable).toBe(true);
	});
});

describe("readOnboardingStatusViaHttp coerces server payloads", () => {
	const originalFetch = globalThis.fetch;
	function installFetch(handler: (url: string) => Response): void {
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
		): Promise<Response> => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			return handler(url);
		}) as typeof fetch;
	}
	function restoreFetch(): void {
		(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
	}

	it("coerces { complete: true, cloudProvisioned: true }", async () => {
		installFetch(() =>
			Response.json({ complete: true, cloudProvisioned: true }),
		);
		try {
			const result = await readOnboardingStatusViaHttp(31337);
			expect(result).toEqual({ complete: true, cloudProvisioned: true });
		} finally {
			restoreFetch();
		}
	});

	it("returns null on 5xx", async () => {
		installFetch(() => new Response("server error", { status: 500 }));
		try {
			const result = await readOnboardingStatusViaHttp(31337);
			expect(result).toBeNull();
		} finally {
			restoreFetch();
		}
	});
});

describe("readOnboardingOptionsViaHttp coerces server payloads", () => {
	const originalFetch = globalThis.fetch;
	function installFetch(handler: (url: string) => Response): void {
		(globalThis as { fetch: typeof fetch }).fetch = (async (
			input: RequestInfo | URL,
		): Promise<Response> => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			return handler(url);
		}) as typeof fetch;
	}
	function restoreFetch(): void {
		(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
	}

	it("drops non-string names + non-object option records", async () => {
		installFetch(() =>
			Response.json({
				names: ["Atlas", 42, null, "Sage"],
				styles: [{ id: "concise" }, "broken", null],
				providers: "not-an-array",
				cloudProviders: [{ id: "elizacloud" }],
				models: {
					small: [{ id: "x" }, "stale"],
					unknownTier: [{ id: "y" }],
				},
				inventoryProviders: [],
				sharedStyleRules: 0,
			}),
		);
		try {
			const result = await readOnboardingOptionsViaHttp(31337);
			expect(result).not.toBeNull();
			if (!result) return;
			expect(result.names).toEqual(["Atlas", "Sage"]);
			expect(result.styles).toEqual([{ id: "concise" }]);
			expect(result.providers).toEqual([]);
			expect(result.cloudProviders).toEqual([{ id: "elizacloud" }]);
			expect(result.models.small).toEqual([{ id: "x" }]);
			expect("unknownTier" in result.models).toBe(false);
			expect(result.sharedStyleRules).toBe("");
		} finally {
			restoreFetch();
		}
	});
});
