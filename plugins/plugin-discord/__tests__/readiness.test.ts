import { describe, expect, it } from "vitest";
import { waitForDiscordIngressReadiness } from "../readiness";

describe("waitForDiscordIngressReadiness", () => {
	it("fails closed instead of deadlocking when ready-time hydration never settles", async () => {
		const neverReady = new Promise<void>(() => undefined);

		await expect(waitForDiscordIngressReadiness(neverReady, 5)).rejects.toThrow(
			"identity hydration timed out after 5ms",
		);
	});

	it("allows ingress after hydration resolves", async () => {
		await expect(
			waitForDiscordIngressReadiness(Promise.resolve(), 5),
		).resolves.toBeUndefined();
	});
});
