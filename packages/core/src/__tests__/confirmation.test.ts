/**
 * Covers `requireConfirmation`: it confirms a pending action only when the
 * follow-up text is a metadata-marked wrapped external payload, and treats
 * marker-shaped user text lacking that metadata as a cancellation. Deterministic:
 * Map-backed runtime cache stub, no model or database.
 */
import { describe, expect, it } from "vitest";
import { wrapExternalContent } from "../security/external-content";
import type { IAgentRuntime, Memory, UUID } from "../types";
import { requireConfirmation } from "../utils/confirmation";

function createRuntimeStub(): IAgentRuntime {
	const cache = new Map<string, unknown>();
	return {
		getCache: async <T>(key: string) => (cache.get(key) as T) ?? null,
		setCache: async <T>(key: string, value: T) => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string) => cache.delete(key),
	} as unknown as IAgentRuntime;
}

function message(text: string, metadata?: Record<string, unknown>): Memory {
	return {
		id: "message-id" as UUID,
		entityId: "user-id" as UUID,
		roomId: "room-id" as UUID,
		agentId: "agent-id" as UUID,
		content: { text, source: "api", metadata },
		createdAt: Date.now(),
	} as Memory;
}

describe("requireConfirmation", () => {
	it("confirms wrapped external follow-up text by evaluating the payload", async () => {
		const runtime = createRuntimeStub();
		const args = {
			runtime,
			actionName: "SKILL",
			pendingKey: "uninstall:registry-weather",
			prompt: "Uninstall registry-weather?",
			metadata: { slug: "registry-weather" },
		};

		await expect(
			requireConfirmation({
				...args,
				message: message('Uninstall skill "registry-weather"'),
			}),
		).resolves.toEqual({ status: "pending" });

		const wrappedYes = wrapExternalContent(
			'yes, run skill uninstall for "registry-weather"',
			{ source: "api" },
		);

		await expect(
			requireConfirmation({
				...args,
				message: message(wrappedYes, { externalContentWrapped: true }),
			}),
		).resolves.toEqual({
			status: "confirmed",
			metadata: { slug: "registry-weather" },
		});
	});

	it("does not treat marker-shaped user text as wrapped without metadata", async () => {
		const runtime = createRuntimeStub();
		const args = {
			runtime,
			actionName: "SKILL",
			pendingKey: "uninstall:registry-weather",
			prompt: "Uninstall registry-weather?",
		};

		await expect(
			requireConfirmation({
				...args,
				message: message('Uninstall skill "registry-weather"'),
			}),
		).resolves.toEqual({ status: "pending" });

		const markerText = wrapExternalContent(
			'yes, run skill uninstall for "registry-weather"',
			{ source: "api" },
		);

		await expect(
			requireConfirmation({
				...args,
				message: message(markerText),
			}),
		).resolves.toEqual({ status: "cancelled", metadata: undefined });
	});
});
