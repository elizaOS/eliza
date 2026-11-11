import { describe, expect, it } from "vitest";
import { flattenRuntimeSettings } from "../src/runtime-settings";
import type { Character } from "../src/types/agent";

describe("flattenRuntimeSettings nested values", () => {
	it("JSON-encodes object settings instead of [object Object]", () => {
		const character = {
			name: "nested-settings",
			settings: {
				ROUTE_POLICY: { default: "owner", allow: ["a", "b"] },
			},
		} as unknown as Character;

		expect(flattenRuntimeSettings(character, {}).ROUTE_POLICY).toBe(
			'{"default":"owner","allow":["a","b"]}',
		);
	});

	it("JSON-encodes array settings instead of comma-joining them", () => {
		const character = {
			name: "array-settings",
			settings: { HOSTS: ["one", "two"] },
		} as unknown as Character;

		expect(flattenRuntimeSettings(character, {}).HOSTS).toBe('["one","two"]');
	});

	it("JSON-encodes object secret-store entries instead of destroying them", () => {
		const character = {
			name: "object-secret",
			settings: {
				secrets: {
					STORED_TOKEN: {
						value: "stored-plain-value",
						config: { level: "global", encrypted: false },
					},
				},
			},
		} as unknown as Character;

		expect(flattenRuntimeSettings(character, {}).STORED_TOKEN).toBe(
			'{"value":"stored-plain-value","config":{"level":"global","encrypted":false}}',
		);
	});

	it("keeps plain strings, numbers, and booleans as before", () => {
		const character = {
			name: "plain-settings",
			settings: { NAME: "plain", COUNT: 3, FLAG: true },
			secrets: { TOKEN: "secret-value" },
		} as unknown as Character;

		expect(flattenRuntimeSettings(character, {})).toMatchObject({
			NAME: "plain",
			COUNT: "3",
			FLAG: "true",
			TOKEN: "secret-value",
		});
	});
});
