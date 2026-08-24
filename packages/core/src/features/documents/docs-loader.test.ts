/**
 * Exercises the real filesystem document loader with temporary directories and
 * a recording service boundary, covering path resolution, traversal, content
 * encoding, option normalization, and per-file failure accounting.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UUID } from "../../types";
import {
	addDocumentFromFilePath,
	getDocumentFileContentType,
	getDocumentsPath,
	loadDocumentsFromPath,
} from "./docs-loader.ts";
import type { AddDocumentOptions } from "./types.ts";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const storedDocumentMemoryId = "00000000-0000-0000-0000-000000000002" as UUID;
const temporaryDirectories: string[] = [];
const originalDocumentsPath = process.env.DOCUMENTS_PATH;

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
