import { describe, expect, test } from "vitest";
import {
	resolveSensitiveRequestDelivery,
	sensitiveRequestEnvironmentFromSettings,
} from "./sensitive-request-policy";
import { ChannelType } from "./types/primitives";

describe("resolveSensitiveRequestDelivery", () => {
	test("keeps secret entry out of public rooms when no cloud or tunnel is available", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "secret",
			channelType: ChannelType.GROUP,
			environment: {
				dm: { available: true },
			},
		});

		expect(plan.mode).toBe("dm_or_owner_app_instruction");
		expect(plan.privateRouteRequired).toBe(true);
		expect(plan.publicLinkAllowed).toBe(false);
		expect(plan.canCollectValueInCurrentChannel).toBe(false);
	});

	test("uses owner-only inline app entry in private owner app chat", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "secret",
			channelType: ChannelType.DM,
			environment: {
				ownerApp: { privateChat: true },
			},
		});

		expect(plan.mode).toBe("inline_owner_app");
		expect(plan.authenticated).toBe(true);
		expect(plan.canCollectValueInCurrentChannel).toBe(true);
	});

	test("allows secret entry in private DMs when no authenticated link is available", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "secret",
			channelType: ChannelType.DM,
			environment: {
				dm: { available: true },
			},
		});

		expect(plan.mode).toBe("private_dm");
		expect(plan.canCollectValueInCurrentChannel).toBe(true);
		expect(plan.publicLinkAllowed).toBe(false);
	});

	test("uses cloud authenticated links for public verified-payer payment", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "payment",
			paymentContext: "verified_payer",
			channelType: ChannelType.GROUP,
			environment: {
				cloud: {
					available: true,
					baseUrl: "https://www.elizacloud.ai",
				},
			},
		});

		expect(plan.mode).toBe("cloud_authenticated_link");
		expect(plan.authenticated).toBe(true);
		expect(plan.publicLinkAllowed).toBe(true);
		expect(plan.policy.actor).toBe("verified_payer");
	});

	test("allows public links only for any-payer payment context", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "payment",
			paymentContext: "any_payer",
			channelType: ChannelType.GROUP,
			environment: {
				cloud: {
					available: true,
					baseUrl: "https://www.elizacloud.ai",
				},
			},
		});

		expect(plan.mode).toBe("public_link");
		expect(plan.publicLinkAllowed).toBe(true);
		expect(plan.policy.actor).toBe("any_payer");
	});

	test("refuses unauthenticated tunnel for secrets", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "secret",
			channelType: ChannelType.GROUP,
			environment: {
				tunnel: {
					available: true,
					url: "https://example-tunnel.ngrok.app",
					authenticated: false,
				},
			},
		});

		expect(plan.mode).toBe("dm_or_owner_app_instruction");
		expect(plan.reason).toContain("not authorized");
		expect(plan.linkBaseUrl).toBeUndefined();
	});

	test("uses authenticated tunnel links when cloud is unavailable", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "secret",
			channelType: ChannelType.GROUP,
			environment: {
				tunnel: {
					available: true,
					url: "https://example-tunnel.ngrok.app",
					authenticated: true,
				},
			},
		});

		expect(plan.mode).toBe("tunnel_authenticated_link");
		expect(plan.authenticated).toBe(true);
		expect(plan.linkBaseUrl).toBe("https://example-tunnel.ngrok.app");
	});
});

describe("sensitiveRequestEnvironmentFromSettings", () => {
	test("requires cloud api key and enabled setting for cloud availability", () => {
		expect(
			sensitiveRequestEnvironmentFromSettings({
				cloudApiKey: "ck_test",
				cloudEnabled: "true",
				cloudBaseUrl: "https://www.elizacloud.ai",
			}).cloud,
		).toEqual({
			available: true,
			baseUrl: "https://www.elizacloud.ai",
		});

		expect(
			sensitiveRequestEnvironmentFromSettings({
				cloudApiKey: "ck_test",
				cloudEnabled: "false",
				cloudBaseUrl: "https://www.elizacloud.ai",
			}).cloud?.available,
		).toBe(false);
	});
});
