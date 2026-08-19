/**
 * Pins the DOCUMENT import_file host-filesystem authorization boundary. The
 * deterministic handler harness proves ordinary users are rejected before any
 * path probe while OWNER and agent-self callers can proceed to the normal
 * not-found boundary; it never reads a live host file.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	SearchCategoryRegistration,
	UUID,
} from "../../types";
import { documentAction } from "./actions.ts";
import { DocumentService } from "./service.ts";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-00000000face" as UUID;
const MISSING_PATH = "/definitely-not-present/eliza-document-import.md";

function makeMessage(entityId: UUID = USER_ID): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000aa" as UUID,
		entityId,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "import a local document" },
		createdAt: Date.now(),
	} as Memory;
}

function makeRuntime(role: "USER" | "OWNER"): IAgentRuntime {
	const categories = new Map<string, SearchCategoryRegistration>();
	const service = {
		addDocument: vi.fn(async () => {
			throw new Error("addDocument must not run for the missing fixture path");
		}),
	};
	return {
		agentId: AGENT_ID,
		getService: vi.fn(<T>(type: string): T | null =>
			type === DocumentService.serviceType ? (service as unknown as T) : null,
		),
		registerSearchCategory: vi.fn((reg: SearchCategoryRegistration) => {
			categories.set(reg.category, reg);
		}),
		getSearchCategory: vi.fn((category: string) => {
			const found = categories.get(category);
			if (!found) throw new Error(`unknown category ${category}`);
			return found;
		}),
		getSetting: vi.fn((key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" && role === "OWNER" ? USER_ID : undefined,
		),
		getRoom: vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID })),
		getWorld: vi.fn(async () => ({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: { roles: { [USER_ID]: role } },
		})),
		getRoomsForParticipants: vi.fn(async () => {
			throw new Error("room lookup is unavailable");
		}),
		reportError: vi.fn(),
		useModel: vi.fn(async () => {
			throw new Error("useModel must not run on the planner-trust path");
		}),
	} as unknown as IAgentRuntime;
}

async function importMissingFile(runtime: IAgentRuntime, message: Memory) {
	return documentAction.handler?.(runtime, message, undefined, {
		parameters: { action: "import_file", filePath: MISSING_PATH },
	} as HandlerOptions);
}

describe("DOCUMENT import_file local-host role gate", () => {
	it("rejects a USER before probing the supplied host path", async () => {
		const response = await importMissingFile(
			makeRuntime("USER"),
			makeMessage(),
		);
		expect(response?.success).toBe(false);
		expect(response?.values).toMatchObject({ error: "forbidden" });
	});

	it("allows an OWNER to reach the ordinary path boundary", async () => {
		const response = await importMissingFile(
			makeRuntime("OWNER"),
			makeMessage(),
		);
		expect(response?.success).toBe(false);
		expect(response?.values).toMatchObject({ error: "not_found" });
	});

	it("allows the agent runtime to reach the ordinary path boundary", async () => {
		const response = await importMissingFile(
			makeRuntime("USER"),
			makeMessage(AGENT_ID),
		);
		expect(response?.success).toBe(false);
		expect(response?.values).toMatchObject({ error: "not_found" });
	});
});
