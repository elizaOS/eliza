import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../../logger";
import type { UUID } from "../../types";
import type { DocumentService } from "./service.ts";
import type {
	AddDocumentOptions,
	DocumentAddedByRole,
	DocumentAddedFrom,
	DocumentVisibilityScope,
} from "./types.ts";
import { isTextBackedDocumentContent } from "./utils.ts";

export function getDocumentsPath(runtimePath?: string): string {
	const documentsPath =
		runtimePath ||
		process.env.DOCUMENTS_PATH ||
		path.join(process.cwd(), "docs");
	const resolvedPath = path.resolve(documentsPath);

	if (!fs.existsSync(resolvedPath)) {
		logger.warn(`Documents path does not exist: ${resolvedPath}`);
		if (runtimePath) {
			logger.warn(
				"Please create the directory or update DOCUMENTS_PATH in agent settings",
			);
		} else if (process.env.DOCUMENTS_PATH) {
			logger.warn(
				"Please create the directory or update DOCUMENTS_PATH environment variable",
			);
		} else {
			logger.info("To use the documents plugin, either:");
			logger.info('1. Create a "docs" folder in your project root');
			logger.info(
				"2. Set DOCUMENTS_PATH in agent settings or environment variable",
			);
		}
	}

	return resolvedPath;
}

export async function loadDocumentsFromPath(
	service: DocumentService,
	agentId: UUID,
	worldId?: UUID,
	documentsPath?: string,
	options?: {
		roomId?: UUID;
		entityId?: UUID;
		scope?: DocumentVisibilityScope;
		scopedToEntityId?: UUID;
		addedBy?: UUID;
		addedByRole?: DocumentAddedByRole;
		addedFrom?: DocumentAddedFrom;
		metadata?: Record<string, unknown>;
	},
): Promise<{ total: number; successful: number; failed: number }> {
	const docsPath = getDocumentsPath(documentsPath);

	if (!fs.existsSync(docsPath)) {
		logger.warn(`Documents path does not exist: ${docsPath}`);
		return { total: 0, successful: 0, failed: 0 };
	}

	logger.info(`Loading documents from: ${docsPath}`);

	const files = getAllFiles(docsPath);

	if (files.length === 0) {
		logger.info("No files found in documents path");
		return { total: 0, successful: 0, failed: 0 };
	}

	logger.info(`Found ${files.length} files to process`);

	let successful = 0;
	let failed = 0;

	for (const filePath of files) {
		try {
			const fileName = path.basename(filePath);

			if (fileName.startsWith(".")) {
				continue;
			}
			logger.debug(`Processing document: ${fileName}`);
			const result = await addDocumentFromFilePath({
				service,
				agentId,
				worldId,
				roomId: options?.roomId,
				entityId: options?.entityId,
				scope: options?.scope,
				scopedToEntityId: options?.scopedToEntityId,
				addedBy: options?.addedBy,
				addedByRole: options?.addedByRole,
				addedFrom: options?.addedFrom,
				filePath,
				metadata: options?.metadata,
			});

			logger.info(
				`✅ "${fileName}": ${result.fragmentCount} fragments created`,
			);
			successful++;
		} catch (error) {
			logger.error({ error }, `Failed to process file ${filePath}`);
			failed++;
		}
	}

	logger.info(
		`Document loading complete: ${successful} successful, ${failed} failed out of ${files.length} total`,
	);

	return {
		total: files.length,
		successful,
		failed,
	};
}

export async function addDocumentFromFilePath({
	service,
	agentId,
	worldId,
	roomId,
	entityId,
	filePath,
	scope,
	scopedToEntityId,
	addedBy,
	addedByRole,
	addedFrom,
	metadata,
}: {
	service: DocumentService;
	agentId: UUID;
	worldId?: UUID;
	roomId?: UUID;
	entityId?: UUID;
	filePath: string;
	scope?: DocumentVisibilityScope;
	scopedToEntityId?: UUID;
	addedBy?: UUID;
	addedByRole?: DocumentAddedByRole;
	addedFrom?: DocumentAddedFrom;
	metadata?: Record<string, unknown>;
}): Promise<{
	clientDocumentId: string;
	storedDocumentMemoryId: UUID;
	fragmentCount: number;
}> {
	const fileName = path.basename(filePath);
	const fileExt = path.extname(filePath).toLowerCase();
	const contentType = getDocumentFileContentType(fileExt);

	if (!contentType) {
		throw new Error(`Unsupported document file type: ${filePath}`);
	}

	const fileBuffer = fs.readFileSync(filePath);
	const isTextBacked = isTextBackedDocumentContent(contentType, fileName);
	const content = isTextBacked
		? fileBuffer.toString("utf-8")
		: fileBuffer.toString("base64");

	const documentOptions: AddDocumentOptions = {
		agentId,
		clientDocumentId: "" as UUID,
		contentType,
		originalFilename: fileName,
		worldId: worldId || agentId,
		content,
		roomId: roomId || agentId,
		entityId: entityId || agentId,
		scope,
		scopedToEntityId,
		addedBy,
		addedByRole,
		addedFrom,
		metadata: {
			...metadata,
			path: filePath,
			filename: fileName,
			originalFilename: fileName,
			title: path.parse(fileName).name || fileName,
			fileExt: fileExt.replace(/^\./, ""),
			fileType: contentType,
			contentType,
			fileSize: fileBuffer.length,
			textBacked: isTextBacked,
		},
	};

	return service.addDocument(documentOptions);
}

