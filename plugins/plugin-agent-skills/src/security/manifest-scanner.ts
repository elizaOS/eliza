/**
 * Manifest scanner — validates skill directory structure.
 * Catches binary payloads, symlink escapes, hidden files, excessive sizes.
 */

import type { ManifestFinding } from "./types";

const MAX_FILE_COUNT = 200;
const MAX_TOTAL_SIZE = 5 * 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
	".exe",
	".dll",
	".so",
	".dylib",
	".wasm",
	".bin",
	".com",
	".bat",
	".cmd",
	".msi",
	".deb",
	".rpm",
	".dmg",
	".app",
	".elf",
	".o",
	".a",
	".lib",
	".obj",
]);

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".ps1", ".psm1", ".zsh"]);

const ALLOWED_DOTFILES = new Set([
	".gitignore",
	".env.example",
	".editorconfig",
	".scan-results.json",
]);

function getExtension(filePath: string): string {
	const dotIndex = filePath.lastIndexOf(".");
	if (dotIndex < 0) return "";
	return filePath.slice(dotIndex).toLowerCase();
}

function getFileName(filePath: string): string {
	const slashIndex = filePath.lastIndexOf("/");
	if (slashIndex < 0) return filePath;
	return filePath.slice(slashIndex + 1);
}

function hasHiddenComponent(filePath: string): boolean {
	return filePath
		.split("/")
		.some((p) => p.startsWith(".") && !ALLOWED_DOTFILES.has(p));
}

export interface ManifestFileEntry {
	relativePath: string;
	sizeBytes: number;
	isSymlink: boolean;
	symlinkTarget?: string;
}

export function scanManifest(
	entries: ManifestFileEntry[],
	skillDirPath: string,
): ManifestFinding[] {
	const findings: ManifestFinding[] = [];
	let totalSize = 0;
	let hasSkillMd = false;

	for (const entry of entries) {
		const ext = getExtension(entry.relativePath);
		totalSize += entry.sizeBytes;

		if (getFileName(entry.relativePath) === "SKILL.md") hasSkillMd = true;

		if (BINARY_EXTENSIONS.has(ext)) {
			findings.push({
				ruleId: "binary-file",
				severity: "critical",
				file: entry.relativePath,
				message: `Binary executable file detected (${ext})`,
			});
		}

		if (entry.isSymlink) {
			if (
				entry.symlinkTarget &&
				!entry.symlinkTarget.startsWith(skillDirPath)
			) {
				findings.push({
					ruleId: "symlink-escape",
					severity: "critical",
					file: entry.relativePath,
					message: `Symbolic link points outside skill directory: ${entry.symlinkTarget}`,
				});
			} else {
				findings.push({
					ruleId: "symlink-internal",
					severity: "warn",
					file: entry.relativePath,
					message: "Symbolic link detected within skill directory",
				});
			}
		}

		if (hasHiddenComponent(entry.relativePath)) {
			findings.push({
				ruleId: "hidden-file",
				severity: "warn",
				file: entry.relativePath,
				message: "Hidden file or directory detected",
			});
		}

		if (SCRIPT_EXTENSIONS.has(ext)) {
			findings.push({
				ruleId: "shell-script",
				severity: "warn",
				file: entry.relativePath,
				message: `Shell script file detected (${ext})`,
			});
		}
	}

	if (!hasSkillMd) {
		findings.push({
			ruleId: "missing-skill-md",
			severity: "critical",
			file: "SKILL.md",
			message: "No SKILL.md file found — invalid skill package",
		});
	}

	if (entries.length > MAX_FILE_COUNT) {
		findings.push({
			ruleId: "excessive-files",
			severity: "warn",
			file: ".",
			message: `Skill contains ${entries.length} files (limit: ${MAX_FILE_COUNT})`,
		});
	}

	if (totalSize > MAX_TOTAL_SIZE) {
		findings.push({
			ruleId: "excessive-size",
			severity: "warn",
			file: ".",
			message: `Skill total size is ${(totalSize / (1024 * 1024)).toFixed(1)}MB (limit: ${MAX_TOTAL_SIZE / (1024 * 1024)}MB)`,
		});
	}

	return findings;
}

export async function buildManifestEntriesFromDisk(
	dirPath: string,
): Promise<ManifestFileEntry[]> {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	const entries: ManifestFileEntry[] = [];

	async function walk(currentDir: string): Promise<void> {
		const items = await fs.readdir(currentDir, { withFileTypes: true });
		for (const item of items) {
			if (item.name === "node_modules") continue;
			const fullPath = path.join(currentDir, item.name);
			const relativePath = path.relative(dirPath, fullPath);

			if (item.isSymbolicLink()) {
				let symlinkTarget: string | undefined;
				try {
					symlinkTarget = await fs.realpath(fullPath);
				} catch {
					/* broken symlink */
				}
				let sizeBytes = 0;
				try {
					sizeBytes = (await fs.stat(fullPath)).size;
				} catch {
					/* can't stat broken symlink */
				}
				entries.push({
					relativePath,
					sizeBytes,
					isSymlink: true,
					symlinkTarget,
				});
			} else if (item.isDirectory()) {
				await walk(fullPath);
			} else if (item.isFile()) {
				entries.push({
					relativePath,
					sizeBytes: (await fs.stat(fullPath)).size,
					isSymlink: false,
				});
			}
		}
	}

	await walk(dirPath);
	return entries;
}

export function buildManifestEntriesFromMemory(
	files: Map<string, { content: string | Uint8Array; isText: boolean }>,
): ManifestFileEntry[] {
	const entries: ManifestFileEntry[] = [];
	for (const [relativePath, file] of files) {
		const sizeBytes =
			typeof file.content === "string"
				? new TextEncoder().encode(file.content).byteLength
				: file.content.byteLength;
		entries.push({ relativePath, sizeBytes, isSymlink: false });
	}
	return entries;
}
