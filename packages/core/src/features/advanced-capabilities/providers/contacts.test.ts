/**
 * Unit tests for advanced contacts provider grouping, categorization, and graceful error degradation.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.js";
import { advancedContactsProvider } from "./contacts.js";

describe("advancedContactsProvider", () => {
	const dummyMessage = { roomId: "room-1" as UUID } as Memory;
	const dummyState = {} as State;

	it("returns empty result when RelationshipsService is unavailable", async () => {
		const runtime = {
			getService: vi.fn().mockReturnValue(null),
			logger: { warn: vi.fn() },
		} as unknown as IAgentRuntime;

		const result = await advancedContactsProvider.get(
			runtime,
			dummyMessage,
			dummyState,
		);
		expect(result.text).toBe("");
		expect(result.values).toEqual({});
	});

	it("returns no contacts message when searchContacts returns empty list", async () => {
		const relationshipsService = {
			searchContacts: vi.fn().mockResolvedValue([]),
		};
		const runtime = {
			getService: vi.fn().mockReturnValue(relationshipsService),
		} as unknown as IAgentRuntime;

		const result = await advancedContactsProvider.get(
			runtime,
			dummyMessage,
			dummyState,
		);
		expect(result.text).toBe("No contacts in relationships.");
		expect(result.values).toEqual({ contactCount: 0 });
	});

	it("formats and groups contacts by category with tags and details", async () => {
		const mockContacts = [
			{
				entityId: "ent-1" as UUID,
				categories: ["friend"],
				tags: ["close", "tennis"],
				customFields: { displayName: "Alice Smith" },
				preferences: {},
				lastModified: 1000,
			},
			{
				entityId: "ent-2" as UUID,
				categories: ["colleague"],
				tags: ["work"],
				customFields: {},
				preferences: {},
				lastModified: 1000,
			},
		];

		const relationshipsService = {
			searchContacts: vi.fn().mockResolvedValue(mockContacts),
		};

		const runtime = {
			getService: vi.fn().mockReturnValue(relationshipsService),
			getEntityById: vi.fn().mockImplementation(async (id: string) => {
				if (id === "ent-2") return { names: ["Bob Developer"] };
				return null;
			}),
		} as unknown as IAgentRuntime;

		const result = await advancedContactsProvider.get(
			runtime,
			dummyMessage,
			dummyState,
		);
		expect(result.text).toContain("You have 2 contacts in your relationships:");
		expect(result.text).toContain("Friends (1):");
		expect(result.text).toContain("- Alice Smith [close, tennis]");
		expect(result.text).toContain("Colleagues (1):");
		expect(result.text).toContain("- Bob Developer [work]");

		expect(result.values).toEqual(
			expect.objectContaining({
				contactCount: 2,
				friend: 1,
				colleague: 1,
			}),
		);
	});

	it("reports error and degrades cleanly when searchContacts throws", async () => {
		const relationshipsService = {
			searchContacts: vi.fn().mockRejectedValue(new Error("Database offline")),
		};

		const runtime = {
			getService: vi.fn().mockReturnValue(relationshipsService),
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;

		const result = await advancedContactsProvider.get(
			runtime,
			dummyMessage,
			dummyState,
		);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"ContactsProvider.get",
			expect.any(Error),
			{ roomId: "room-1" },
		);
		expect(result.text).toBe("Contact context is unavailable.");
		expect(result.values).toEqual({ contactsAvailable: false });
	});
});
