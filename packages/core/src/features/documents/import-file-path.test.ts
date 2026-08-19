/**
 * Pins DOCUMENT import_file's host-path blocklist. Deterministic: uses a fake
 * home and real temp files/symlinks, then drives the real handler so a
 * USER-scoped import of the SSH credential home never reaches addDocument.
 * Does not read the operator's live secrets.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	SearchCategoryRegistration,
	UUID,
} from "../../types";
import { documentAction } from "./actions.ts";
import {
	defaultDocumentImportBlockedRoots,
	isBlockedDocumentImportPath,
} from "./import-file-path.ts";
import { DocumentService } from "./service.ts";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-00000000face" as UUID;

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000aa" as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text },
		createdAt: Date.now(),
	} as Memory;
}

function makeRuntime(service: {
	addDocument: ReturnType<typeof vi.fn>;
}): IAgentRuntime {
	const categories = new Map<string, SearchCategoryRegistration>();
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
			if (!found) {
				throw new Error(`unknown category ${category}`);
			}
			return found;
		}),
		getSetting: vi.fn(() => undefined),
		getRoom: vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID })),
		getWorld: vi.fn(async () => ({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: { roles: { [USER_ID]: "USER" } },
		})),
		getRoomsForParticipants: vi.fn(async () => {
			throw new Error("room lookup is unavailable");
		}),
		reportError: vi.fn(),
		useModel: vi.fn(async () => {
			throw new Error("useModel must not be called on the planner-trust path");
		}),
	} as unknown as IAgentRuntime;
}

describe("isBlockedDocumentImportPath", () => {
	it("blocks credential homes and OS-private roots", () => {
		const home = "/Users/fixture";
		expect(
			isBlockedDocumentImportPath(path.join(home, ".ssh", "id_rsa"), { home }),
		).toBe(true);
		expect(
			isBlockedDocumentImportPath(path.join(home, ".aws", "credentials"), {
				home,
			}),
		).toBe(true);
		expect(isBlockedDocumentImportPath("/etc/passwd", { home })).toBe(true);
		expect(isBlockedDocumentImportPath("/etc/shadow", { home })).toBe(true);
	});

	it("allows an ordinary workspace file", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "doc-import-ok-"));
		const file = path.join(dir, "notes.md");
		writeFileSync(file, "launch is friday");
		expect(
			isBlockedDocumentImportPath(file, { home: path.join(dir, "home") }),
		).toBe(false);
	});

	it("blocks a symlink whose realpath is a credential file", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "doc-import-link-"));
		const home = path.join(dir, "home");
		mkdirSync(path.join(home, ".ssh"), { recursive: true });
		const secret = path.join(home, ".ssh", "id_rsa");
		writeFileSync(secret, "SECRET");
		const decoy = path.join(dir, "notes.md");
		symlinkSync(secret, decoy);
		expect(isBlockedDocumentImportPath(decoy, { home })).toBe(true);
	});

	it("realpaths blocked roots so /etc and /private/etc agree", () => {
		const roots = defaultDocumentImportBlockedRoots("/Users/fixture");
		expect(roots).toContain("/etc");
		expect(isBlockedDocumentImportPath("/etc/passwd")).toBe(true);
	});
});

describe("DOCUMENT import_file handler path gate", () => {
	it("rejects the SSH credential home before addDocument on a USER-scoped import", async () => {
		const addDocument = vi.fn(async () => {
			throw new Error("addDocument must not run for a blocked import_file");
		});
		const res = await documentAction.handler?.(
			makeRuntime({ addDocument }),
			makeMessage("import my key"),
			undefined,
			{
				parameters: {
					action: "import_file",
					filePath: path.join(homedir(), ".ssh", "id_rsa"),
				},
			} as HandlerOptions,
		);
		expect(res?.success).toBe(false);
		expect(res?.values).toMatchObject({ error: "forbidden" });
		expect(addDocument).not.toHaveBeenCalled();
	});

	it("rejects /etc/passwd before addDocument", async () => {
		const addDocument = vi.fn(async () => {
			throw new Error("addDocument must not run for a blocked import_file");
		});
		const res = await documentAction.handler?.(
			makeRuntime({ addDocument }),
			makeMessage("import passwd"),
			undefined,
			{
				parameters: { action: "import_file", filePath: "/etc/passwd" },
			} as HandlerOptions,
		);
		expect(res?.success).toBe(false);
		expect(res?.values).toMatchObject({ error: "forbidden" });
		expect(addDocument).not.toHaveBeenCalled();
	});
});
