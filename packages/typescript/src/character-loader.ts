/**
 * Character Loader
 *
 * File I/O operations for loading and saving Eliza characters.
 * Supports both JSON and TypeScript character files.
 *
 * @module character-loader
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	COMMON_SECRET_KEYS,
	importSecretsFromEnv,
	mergeCharacterSecrets,
	syncCharacterSecretsToEnv,
} from "./character-utils";
import { logger } from "./logger";
import { validateCharacter } from "./schemas/character";
import type { Character, UUID } from "./types";
import { stringToUuid } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Result of loading a character from file or creating a default.
 */
export interface LoadCharacterResult {
	/** The loaded or created character */
	character: Character;
	/** Path to the character file, or null if using default */
	filePath: string | null;
	/** True if the character was created from the default, not loaded from file */
	fromDefault: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get default character file paths in priority order.
 * Supports both JSON and TypeScript character files.
 *
 * @returns Array of file paths to search for character files
 */
export function getCharacterPaths(): string[] {
	return [
		// TypeScript character files (preferred)
		path.join(process.cwd(), "character.ts"),
		path.join(process.cwd(), "agent.ts"),
		// JSON character files (fallback)
		path.join(process.cwd(), "character.json"),
		path.join(process.cwd(), "agent.json"),
		path.join(os.homedir(), ".eliza", "character.json"),
	];
}

/**
 * Find the first existing character file from the default paths.
 *
 * @returns Path to the first found character file, or null if none exist
 */
export function findCharacterFile(): string | null {
	for (const candidate of getCharacterPaths()) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE LOADING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load and validate a JSON character file.
 *
 * @param filePath - Path to the JSON character file
 * @returns The validated Character, or null if loading/validation failed
 */
export function loadCharacterJson(filePath: string): Character | null {
	const content = fs.readFileSync(filePath, "utf-8");
	const parsed = JSON.parse(content) as Record<string, unknown>;

	const validationResult = validateCharacter(parsed);
	if (!validationResult.success) {
		logger.warn(
			`Character validation failed for ${filePath}: ${validationResult.error?.message}`,
		);
		return null;
	}

	return validationResult.data as Character;
}

/**
 * Load and validate a TypeScript character file via dynamic import.
 * Supports default export, named 'character' export, or 'defaultCharacter' export.
 *
 * @param filePath - Path to the TypeScript character file
 * @returns The validated Character, or null if loading/validation failed
 */
export async function loadCharacterTs(
	filePath: string,
): Promise<Character | null> {
	// Convert to file:// URL for dynamic import
	const fileUrl = new URL(`file://${filePath}`);
	const module = (await import(fileUrl.href)) as {
		default?: Character;
		character?: Character;
		defaultCharacter?: Character;
	};

	// Try various export names
	const character =
		module.default ?? module.character ?? module.defaultCharacter;

	if (!character) {
		logger.warn(`Character file ${filePath} does not export a character`);
		return null;
	}

	const validationResult = validateCharacter(character);
	if (!validationResult.success) {
		logger.warn(
			`Character validation failed for ${filePath}: ${validationResult.error?.message}`,
		);
		return null;
	}

	return validationResult.data as Character;
}

/**
 * Load a character file, routing to the appropriate loader based on extension.
 *
 * @param filePath - Path to the character file (JSON or TypeScript)
 * @returns The validated Character, or null if loading/validation failed
 */
export async function loadCharacterFile(
	filePath: string,
): Promise<Character | null> {
	const ext = path.extname(filePath).toLowerCase();

	if (ext === ".ts" || ext === ".mts") {
		return loadCharacterTs(filePath);
	}

	return loadCharacterJson(filePath);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENCRYPTION SALT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ensure the character has an encryption salt in settings.secrets.
 * Generates a random 32-byte hex salt if not present.
 *
 * @param character - The character to check/update
 * @returns A new character with encryption salt guaranteed
 */
export function ensureEncryptionSalt(character: Character): Character {
	const secrets = (character.settings?.secrets as Record<string, string>) ?? {};

	if (!secrets.ENCRYPTION_SALT) {
		const salt = crypto.randomBytes(32).toString("hex");
		return mergeCharacterSecrets(character, { ENCRYPTION_SALT: salt });
	}

	return character;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LOADER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load an Eliza character from file or create from default.
 *
 * This function:
 * 1. Loads character from file (or uses provided default)
 * 2. Imports common secrets from process.env
 * 3. Ensures encryption salt exists
 * 4. Syncs character secrets back to process.env
 *
 * @param characterPath - Override character file path (optional)
 * @param defaultCharacter - Default character to use if no file found (optional)
 * @returns LoadCharacterResult with the character, file path, and fromDefault flag
 */
export async function loadCharacter(
	characterPath?: string,
	defaultCharacter?: Character,
): Promise<LoadCharacterResult> {
	// Find or create character
	const filePath = characterPath ?? findCharacterFile();
	let character: Character;
	let fromDefault = false;

	if (filePath && fs.existsSync(filePath)) {
		const loaded = await loadCharacterFile(filePath);
		if (loaded) {
			character = loaded;
			logger.info(`Loaded character from ${filePath}`);
		} else if (defaultCharacter) {
			character = { ...defaultCharacter };
			fromDefault = true;
			logger.warn(`Failed to load ${filePath}, using default character`);
		} else {
			character = createMinimalCharacter();
			fromDefault = true;
			logger.warn(
				`Failed to load ${filePath}, using minimal default character`,
			);
		}
	} else if (defaultCharacter) {
		character = { ...defaultCharacter };
		fromDefault = true;
		logger.info("No character file found, using default character");
	} else {
		character = createMinimalCharacter();
		fromDefault = true;
		logger.info("No character file found, using minimal default character");
	}

	// Ensure character has an ID
	if (!character.id) {
		character.id = stringToUuid(character.name ?? "eliza") as UUID;
	}

	// Import common secrets from process.env
	character = importSecretsFromEnv(character, COMMON_SECRET_KEYS);

	// Ensure encryption salt
	character = ensureEncryptionSalt(character);

	// Sync secrets back to process.env
	syncCharacterSecretsToEnv(character);

	return {
		character,
		filePath,
		fromDefault,
	};
}

/**
 * Create a minimal character when no file or default is provided.
 */
function createMinimalCharacter(): Character {
	return {
		name: "Eliza",
		bio: ["A helpful AI assistant."],
		plugins: ["@elizaos/plugin-sql"],
		secrets: {},
	} as Character;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE SAVING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Save a character to a JSON file with secure permissions.
 *
 * @param character - The character to save
 * @param filePath - Path to save to (defaults to first found or character.json)
 */
export async function saveCharacter(
	character: Character,
	filePath?: string,
): Promise<void> {
	const characterPath =
		filePath ?? findCharacterFile() ?? getCharacterPaths()[2]; // character.json
	const dir = path.dirname(characterPath);

	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	const json = JSON.stringify(character, null, 2).trimEnd().concat("\n");

	// Write with secure permissions (owner read/write only)
	await fs.promises.writeFile(characterPath, json, {
		encoding: "utf-8",
		mode: 0o600,
	});

	logger.info(`Character saved to ${characterPath}`);
}
