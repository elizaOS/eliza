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

	it("bounds concurrent entity lookups while still naming every contact (#30896)", async () => {
		const contactCount = 64;
		const mockContacts = Array.from({ length: contactCount }, (_unused, i) => ({
			entityId: `entity-${i}` as UUID,
			categories: [i % 2 === 0 ? "friend" : "colleague"],
			tags: [],
			customFields: {},
			preferences: {},
			lastModified: 1000 + i,
		}));
		const relationshipsService = {
			searchContacts: vi.fn().mockResolvedValue(mockContacts),
		};

		let inFlight = 0;
		let peakInFlight = 0;
		const releases: Array<() => void> = [];
		const runtime = {
			getService: vi.fn().mockReturnValue(relationshipsService),
			getEntityById: vi.fn(async (id: string) => {
				inFlight += 1;
				peakInFlight = Math.max(peakInFlight, inFlight);
				await new Promise<void>((resolve) => {
					releases.push(resolve);
				});
				inFlight -= 1;
				return { names: [`Name ${id}`] };
			}),
			logger: { warn: vi.fn(), error: vi.fn() },
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;

		const pending = advancedContactsProvider.get(
			runtime,
			dummyMessage,
			dummyState,
		);

		// Drain the gate until every lookup has been admitted and released.
		let released = 0;
		while (released < contactCount) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			while (releases.length > 0) {
				releases.shift()?.();
				released += 1;
			}
		}
		const result = await pending;

		expect(runtime.getEntityById).toHaveBeenCalledTimes(contactCount);
		expect(peakInFlight).toBe(8);
		expect(result.values?.contactCount).toBe(contactCount);
		expect(result.values?.friend).toBe(contactCount / 2);
		expect(result.values?.colleague).toBe(contactCount / 2);
		for (let i = 0; i < contactCount; i += 1) {
			expect(result.text).toContain(`Name entity-${i}`);
		}
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
