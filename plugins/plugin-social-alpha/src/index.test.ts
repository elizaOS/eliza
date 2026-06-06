import { describe, expect, it } from "vitest";

import socialAlphaPlugin from "./index";
import { socialAlphaProvider } from "./providers/socialAlphaProvider";
import { CommunityInvestorService } from "./service";

describe("socialAlphaPlugin", () => {
	it("registers its core runtime surfaces", () => {
		expect(socialAlphaPlugin.name).toBe("social-alpha");
		expect(socialAlphaPlugin.providers).toContain(socialAlphaProvider);
		expect(socialAlphaPlugin.services).toContain(CommunityInvestorService);
		expect(Array.isArray(socialAlphaPlugin.routes)).toBe(true);
	});

	it("declares the Social Alpha leaderboard view", () => {
		expect(socialAlphaPlugin.views).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "social-alpha",
					label: "Social Alpha",
					bundlePath: "dist/views/bundle.js",
					componentExport: "SocialAlphaView",
				}),
			]),
		);
	});
});
