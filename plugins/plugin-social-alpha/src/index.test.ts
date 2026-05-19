import { describe, expect, it } from "vitest";

import socialAlphaPlugin, { panels } from "./index";
import { socialAlphaProvider } from "./providers/socialAlphaProvider";
import { CommunityInvestorService } from "./service";

describe("socialAlphaPlugin", () => {
	it("registers its core runtime surfaces", () => {
		expect(socialAlphaPlugin.name).toBe("social-alpha");
		expect(socialAlphaPlugin.providers).toContain(socialAlphaProvider);
		expect(socialAlphaPlugin.services).toContain(CommunityInvestorService);
		expect(Array.isArray(socialAlphaPlugin.routes)).toBe(true);
	});

	it("exports the Social Alpha panel", () => {
		expect(panels).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "Social Alpha",
					path: "display",
					component: "LeaderboardPanelPage",
				}),
			]),
		);
	});
});
