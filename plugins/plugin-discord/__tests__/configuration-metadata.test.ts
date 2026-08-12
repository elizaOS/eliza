/** Verifies the Discord connector configuration fields exposed to agent UIs. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = resolve(import.meta.dirname, "..");
const packageManifest = JSON.parse(
	readFileSync(resolve(pluginRoot, "package.json"), "utf8"),
) as {
	agentConfig?: {
		pluginParameters?: Record<string, Record<string, unknown>>;
		configUiHints?: Record<string, Record<string, unknown>>;
	};
};
const registryEntry = JSON.parse(
	readFileSync(resolve(pluginRoot, "registry-entry.json"), "utf8"),
) as { config?: Record<string, Record<string, unknown>> };

const ownershipKeys = [
	"ELIZA_DISCORD_OWNER_USER_IDS_JSON",
	"DISCORD_DM_POLICY",
	"DISCORD_ALLOW_FROM",
] as const;

describe("Discord ownership configuration metadata", () => {
	it("exposes owner and DM controls to the agent plugin form", () => {
		const parameters = packageManifest.agentConfig?.pluginParameters ?? {};
		const hints = packageManifest.agentConfig?.configUiHints ?? {};

		for (const key of ownershipKeys) {
			expect(parameters[key]).toMatchObject({
				type: "string",
				required: false,
				sensitive: false,
			});
			expect(hints[key]).toMatchObject({ group: "access" });
		}
		expect(parameters.DISCORD_DM_POLICY?.options).toEqual([
			"pairing",
			"allowlist",
			"open",
			"disabled",
		]);
		expect(hints.ELIZA_DISCORD_OWNER_USER_IDS_JSON?.type).toBe("json");
	});

	it("keeps the registry configuration surface in sync", () => {
		const config = registryEntry.config ?? {};

		expect(config.ELIZA_DISCORD_OWNER_USER_IDS_JSON).toMatchObject({
			type: "json",
			required: false,
			sensitive: false,
		});
		expect(config.DISCORD_DM_POLICY).toMatchObject({
			type: "select",
			required: false,
			sensitive: false,
		});
		expect(config.DISCORD_DM_POLICY?.options).toEqual([
			{ value: "pairing", label: "Pairing" },
			{ value: "allowlist", label: "Allowlist" },
			{ value: "open", label: "Open" },
			{ value: "disabled", label: "Disabled" },
		]);
		expect(config.DISCORD_ALLOW_FROM).toMatchObject({
			type: "string",
			required: false,
			sensitive: false,
		});
	});
});
