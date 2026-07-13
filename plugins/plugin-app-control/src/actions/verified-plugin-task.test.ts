/**
 * Coding-task handoff contract for plugin create and edit operations.
 */

import { describe, expect, it } from "vitest";
import { buildVerifiedPluginTaskParameters } from "./verified-plugin-task";

describe("buildVerifiedPluginTaskParameters", () => {
	it("locks execution and verification to the plugin source directory", () => {
		const parameters = buildVerifiedPluginTaskParameters({
			task: "build the view",
			label: "create-view:proof",
			workdir: "/state/plugins/plugin-proof",
			pluginName: "proof",
			originRoomId: "room-1",
		});

		expect(parameters).toMatchObject({
			workdir: "/state/plugins/plugin-proof",
			lockWorkdir: true,
			keepAliveAfterComplete: true,
			validator: {
				service: "app-verification",
				method: "verifyPlugin",
				params: {
					workdir: "/state/plugins/plugin-proof",
					pluginName: "proof",
					profile: "full",
				},
			},
		});
	});
});
