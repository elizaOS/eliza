/**
 * Exercises filesystem document loading with temporary directories, including
 * a real owner-gated DOCUMENT import through DocumentService and PGLite
 * persistence. Narrow loader cases use a recording service for traversal and
 * normalization assertions that do not involve authorization or storage.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../runtime.ts";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import {
	ChannelType,
	type HandlerOptions,
	type Memory,
	type UUID,
} from "../../types";
import { documentAction } from "./actions.ts";
import {
	addDocumentFromFilePath,
	getDocumentFileContentType,
	getDocumentsPath,
	loadDocumentsFromPath,
} from "./docs-loader.ts";
import { documentsPlugin } from "./index.ts";
import { DocumentService } from "./service.ts";
import type { AddDocumentOptions } from "./types.ts";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const storedDocumentMemoryId = "00000000-0000-0000-0000-000000000002" as UUID;
const ownerId = "f4320000-0000-4000-8000-000000000001" as UUID;
const userId = "f4320000-0000-4000-8000-000000000002" as UUID;
const worldId = "f4320000-0000-4000-8000-000000000003" as UUID;
const roomId = "f4320000-0000-4000-8000-000000000004" as UUID;
const temporaryDirectories: string[] = [];
const originalDocumentsPath = process.env.DOCUMENTS_PATH;
let integrationRuntime: AgentRuntime;
let integrationService: DocumentService;
let cleanupIntegrationRuntime: (() => Promise<void>) | undefined;

function makeTemporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "docs-loader-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function makeService(failingFilename?: string) {
	const added: AddDocumentOptions[] = [];
	const reported: Array<{
		scope: string;
		error: unknown;
		context?: Record<string, unknown>;
	}> = [];

	return {
		added,
		reported,
		reportError(
			scope: string,
			error: unknown,
			context?: Record<string, unknown>,
		) {
			reported.push({ scope, error, context });
		},
		async addDocument(options: AddDocumentOptions) {
			if (options.originalFilename === failingFilename) {
				throw new Error(`rejected ${failingFilename}`);
			}
			added.push(options);
			return {
				clientDocumentId: options.clientDocumentId,
				storedDocumentMemoryId,
				fragmentCount: 1,
			};
		},
	};
}

function importMessage(entityId: UUID): Memory {
	return {
		id: crypto.randomUUID() as UUID,
		agentId: integrationRuntime.agentId,
		entityId,
		roomId,
		worldId,
		content: {
			text: "import the local release evidence",
			source: "test",
			channelType: ChannelType.DM,
		},
		createdAt: Date.now(),
	};
}

async function persistedRowCounts(): Promise<{
	documents: number;
	fragments: number;
}> {
	const [documents, fragments] = await Promise.all([
		integrationRuntime.getMemories({
			tableName: "documents",
			agentId: integrationRuntime.agentId,
			count: 100,
		}),
		integrationRuntime.getMemories({
			tableName: "document_fragments",
			agentId: integrationRuntime.agentId,
			count: 100,
		}),
	]);
	return { documents: documents.length, fragments: fragments.length };
}

beforeAll(async () => {
	const created = await createTestRuntime({
		characterName: "DocumentLoaderOwnerImportTest",
		plugins: [documentsPlugin],
	});
	integrationRuntime = created.runtime;
	cleanupIntegrationRuntime = created.cleanup;
	integrationRuntime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId);
	integrationService = (await integrationRuntime.getServiceLoadPromise(
		DocumentService.serviceType,
	)) as DocumentService;

	for (const [entityId, name] of [
		[ownerId, "Document owner"],
		[userId, "Ordinary user"],
	] as const) {
		await integrationRuntime.ensureConnection({
			entityId,
			roomId,
			worldId,
			worldName: "Document loader integration",
			userName: name,
			name,
			source: "test",
			type: ChannelType.DM,
		});
	}
	await integrationRuntime.ensureWorldExists({
		id: worldId,
		name: "Document loader integration",
		agentId: integrationRuntime.agentId,
		metadata: {
			roles: { [ownerId]: "OWNER", [userId]: "USER" },
			roleSources: { [ownerId]: "owner", [userId]: "manual" },
		},
	});
}, 120_000);

afterAll(async () => {
	await cleanupIntegrationRuntime?.();
}, 120_000);

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}

	if (originalDocumentsPath === undefined) {
		delete process.env.DOCUMENTS_PATH;
	} else {
		process.env.DOCUMENTS_PATH = originalDocumentsPath;
	}
});

describe("getDocumentsPath", () => {
	it("resolves runtime, environment, and cwd defaults in precedence order", () => {
		const runtimePath = makeTemporaryDirectory();
		const environmentPath = makeTemporaryDirectory();
		process.env.DOCUMENTS_PATH = environmentPath;

		expect(getDocumentsPath(runtimePath)).toBe(path.resolve(runtimePath));
		expect(getDocumentsPath()).toBe(path.resolve(environmentPath));

		delete process.env.DOCUMENTS_PATH;
		expect(getDocumentsPath()).toBe(path.resolve(process.cwd(), "docs"));
	});
});

describe("getDocumentFileContentType", () => {
	it.each([
		[".txt", "text/plain"],
		[".markdown", "text/markdown"],
		[".tsx", "text/typescript"],
		[".R", "text/x-r"],
		[
			".docx",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		],
		[".unknown", null],
		["", null],
	] as const)("maps %s to %s", (extension, expected) => {
		expect(getDocumentFileContentType(extension)).toBe(expected);
	});
});

describe("addDocumentFromFilePath", () => {
	it("reads text and forwards normalized defaults and metadata", async () => {
		const directory = makeTemporaryDirectory();
		const filePath = path.join(directory, "release.notes.MD");
		fs.writeFileSync(filePath, "# Release notes\nComplete text");
		const service = makeService();

		const result = await addDocumentFromFilePath({
			service,
			agentId,
			filePath,
			metadata: { custom: true, title: "caller title", fileSize: -1 },
		});

		expect(result).toEqual({
			clientDocumentId: "",
			storedDocumentMemoryId,
			fragmentCount: 1,
		});
		expect(service.added).toHaveLength(1);
		expect(service.added[0]).toMatchObject({
			agentId,
			worldId: agentId,
			roomId: agentId,
			entityId: agentId,
			contentType: "text/markdown",
			originalFilename: "release.notes.MD",
			content: "# Release notes\nComplete text",
			metadata: {
				custom: true,
				path: filePath,
				filename: "release.notes.MD",
				originalFilename: "release.notes.MD",
				title: "release.notes",
				fileExt: "md",
				fileType: "text/markdown",
				contentType: "text/markdown",
				fileSize: Buffer.byteLength("# Release notes\nComplete text"),
				textBacked: true,
			},
		});
	});

	it("base64-encodes binary files and preserves explicit scope identifiers", async () => {
		const directory = makeTemporaryDirectory();
		const filePath = path.join(directory, "sample.PDF");
		const bytes = Buffer.from([0, 1, 2, 255]);
		fs.writeFileSync(filePath, bytes);
		const service = makeService();
		const worldId = "00000000-0000-0000-0000-000000000003" as UUID;
		const roomId = "00000000-0000-0000-0000-000000000004" as UUID;
		const entityId = "00000000-0000-0000-0000-000000000005" as UUID;

		await addDocumentFromFilePath({
			service,
			agentId,
			worldId,
			roomId,
			entityId,
			filePath,
		});

		expect(service.added[0]).toMatchObject({
			worldId,
			roomId,
			entityId,
			contentType: "application/pdf",
			content: bytes.toString("base64"),
			metadata: { fileExt: "pdf", fileSize: 4, textBacked: false },
		});
	});

	it.each([
		["agentId", ""],
		["agentId", "not-a-uuid"],
		["worldId", ""],
		["worldId", "not-a-uuid"],
		["roomId", ""],
		["roomId", "not-a-uuid"],
		["entityId", ""],
		["entityId", "00000000-0000-0000-0000-invalid-uuid"],
	] as const)(
		"rejects invalid %s before reading file bytes",
		async (field, value) => {
			const directory = makeTemporaryDirectory();
			const filePath = path.join(directory, "missing.txt");
			const service = makeService();
			const options: Parameters<typeof addDocumentFromFilePath>[0] = {
				service,
				agentId,
				filePath,
			};
			Object.assign(options, { [field]: value });

			await expect(addDocumentFromFilePath(options)).rejects.toMatchObject({
				name: "ElizaError",
				code: "DOCUMENT_SCOPE_ID_INVALID",
				message: `Document ${field} must be a valid UUID`,
				context: { field, value },
			});
			expect(fs.existsSync(filePath)).toBe(false);
			expect(service.added).toHaveLength(0);
		},
	);

	it("rejects unsupported extensions before calling the service", async () => {
		const directory = makeTemporaryDirectory();
		const filePath = path.join(directory, "archive.bin");
		fs.writeFileSync(filePath, "data");
		const service = makeService();

		await expect(
			addDocumentFromFilePath({ service, agentId, filePath }),
		).rejects.toThrow(`Unsupported document file type: ${filePath}`);
		expect(service.added).toHaveLength(0);
	});
});

describe("loadDocumentsFromPath", () => {
	it.each([
		["agentId", ""],
		["worldId", "not-a-uuid"],
		["roomId", ""],
		["entityId", "not-a-uuid"],
	] as const)(
		"rejects invalid %s before resolving the documents path",
		async (field, value) => {
			const directory = makeTemporaryDirectory();
			const missing = path.join(directory, "missing");
			const service = makeService();
			const parameters: unknown[] = [service, agentId, undefined, missing];

			if (field === "agentId") parameters[1] = value;
			if (field === "worldId") parameters[2] = value;
			if (field === "roomId") parameters[4] = { roomId: value };
			if (field === "entityId") parameters[4] = { entityId: value };

			await expect(
				Reflect.apply(loadDocumentsFromPath, undefined, parameters),
			).rejects.toMatchObject({
				name: "ElizaError",
				code: "DOCUMENT_SCOPE_ID_INVALID",
				message: `Document ${field} must be a valid UUID`,
				context: { field, value },
			});
			expect(service.added).toHaveLength(0);
			expect(service.reported).toHaveLength(0);
		},
	);

	it("returns empty counts for missing and empty directories", async () => {
		const directory = makeTemporaryDirectory();
		const missing = path.join(directory, "missing");
		const service = makeService();

		await expect(
			loadDocumentsFromPath(service, agentId, undefined, missing),
		).resolves.toEqual({ total: 0, successful: 0, failed: 0 });
		await expect(
			loadDocumentsFromPath(service, agentId, undefined, directory),
		).resolves.toEqual({ total: 0, successful: 0, failed: 0 });
	});

	it("recurses, skips excluded directories and dotfiles, and forwards options", async () => {
		const directory = makeTemporaryDirectory();
		const nested = path.join(directory, "nested");
		const ignored = path.join(directory, "node_modules");
		fs.mkdirSync(nested);
		fs.mkdirSync(ignored);
		fs.writeFileSync(path.join(directory, "root.txt"), "root");
		fs.writeFileSync(path.join(nested, "child.md"), "child");
		fs.writeFileSync(path.join(directory, ".secret.txt"), "secret");
		fs.writeFileSync(path.join(ignored, "ignored.txt"), "ignored");
		const service = makeService();
		const roomId = "00000000-0000-0000-0000-000000000005" as UUID;

		await expect(
			loadDocumentsFromPath(service, agentId, undefined, directory, {
				roomId,
				metadata: { source: "fixture" },
			}),
		).resolves.toEqual({ total: 3, successful: 2, failed: 0 });
		expect(service.added.map((item) => item.originalFilename).sort()).toEqual([
			"child.md",
			"root.txt",
		]);
		expect(service.added).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					roomId,
					metadata: expect.objectContaining({ source: "fixture" }),
				}),
			]),
		);
	});

	it("continues after a file failure and reports the rejected path", async () => {
		const directory = makeTemporaryDirectory();
		const goodPath = path.join(directory, "good.txt");
		const badPath = path.join(directory, "bad.txt");
		fs.writeFileSync(goodPath, "good");
		fs.writeFileSync(badPath, "bad");
		const service = makeService("bad.txt");

		await expect(
			loadDocumentsFromPath(service, agentId, undefined, directory),
		).resolves.toEqual({ total: 2, successful: 1, failed: 1 });
		expect(service.added[0]?.originalFilename).toBe("good.txt");
		expect(service.reported).toHaveLength(1);
		expect(service.reported[0]).toMatchObject({
			scope: "DocumentsLoader.processFile",
			context: { filePath: badPath },
		});
		expect(service.reported[0]?.error).toEqual(new Error("rejected bad.txt"));
	});

	it("rejects with the filesystem cause when the traversal root is not a directory", async () => {
		const directory = makeTemporaryDirectory();
		const filePath = path.join(directory, "not-a-directory.txt");
		fs.writeFileSync(filePath, "text");

		await expect(
			loadDocumentsFromPath(makeService(), agentId, undefined, filePath),
		).rejects.toThrow(`Failed to read document directory ${filePath}`);
	});
});

describe("DOCUMENT import_file persistence boundary", () => {
	it("fails invalid IDs before file access, denies a non-owner, and stores a queryable owner import", async () => {
		const directory = makeTemporaryDirectory();
		const missingPath = path.join(directory, "missing.md");

		await expect(
			addDocumentFromFilePath({
				service: integrationService,
				agentId: integrationRuntime.agentId,
				worldId: "not-a-uuid" as UUID,
				roomId,
				entityId: ownerId,
				filePath: missingPath,
			}),
		).rejects.toMatchObject({
			name: "ElizaError",
			code: "DOCUMENT_SCOPE_ID_INVALID",
			context: { field: "worldId", value: "not-a-uuid" },
		});
		expect(fs.existsSync(missingPath)).toBe(false);
		expect(await persistedRowCounts()).toEqual({ documents: 0, fragments: 0 });

		const filePath = path.join(directory, "owner-import.md");
		const content = "Owner import persistence needle 26336";
		fs.writeFileSync(filePath, content);
		const handlerOptions = {
			parameters: { action: "import_file", filePath },
		} as HandlerOptions;

		const denied = await documentAction.handler?.(
			integrationRuntime,
			importMessage(userId),
			undefined,
			handlerOptions,
		);
		expect(denied?.success).toBe(false);
		expect(denied?.values).toMatchObject({ error: "forbidden" });
		expect(await persistedRowCounts()).toEqual({ documents: 0, fragments: 0 });

		const ownerMessage = importMessage(ownerId);
		const imported = await documentAction.handler?.(
			integrationRuntime,
			ownerMessage,
			undefined,
			handlerOptions,
		);
		expect(imported?.success).toBe(true);
		const documentId = imported?.values?.documentId as UUID | undefined;
		expect(documentId).toMatch(/^[0-9a-f-]{36}$/i);

		const stored = await integrationService.getDocumentById(
			documentId as UUID,
			ownerMessage,
		);
		expect(stored).toMatchObject({
			id: documentId,
			content: { text: content },
			worldId,
			roomId,
			entityId: ownerId,
			metadata: {
				scope: "user-private",
				scopedToEntityId: ownerId,
				addedBy: ownerId,
				addedByRole: "OWNER",
				addedFrom: "file",
			},
		});

		const query = {
			...ownerMessage,
			id: crypto.randomUUID() as UUID,
			content: { ...ownerMessage.content, text: "persistence needle 26336" },
		};
		const results = await integrationService.searchDocuments(
			query,
			undefined,
			"keyword",
		);
		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					content: { text: content },
					metadata: expect.objectContaining({ documentId }),
				}),
			]),
		);

		const counts = await persistedRowCounts();
		expect(counts.documents).toBe(1);
		expect(counts.fragments).toBeGreaterThan(0);
		process.stdout.write(
			`DOCUMENT_IMPORT_PROOF ${JSON.stringify({ denied: denied?.values?.error, documentId, counts, queryable: true })}\n`,
		);
	}, 120_000);
});
