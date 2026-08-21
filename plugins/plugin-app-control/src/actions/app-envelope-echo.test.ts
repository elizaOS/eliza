/**
 * Regression coverage for the external-content security envelope leak on the
 * APP action: core's hardenIncomingUserMessage wraps content.text in a ~2KB
 * "SECURITY NOTICE … <<<EXTERNAL_UNTRUSTED_CONTENT>>>" envelope, and the
 * launch/stop verb extractors fell back to the raw text while the
 * not-found/ambiguous replies quoted the extracted target verbatim (live leak
 * 2026-08-02, tj-2dc95f75456876). Planner options can carry the same blobs, so
 * the echoes must clamp regardless of which seam the target came through.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { wrapExternalContent } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../client/api.js";
import { createAppAction } from "./app.js";
import { runCreate } from "./app-create.js";

/** A hardened inbound message exactly as core leaves it: wrapped text + stamp. */
function envelopedMessage(userSentence: string): Memory {
	const wrapped = wrapExternalContent(userSentence, {
		source: "api",
		includeWarning: true,
	});
	// Precondition: the fixture is the real multi-line envelope, warning first.
	expect(wrapped.startsWith("SECURITY NOTICE")).toBe(true);
	expect(wrapped).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
	expect(wrapped).toContain(userSentence);
	return {
		entityId: "user-1",
		roomId: "room-1",
		agentId: "agent-1",
		content: {
			text: wrapped,
			source: "discord",
			metadata: { externalContentWrapped: true },
		},
	} as Memory;
}

const INSTALLED = [
	{
		name: "chess",
		displayName: "Chess",
		pluginName: "@test/chess",
		version: "1.0.0",
		installedAt: "2026-07-31T00:00:00.000Z",
	},
];

function clientWith(): AppControlClient {
	return {
		listInstalledApps: vi.fn(async () => INSTALLED),
		listAppRuns: vi.fn(async () => []),
		launchApp: vi.fn(),
		stopApp: vi.fn(),
		stopAppRun: vi.fn(),
	};
}

function ownerAction(client: AppControlClient) {
	return createAppAction({ client, hasOwnerAccess: async () => true });
}

function expectNoEnvelope(text: string | undefined) {
	expect(text).toBeDefined();
	expect(text).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
	expect(text).not.toContain("SECURITY NOTICE");
}

function expectClampedTarget(data: unknown) {
	const target = (data as { target?: string })?.target;
	expect(typeof target).toBe("string");
	expect((target as string).length).toBeLessThanOrEqual(121);
	expect(target).not.toContain("\n");
}

const runtime = {
	agentId: "agent-1",
	getTasks: async () => [],
} as unknown as IAgentRuntime;

describe("APP — hardened-envelope messages never leak the envelope", () => {
	it("launch success owns the final user-facing turn instead of allowing a contradictory model rewrite", async () => {
		const client = clientWith();
		vi.mocked(client.launchApp).mockResolvedValue({
			pluginInstalled: true,
			needsRestart: false,
			displayName: "Chess",
			launchType: "local",
			launchUrl: "/api/apps/local/chess/",
			viewer: {
				url: "/api/apps/local/chess/",
				sandbox: "allow-scripts allow-same-origin",
			},
			session: null,
			run: null,
		});
		const callback = vi.fn();
		const result = await ownerAction(client).handler(
			runtime,
			envelopedMessage("launch chess"),
			undefined,
			{ parameters: { action: "launch", app: "chess" } },
			callback,
		);

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				userFacingText: "Launched Chess.",
				verifiedUserFacing: true,
				turnComplete: true,
			}),
		);
		expect(callback).toHaveBeenCalledWith({ text: "Launched Chess." });
	});

	it("launch: extracts the target from the payload and clamps the not-found echo", async () => {
		const client = clientWith();
		const callback = vi.fn();
		const result = await ownerAction(client).handler(
			runtime,
			envelopedMessage("launch the zorptastic app"),
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(false);
		expectNoEnvelope(result?.text);
		// The unwrapped user word — not the envelope remainder — is what echoes.
		expect(result?.text).toContain('"zorptastic"');
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
		expectClampedTarget(result?.data);
	});

	it("stop: a blob-shaped planner app option renders as the neutral noun and a clamped machine value", async () => {
		const blob = envelopedMessage("irrelevant").content.text;
		const client = clientWith();
		const callback = vi.fn();
		const result = await ownerAction(client).handler(
			runtime,
			envelopedMessage("please deal with this"),
			undefined,
			{ parameters: { action: "stop", app: blob } },
			callback,
		);

		expect(result?.success).toBe(false);
		expectNoEnvelope(result?.text);
		expect(result?.text).toContain("that app");
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
		expectClampedTarget(result?.data);
	});

	it("stop: verb scan runs on the payload, not the warning text", async () => {
		const client = clientWith();
		const callback = vi.fn();
		const result = await ownerAction(client).handler(
			runtime,
			envelopedMessage("stop the flurbo app"),
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(false);
		expectNoEnvelope(result?.text);
		expect(result?.text).toContain('"flurbo"');
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
		expectClampedTarget(result?.data);
	});

	it("create: a blob-shaped editTarget renders as the neutral noun, never verbatim", async () => {
		const blob = envelopedMessage("irrelevant").content.text;
		const callback = vi.fn();
		const result = await runCreate({
			runtime,
			client: clientWith(),
			message: envelopedMessage("make it cooler"),
			options: { editTarget: blob, intent: "make it cooler" },
			callback,
			repoRoot: "/tmp/unused",
		});

		expect(result.success).toBe(false);
		expectNoEnvelope(result.text);
		expect(result.text).toContain("that app");
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
	});
});
