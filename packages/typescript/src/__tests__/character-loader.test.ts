/**
 * Tests for Character Loader
 *
 * @module __tests__/character-loader.test
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ensureEncryptionSalt,
	findCharacterFile,
	getCharacterPaths,
	type LoadCharacterResult,
	loadCharacter,
	loadCharacterJson,
	saveCharacter,
} from "../character-loader";
import type { Character } from "../types";

// Mock fs module
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	return {
		...actual,
		default: {
			...actual,
			existsSync: vi.fn(),
			readFileSync: vi.fn(),
			promises: {
				mkdir: vi.fn(),
				writeFile: vi.fn(),
			},
		},
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
		promises: {
			mkdir: vi.fn(),
			writeFile: vi.fn(),
		},
	};
});

describe("character-loader", () => {
	let originalEnv: NodeJS.ProcessEnv;
	let _originalCwd: string;

	beforeEach(() => {
		originalEnv = { ...process.env };
		_originalCwd = process.cwd();
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.env = originalEnv;
		vi.restoreAllMocks();
	});

	describe("getCharacterPaths", () => {
		it("should return array of character file paths", () => {
			const paths = getCharacterPaths();

			expect(paths).toBeInstanceOf(Array);
			expect(paths.length).toBeGreaterThan(0);

			// Should include TypeScript files first
			expect(paths[0]).toContain("character.ts");
			expect(paths[1]).toContain("agent.ts");

			// Then JSON files
			expect(paths[2]).toContain("character.json");
			expect(paths[3]).toContain("agent.json");

			// And home directory fallback
			expect(paths[4]).toContain(".eliza");
		});

		it("should use current working directory", () => {
			const paths = getCharacterPaths();
			const cwd = process.cwd();

			expect(paths[0]).toBe(path.join(cwd, "character.ts"));
			expect(paths[2]).toBe(path.join(cwd, "character.json"));
		});

		it("should include home directory path", () => {
			const paths = getCharacterPaths();
			const home = os.homedir();

			expect(paths[4]).toBe(path.join(home, ".eliza", "character.json"));
		});
	});

	describe("findCharacterFile", () => {
		it("should return first existing character file", () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			mockExistsSync.mockImplementation((p) => {
				return p === path.join(process.cwd(), "character.json");
			});

			const result = findCharacterFile();

			expect(result).toBe(path.join(process.cwd(), "character.json"));
		});

		it("should return null when no files exist", () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			mockExistsSync.mockReturnValue(false);

			const result = findCharacterFile();

			expect(result).toBeNull();
		});

		it("should prefer TypeScript files over JSON", () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			mockExistsSync.mockImplementation((p) => {
				return (
					p === path.join(process.cwd(), "character.ts") ||
					p === path.join(process.cwd(), "character.json")
				);
			});

			const result = findCharacterFile();

			expect(result).toBe(path.join(process.cwd(), "character.ts"));
		});
	});

	describe("loadCharacterJson", () => {
		it("should load and validate JSON character file", () => {
			const mockReadFileSync = vi.mocked(fs.readFileSync);
			const validCharacter = {
				name: "Test Character",
				bio: ["A test character"],
				plugins: ["@elizaos/plugin-sql"],
			};
			mockReadFileSync.mockReturnValue(JSON.stringify(validCharacter));

			const result = loadCharacterJson("/path/to/character.json");

			expect(result).not.toBeNull();
			expect(result?.name).toBe("Test Character");
		});

		it("should return null for invalid JSON", () => {
			const mockReadFileSync = vi.mocked(fs.readFileSync);
			mockReadFileSync.mockReturnValue("not valid json");

			expect(() => loadCharacterJson("/path/to/character.json")).toThrow();
		});

		it("should return null for invalid character schema", () => {
			const mockReadFileSync = vi.mocked(fs.readFileSync);
			// Missing required 'name' field
			mockReadFileSync.mockReturnValue(JSON.stringify({ bio: ["test"] }));

			const result = loadCharacterJson("/path/to/character.json");

			expect(result).toBeNull();
		});
	});

	describe("ensureEncryptionSalt", () => {
		it("should add encryption salt if missing", () => {
			const character: Character = { name: "Test" };
			const updated = ensureEncryptionSalt(character);

			expect(updated.settings?.secrets?.ENCRYPTION_SALT).toBeDefined();
			expect(typeof updated.settings?.secrets?.ENCRYPTION_SALT).toBe("string");
			expect(
				(updated.settings?.secrets?.ENCRYPTION_SALT as string).length,
			).toBe(64); // 32 bytes = 64 hex chars
		});

		it("should not modify existing encryption salt", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						ENCRYPTION_SALT: "existing-salt",
					},
				},
			};
			const updated = ensureEncryptionSalt(character);

			expect(updated.settings?.secrets?.ENCRYPTION_SALT).toBe("existing-salt");
		});

		it("should preserve other secrets", () => {
			const character: Character = {
				name: "Test",
				settings: {
					secrets: {
						OTHER_KEY: "other-value",
					},
				},
			};
			const updated = ensureEncryptionSalt(character);

			expect(updated.settings?.secrets?.OTHER_KEY).toBe("other-value");
			expect(updated.settings?.secrets?.ENCRYPTION_SALT).toBeDefined();
		});
	});

	describe("loadCharacter", () => {
		it("should use default character when no file found", async () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			mockExistsSync.mockReturnValue(false);

			const defaultChar: Character = {
				name: "Default",
				bio: ["Default bio"],
				plugins: [],
			};

			const result = await loadCharacter(undefined, defaultChar);

			expect(result.fromDefault).toBe(true);
			expect(result.character.name).toBe("Default");
		});

		it("should create minimal character when no file and no default", async () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			mockExistsSync.mockReturnValue(false);

			const result = await loadCharacter();

			expect(result.fromDefault).toBe(true);
			expect(result.character.name).toBe("Eliza");
			expect(result.character.plugins).toContain("@elizaos/plugin-sql");
		});

		it("should import secrets from env", async () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			mockExistsSync.mockReturnValue(false);

			process.env.ANTHROPIC_API_KEY = "test-key";

			const result = await loadCharacter();

			expect(result.character.settings?.secrets?.ANTHROPIC_API_KEY).toBe(
				"test-key",
			);
		});

		it("should ensure encryption salt exists", async () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			mockExistsSync.mockReturnValue(false);

			const result = await loadCharacter();

			expect(result.character.settings?.secrets?.ENCRYPTION_SALT).toBeDefined();
		});

		it("should generate character ID if missing", async () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			mockExistsSync.mockReturnValue(false);

			const result = await loadCharacter();

			expect(result.character.id).toBeDefined();
		});

		it("should load from specified path", async () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			const mockReadFileSync = vi.mocked(fs.readFileSync);

			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue(
				JSON.stringify({
					name: "Custom Character",
					bio: ["Custom bio"],
					plugins: ["@elizaos/plugin-sql"],
				}),
			);

			const result = await loadCharacter("/custom/path/character.json");

			expect(result.filePath).toBe("/custom/path/character.json");
			expect(result.character.name).toBe("Custom Character");
			expect(result.fromDefault).toBe(false);
		});
	});

	describe("saveCharacter", () => {
		it("should save character to JSON file", async () => {
			const mockMkdir = vi.mocked(fs.promises.mkdir);
			const mockWriteFile = vi.mocked(fs.promises.writeFile);
			const mockExistsSync = vi.mocked(fs.existsSync);

			mockExistsSync.mockReturnValue(false);
			mockMkdir.mockResolvedValue(undefined);
			mockWriteFile.mockResolvedValue(undefined);

			const character: Character = {
				name: "Test",
				bio: ["Test bio"],
				plugins: [],
			};

			await saveCharacter(character, "/path/to/character.json");

			expect(mockMkdir).toHaveBeenCalledWith("/path/to", {
				recursive: true,
				mode: 0o700,
			});
			expect(mockWriteFile).toHaveBeenCalledWith(
				"/path/to/character.json",
				expect.any(String),
				{ encoding: "utf-8", mode: 0o600 },
			);
		});

		it("should format JSON with proper indentation", async () => {
			const mockMkdir = vi.mocked(fs.promises.mkdir);
			const mockWriteFile = vi.mocked(fs.promises.writeFile);
			const mockExistsSync = vi.mocked(fs.existsSync);

			mockExistsSync.mockReturnValue(false);
			mockMkdir.mockResolvedValue(undefined);
			mockWriteFile.mockResolvedValue(undefined);

			const character: Character = {
				name: "Test",
				bio: ["Test bio"],
			};

			await saveCharacter(character, "/path/to/character.json");

			const writtenContent = mockWriteFile.mock.calls[0][1] as string;
			expect(writtenContent).toContain("\n"); // Has newlines
			expect(writtenContent.endsWith("\n")).toBe(true); // Ends with newline
		});
	});

	describe("LoadCharacterResult type", () => {
		it("should have correct structure", async () => {
			const mockExistsSync = vi.mocked(fs.existsSync);
			mockExistsSync.mockReturnValue(false);

			const result: LoadCharacterResult = await loadCharacter();

			expect(result).toHaveProperty("character");
			expect(result).toHaveProperty("filePath");
			expect(result).toHaveProperty("fromDefault");
		});
	});
});