function getAllFiles(dirPath: string, files: string[] = []): string[] {
	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);

			if (entry.isDirectory()) {
				if (
					!["node_modules", ".git", ".vscode", "dist", "build"].includes(
						entry.name,
					)
				) {
					getAllFiles(fullPath, files);
				}
			} else if (entry.isFile()) {
				files.push(fullPath);
			}
		}
	} catch (error) {
		logger.error({ error }, `Error reading directory ${dirPath}`);
	}

	return files;
}

export function getDocumentFileContentType(extension: string): string | null {
	const contentTypes: Record<string, string> = {
		".txt": "text/plain",
		".md": "text/markdown",
		".markdown": "text/markdown",
		".tson": "text/plain",
		".xml": "application/xml",
		".csv": "text/csv",
		".tsv": "text/tab-separated-values",
		".log": "text/plain",

		// Web files
		".html": "text/html",
		".htm": "text/html",
		".css": "text/css",
		".scss": "text/x-scss",
		".sass": "text/x-sass",
		".less": "text/x-less",
		".js": "text/javascript",
		".jsx": "text/javascript",
		".ts": "text/typescript",
		".tsx": "text/typescript",
		".mjs": "text/javascript",
		".cjs": "text/javascript",
		".vue": "text/x-vue",
		".svelte": "text/x-svelte",
		".astro": "text/x-astro",

		// Python
		".py": "text/x-python",
		".pyw": "text/x-python",
		".pyi": "text/x-python",
		".java": "text/x-java",
		".kt": "text/x-kotlin",
		".kts": "text/x-kotlin",
		".scala": "text/x-scala",

		// C/C++/C#
		".c": "text/x-c",
		".cpp": "text/x-c++",
		".cc": "text/x-c++",
		".cxx": "text/x-c++",
		".h": "text/x-c",
		".hpp": "text/x-c++",
		".cs": "text/x-csharp",
		".php": "text/x-php",
		".rb": "text/x-ruby",
		".go": "text/x-go",
		".rs": "text/x-rust",
		".swift": "text/x-swift",
		".r": "text/x-r",
		".R": "text/x-r",
		".m": "text/x-objectivec",
		".mm": "text/x-objectivec",
		".clj": "text/x-clojure",
		".cljs": "text/x-clojure",
		".ex": "text/x-elixir",
		".exs": "text/x-elixir",
		".lua": "text/x-lua",
		".pl": "text/x-perl",
		".pm": "text/x-perl",
		".dart": "text/x-dart",
		".hs": "text/x-haskell",
		".elm": "text/x-elm",
		".ml": "text/x-ocaml",
		".fs": "text/x-fsharp",
		".fsx": "text/x-fsharp",
		".vb": "text/x-vb",
		".pas": "text/x-pascal",
		".d": "text/x-d",
		".nim": "text/x-nim",
		".zig": "text/x-zig",
		".jl": "text/x-julia",
		".tcl": "text/x-tcl",
		".awk": "text/x-awk",
		".sed": "text/x-sed",
		".sh": "text/x-sh",
		".bash": "text/x-sh",
		".zsh": "text/x-sh",
		".fish": "text/x-fish",
		".ps1": "text/x-powershell",
		".bat": "text/x-batch",
		".cmd": "text/x-batch",
		".json": "application/json",
		".yaml": "text/x-yaml",
		".yml": "text/x-yaml",
		".toml": "text/x-toml",
		".ini": "text/x-ini",
		".cfg": "text/x-ini",
		".conf": "text/x-ini",
		".env": "text/plain",
		".gitignore": "text/plain",
		".dockerignore": "text/plain",
		".editorconfig": "text/plain",
		".properties": "text/x-properties",
		".sql": "text/x-sql",
		".pdf": "application/pdf",
		".doc": "application/msword",
		".docx":
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	};

	return contentTypes[extension] || null;
}
