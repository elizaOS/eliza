/**
 * Unit tests for applying and persisting partial character patches.
 */

import { describe, expect, it, vi } from "vitest";
import type { Character, IAgentRuntime } from "../../../../../types/index.js";
import { persistCharacterPatch } from "./persist-character-patch.js";

describe("persist-character-patch", () => {
	it("returns early when patch is empty", async () => {
		const runtime = {
			character: { name: "Eliza" } as Character,
		} as unknown as IAgentRuntime;

		const result = await persistCharacterPatch(runtime, {});
		expect(result).toEqual({ success: true });
		expect(runtime.character.name).toBe("Eliza");
	});

	it("persists character patch when persistence service is present", async () => {
		const persistMock = vi.fn().mockResolvedValue({ success: true });
		const persistenceService = {
			persistCharacter: persistMock,
		};

		const runtime = {
			character: {
				name: "Eliza",
				bio: ["Original bio"],
			} as Character,
			getService: vi.fn().mockImplementation((name: string) => {
				if (name === "eliza_character_persistence") return persistenceService;
				return null;
			}),
		} as unknown as IAgentRuntime;

		const patch: Partial<Character> = {
			bio: ["Updated bio"],
		};

		const result = await persistCharacterPatch(runtime, patch);
		expect(result.success).toBe(true);
		expect(persistMock).toHaveBeenCalledWith(
			expect.objectContaining({
				character: expect.objectContaining({
					name: "Eliza",
					bio: ["Updated bio"],
				}),
				previousName: "Eliza",
				source: "agent",
			}),
		);
		expect(runtime.character.bio).toEqual(["Updated bio"]);
	});

	it("fails and does not mutate runtime character when persistence fails", async () => {
		const persistMock = vi
			.fn()
			.mockResolvedValue({ success: false, error: "Disk full" });
		const persistenceService = {
			persistCharacter: persistMock,
		};

		const runtime = {
			character: {
				name: "Eliza",
				bio: ["Original bio"],
			} as Character,
			getService: vi.fn().mockImplementation((name: string) => {
				if (name === "eliza_character_persistence") return persistenceService;
				return null;
			}),
		} as unknown as IAgentRuntime;

		const patch: Partial<Character> = {
			bio: ["Will not be applied"],
		};

		const result = await persistCharacterPatch(runtime, patch);
		expect(result.success).toBe(false);
		expect(result.error).toBe("Disk full");
		expect(runtime.character.bio).toEqual(["Original bio"]);
	});
});
