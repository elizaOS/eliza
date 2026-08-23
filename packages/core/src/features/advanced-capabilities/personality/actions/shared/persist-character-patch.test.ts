/**
 * Exercises the shared personality character-patch write path with deterministic
 * persistence-service fakes, including mutation ordering and failure handling.
 */
import { describe, expect, it, vi } from "vitest";
import type { Character, IAgentRuntime } from "../../../../../types/index.ts";
import type { CharacterPersistenceServiceLike } from "../../character-persistence.ts";
import { persistCharacterPatch } from "./persist-character-patch.ts";

function createRuntime(
	character: Character,
	service: CharacterPersistenceServiceLike | null,
): IAgentRuntime {
	return {
		character,
		getService: vi.fn(() => service),
	} as unknown as IAgentRuntime;
}

describe("persistCharacterPatch", () => {
	it("short-circuits an empty patch without looking up persistence", async () => {
		const character: Character = { name: "Original", bio: ["unchanged"] };
		const runtime = createRuntime(character, null);

		await expect(persistCharacterPatch(runtime, {})).resolves.toEqual({
			success: true,
		});
		expect(runtime.getService).not.toHaveBeenCalled();
		expect(runtime.character).toEqual(character);
	});

	it("applies a shallow replacement when no persistence service is registered", async () => {
		const originalStyle = { all: ["warm"], chat: ["brief"] };
		const replacementStyle = { all: ["direct"] };
		const character: Character = { name: "Original", style: originalStyle };
		const runtime = createRuntime(character, null);

		await expect(
			persistCharacterPatch(runtime, {
				name: "Updated",
				style: replacementStyle,
			}),
		).resolves.toEqual({ success: true });
		expect(runtime.character).toBe(character);
		expect(runtime.character).toEqual({
			name: "Updated",
			style: replacementStyle,
		});
		expect(runtime.character.style).not.toBe(originalStyle);
	});

	it("persists complete before-and-after snapshots before mutating the live character", async () => {
		const character: Character = {
			name: "Original",
			bio: ["before"],
			topics: ["existing"],
		};
		let runtime: IAgentRuntime;
		const persistCharacter = vi.fn(async () => {
			expect(runtime.character).toEqual(character);
			return { success: true };
		});
		const service: CharacterPersistenceServiceLike = { persistCharacter };
		runtime = createRuntime(character, service);

		await expect(
			persistCharacterPatch(runtime, {
				bio: ["after"],
				topics: [],
			}),
		).resolves.toEqual({ success: true });
		expect(persistCharacter).toHaveBeenCalledWith({
			character: {
				name: "Original",
				bio: ["after"],
				topics: [],
			},
			previousCharacter: {
				name: "Original",
				bio: ["before"],
				topics: ["existing"],
			},
			previousName: "Original",
			source: "agent",
		});
		expect(runtime.character).toEqual({
			name: "Original",
			bio: ["after"],
			topics: [],
		});
	});

	it("returns a persistence failure without mutating the live character", async () => {
		const character: Character = { name: "Original", bio: ["before"] };
		const failure = { success: false, error: "disk unavailable" };
		const service: CharacterPersistenceServiceLike = {
			persistCharacter: vi.fn(async () => failure),
		};
		const runtime = createRuntime(character, service);

		await expect(
			persistCharacterPatch(runtime, { name: "Rejected", bio: ["after"] }),
		).resolves.toBe(failure);
		expect(runtime.character).toEqual({ name: "Original", bio: ["before"] });
	});

	it("omits previousName when the live character name is not a string", async () => {
		const character = { name: 42, bio: ["before"] } as unknown as Character;
		const persistCharacter = vi.fn(async () => ({ success: true }));
		const runtime = createRuntime(character, { persistCharacter });

		await persistCharacterPatch(runtime, { bio: ["after"] });

		expect(persistCharacter).toHaveBeenCalledWith(
			expect.objectContaining({ previousName: undefined }),
		);
	});
});
