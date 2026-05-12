import path from "node:path";
import fs from "fs-extra";
import { z } from "zod";
import { logger } from "../../../../logger.ts";
import type {
	IAgentRuntime,
	MessageExample,
	MessageExampleGroup,
} from "../../../../types/index.ts";
import { Service } from "../../../../types/service.ts";
import { getCharacterPersistenceService } from "../character-persistence.ts";
import { PersonalityServiceType } from "../types.ts";

// Validation schema for character modifications
const CharacterModificationSchema = z.object({
	name: z.string().optional().describe("Character name"),
	system: z
		.string()
		.optional()
		.describe("System prompt that defines agent behavior and instructions"),
	bio: z.array(z.string()).optional(),
	messageExamples: z
		.array(
			z.array(
				z.object({
					name: z.string(),
					content: z.object({
						text: z.string(),
						actions: z.array(z.string()).optional(),
					}),
				}),
			),
		)
		.optional(),
	topics: z.array(z.string()).optional(),
	style: z
		.object({
			all: z.array(z.string()).optional(),
			chat: z.array(z.string()).optional(),
			post: z.array(z.string()).optional(),
		})
		.optional(),
	settings: z
		.record(
			z.string(),
			z.union([z.string(), z.number(), z.boolean(), z.null()]),
		)
		.optional(),
});

type CharacterModification = z.infer<typeof CharacterModificationSchema>;

/**
 * Service for safely managing character file modifications
 * Handles backup, validation, and atomic updates of character files
 */
export class CharacterFileManager extends Service {
	static serviceType = PersonalityServiceType.CHARACTER_MANAGEMENT;

	capabilityDescription =
		"Manages safe character file modifications with backup and validation";

	private characterFilePath: string | null = null;
	private backupDir: string;
	private maxBackups = 10;
	private validationRules: Map<string, (value: unknown) => boolean> = new Map();

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
		this.backupDir = path.join(process.cwd(), ".eliza", "character-backups");
		this.setupValidationRules();
	}

	static async start(runtime: IAgentRuntime): Promise<CharacterFileManager> {
		const manager = new CharacterFileManager(runtime);
		await manager.initialize();
		return manager;
	}

	private async initialize(): Promise<void> {
		// Ensure backup directory exists
		await fs.ensureDir(this.backupDir);

		// Try to detect the character file path
		await this.detectCharacterFile();

		logger.debug(
			{ characterFile: this.characterFilePath, backupDir: this.backupDir },
			"CharacterFileManager initialized",
		);
	}

	private async detectCharacterFile(): Promise<void> {
		const character = this.runtime.character;

		// Look for character file in common locations
		const possiblePaths = [
			// Current working directory
			path.join(process.cwd(), `${character.name}.json`),
			path.join(process.cwd(), "character.json"),

			// Agent directory
			path.join(process.cwd(), "agent", `${character.name}.json`),
			path.join(process.cwd(), "agent", "character.json"),

			// Characters directory
			path.join(process.cwd(), "characters", `${character.name}.json`),
			path.join(process.cwd(), "characters", "character.json"),

			// Relative paths
			path.join(process.cwd(), "..", "characters", `${character.name}.json`),
			path.join(
				process.cwd(),
				"..",
				"..",
				"characters",
				`${character.name}.json`,
			),
		];

		for (const filePath of possiblePaths) {
			if (await fs.pathExists(filePath)) {
				try {
					const content = await fs.readJSON(filePath);
					if (content.name === character.name) {
						this.characterFilePath = filePath;
						logger.debug({ path: filePath }, "Character file detected");
						return;
					}
				} catch {
					// Continue searching
				}
			}
		}

		logger.debug("No character file on disk, operating in memory-only mode");
	}

	private setupValidationRules(): void {
		// Name validation - ensure safe and reasonable names
		this.validationRules.set("name", (value: unknown) => {
			if (typeof value !== "string") {
				return false;
			}
			const name = value;
			return (
				name.length > 0 &&
				name.length < 100 &&
				/^[a-zA-Z0-9\s\-_]+$/.test(name) && // Alphanumeric, spaces, hyphens, underscores only
				!name.toLowerCase().includes("admin") && // Prevent impersonation
				!name.toLowerCase().includes("system") &&
				!name.toLowerCase().includes("root") &&
				!name.trim().startsWith(" ") && // No leading/trailing spaces
				!name.trim().endsWith(" ")
			);
		});

		// System prompt validation - ensure safe and reasonable content
		this.validationRules.set("system", (value: unknown) => {
			if (typeof value !== "string") {
				return false;
			}
			const system = value;
			return (
				system.length > 10 && // Minimum meaningful length
				system.length < 10000 && // Maximum reasonable length
				!system.includes("<script>") && // Basic XSS protection
				!system.includes("javascript:") &&
				!system.includes("eval(") &&
				!system.includes("Function(") &&
				!system.toLowerCase().includes("ignore previous instructions") && // Prompt injection protection
				!system.toLowerCase().includes("disregard") &&
				!system.toLowerCase().includes("forget everything")
			);
		});

		// Bio validation - ensure reasonable length and content
		this.validationRules.set("bio", (value: unknown) => {
			if (!Array.isArray(value)) {
				return false;
			}
			return value.every(
				(item) =>
					typeof item === "string" &&
					item.length > 0 &&
					item.length < 500 &&
					!item.includes("<script>") && // Basic XSS protection
					!item.includes("javascript:"),
			);
		});

		// Topics validation
		this.validationRules.set("topics", (value: unknown) => {
			if (!Array.isArray(value)) {
				return false;
			}
			return value.every(
				(topic) =>
					typeof topic === "string" &&
					topic.length > 0 &&
					topic.length < 100 &&
					/^[a-zA-Z0-9\s\-_]+$/.test(topic), // Alphanumeric, spaces, hyphens, underscores only
			);
		});
	}

	async createBackup(): Promise<string | null> {
		if (!this.characterFilePath) {
			logger.warn("No character file path available for backup");
			return null;
		}

		try {
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const backupFileName = `${path.basename(this.characterFilePath, ".json")}-${timestamp}.json`;
			const backupPath = path.join(this.backupDir, backupFileName);

			await fs.copy(this.characterFilePath, backupPath);

			// Clean up old backups
			await this.cleanupOldBackups();

			logger.info({ backupPath }, "Character backup created");
			return backupPath;
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Failed to create character backup",
			);
			return null;
		}
	}

	private async cleanupOldBackups(): Promise<void> {
		try {
			const files = await fs.readdir(this.backupDir);
			const backupFiles = files
				.filter((file: string) => file.endsWith(".json"))
				.map((file: string) => ({
					name: file,
					path: path.join(this.backupDir, file),
					stat: fs.statSync(path.join(this.backupDir, file)),
				}))
				.sort(
					(a: { stat: { mtime: Date } }, b: { stat: { mtime: Date } }) =>
						b.stat.mtime.getTime() - a.stat.mtime.getTime(),
				);

			// Keep only the most recent backups
			const filesToDelete = backupFiles.slice(this.maxBackups);
			for (const file of filesToDelete) {
				await fs.unlink(file.path);
			}

			if (filesToDelete.length > 0) {
				logger.info(`Cleaned up ${filesToDelete.length} old backups`);
			}
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error cleaning up old backups",
			);
		}
	}

	validateModification(modification: Record<string, unknown>): {
		valid: boolean;
		errors: string[];
	} {
		const errors: string[] = [];

		try {
			// Schema validation
			CharacterModificationSchema.parse(modification);
		} catch (error) {
			errors.push(`Schema validation failed: ${(error as Error).message}`);
			return { valid: false, errors };
		}

		// Additional validation rules
		for (const [field, validator] of this.validationRules.entries()) {
			if (modification[field] !== undefined) {
				if (!validator(modification[field])) {
					errors.push(`Invalid ${field}: failed validation rules`);
				}
			}
		}

		// Safety checks
		const bioVal = modification.bio;
		if (Array.isArray(bioVal) && bioVal.length > 20) {
			errors.push("Too many bio elements - maximum 20 allowed");
		}

		const topicsVal = modification.topics;
		if (Array.isArray(topicsVal) && topicsVal.length > 50) {
			errors.push("Too many topics - maximum 50 allowed");
		}

		return { valid: errors.length === 0, errors };
	}

	async applyModification(
		modification: CharacterModification,
	): Promise<{ success: boolean; error?: string }> {
		// Validate modification
		const validation = this.validateModification(modification);
		if (!validation.valid) {
			return {
				success: false,
				error: `Validation failed: ${validation.errors.join(", ")}`,
			};
		}

		try {
			// Create backup first
			await this.createBackup();

			// Get current character
			const currentCharacter = { ...this.runtime.character };
			const previousName =
				typeof this.runtime.character.name === "string"
					? this.runtime.character.name
					: undefined;

			// Apply modifications using merge logic (additive, not replacement)

			// Handle name modification - direct replacement
			if (modification.name) {
				const oldName = currentCharacter.name;
				currentCharacter.name = modification.name;
				logger.info(
					{ oldName, newName: modification.name },
					"Character name changed",
				);
			}

			// Handle system prompt modification - this is a direct replacement, not additive
			if (modification.system) {
				const oldSystem = currentCharacter.system || "No system prompt";
				currentCharacter.system = modification.system;

				logger.info(
					{
						oldLength: oldSystem.length,
						newLength: modification.system.length,
						changed: oldSystem !== modification.system,
					},
					"System prompt modified",
				);
			}

			if (modification.bio) {
				const currentBio = Array.isArray(currentCharacter.bio)
					? currentCharacter.bio
					: typeof currentCharacter.bio === "string"
						? [currentCharacter.bio]
						: [];

				// Add new bio elements, avoiding duplicates
				const newBioElements = modification.bio.filter(
					(newBio) =>
						!currentBio.some(
							(existing) =>
								existing.toLowerCase().includes(newBio.toLowerCase()) ||
								newBio.toLowerCase().includes(existing.toLowerCase()),
						),
				);

				currentCharacter.bio = [...currentBio, ...newBioElements];
			}

			if (modification.topics) {
				const currentTopics = currentCharacter.topics || [];
				const newTopics = modification.topics.filter(
					(topic) => !currentTopics.includes(topic),
				);
				currentCharacter.topics = [...currentTopics, ...newTopics];
			}

			if (modification.messageExamples) {
				const currentExamples = currentCharacter.messageExamples || [];
				const newExampleGroups: MessageExampleGroup[] =
					modification.messageExamples.map((group) => ({
						examples: group.map(
							(item): MessageExample => ({
								name: item.name ?? "",
								content: {
									text: item.content?.text ?? "",
									...(item.content?.actions
										? { actions: item.content.actions }
										: {}),
								},
							}),
						),
					}));
				currentCharacter.messageExamples = [
					...currentExamples,
					...newExampleGroups,
				];
			}

			if (modification.style) {
				currentCharacter.style = {
					...currentCharacter.style,
					...modification.style,
				} as typeof currentCharacter.style;
			}

			if (modification.settings) {
				currentCharacter.settings = {
					...currentCharacter.settings,
					...modification.settings,
				} as typeof currentCharacter.settings;
			}

			// Write to file if available
			if (this.characterFilePath) {
				await fs.writeJSON(this.characterFilePath, currentCharacter, {
					spaces: 2,
				});
				logger.info("Character file updated successfully");
			}

			const persistenceService = getCharacterPersistenceService(this.runtime);
			if (persistenceService) {
				const persistenceResult = await persistenceService.persistCharacter({
					character: currentCharacter as Record<string, unknown>,
					previousCharacter: this.runtime.character as Record<string, unknown>,
					previousName,
					source: "agent",
				});
				if (!persistenceResult.success) {
					return {
						success: false,
						error:
							persistenceResult.error ?? "Failed to persist character changes",
					};
				}
			}

			// Update runtime character only after persistence succeeds.
			Object.assign(this.runtime.character, currentCharacter);

			return { success: true };
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Failed to apply character modification",
			);
			return {
				success: false,
				error: `Application failed: ${(error as Error).message}`,
			};
		}
	}

	async getModificationHistory(limit = 10): Promise<
		Array<{
			timestamp: number | undefined;
			modification: unknown;
			filePath: string | undefined;
		}>
	> {
		const memories = await this.runtime.getMemories({
			entityId: this.runtime.agentId,
			count: limit,
			tableName: "character_modifications",
		});

		return memories.map((memory) => {
			const meta = memory.metadata as Record<string, unknown> | undefined;
			return {
				timestamp:
					typeof meta?.timestamp === "number" ? meta.timestamp : undefined,
				modification: meta?.after ?? meta?.changes ?? meta?.modification,
				filePath:
					typeof meta?.filePath === "string"
						? meta.filePath
						: (this.characterFilePath ?? undefined),
			};
		});
	}

	async getAvailableBackups(): Promise<
		Array<{ path: string; timestamp: number; size: number }>
	> {
		if (!(await fs.pathExists(this.backupDir))) {
			return [];
		}

		const files = await fs.readdir(this.backupDir);
		const backups: Array<{ path: string; timestamp: number; size: number }> =
			[];

		for (const file of files) {
			if (file.endsWith(".json")) {
				const filePath = path.join(this.backupDir, file);
				const stat = await fs.stat(filePath);

				// Extract timestamp from filename (format: character-YYYYMMDD-HHMMSS.json)
				const timestampMatch = file.match(/character-(\d{8})-(\d{6})\.json/);
				let timestamp = stat.mtime.getTime();

				if (timestampMatch) {
					const dateStr = timestampMatch[1];
					const timeStr = timestampMatch[2];
					const year = parseInt(dateStr.substring(0, 4), 10);
					const month = parseInt(dateStr.substring(4, 6), 10) - 1;
					const day = parseInt(dateStr.substring(6, 8), 10);
					const hour = parseInt(timeStr.substring(0, 2), 10);
					const minute = parseInt(timeStr.substring(2, 4), 10);
					const second = parseInt(timeStr.substring(4, 6), 10);

					timestamp = new Date(
						year,
						month,
						day,
						hour,
						minute,
						second,
					).getTime();
				}

				backups.push({
					path: filePath,
					timestamp,
					size: stat.size,
				});
			}
		}

		return backups.sort((a, b) => b.timestamp - a.timestamp);
	}

	async restoreFromBackup(
		backupPath: string,
	): Promise<{ success: boolean; error?: string }> {
		try {
			// Validate backup file exists and is readable
			if (!(await fs.pathExists(backupPath))) {
				return { success: false, error: "Backup file not found" };
			}

			// Read and validate backup content
			const backupContent = await fs.readJSON(backupPath);

			if (!backupContent.name || typeof backupContent.name !== "string") {
				return {
					success: false,
					error: "Invalid backup file format - missing character name",
				};
			}

			// Create a backup of the current state before restoration
			const currentBackupPath = await this.createBackup();
			const previousCharacter = {
				...this.runtime.character,
			} as Record<string, unknown>;

			// If we have a character file path, update the file
			if (this.characterFilePath) {
				await fs.writeJSON(this.characterFilePath, backupContent, {
					spaces: 2,
				});
			}

			const persistenceService = getCharacterPersistenceService(this.runtime);
			if (persistenceService) {
				const persistenceResult = await persistenceService.persistCharacter({
					character: backupContent as Record<string, unknown>,
					previousCharacter,
					previousName:
						typeof this.runtime.character.name === "string"
							? this.runtime.character.name
							: undefined,
					source: "restore",
				});
				if (!persistenceResult.success) {
					return {
						success: false,
						error: persistenceResult.error ?? "Failed to restore character",
					};
				}
			}

			// Update runtime character only after persistence succeeds.
			Object.assign(this.runtime.character, backupContent);

			logger.info(
				{
					backupPath,
					characterName: backupContent.name,
					currentBackup: currentBackupPath,
				},
				"Character restored from backup",
			);

			return { success: true };
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Failed to restore from backup",
			);
			return {
				success: false,
				error: `Restoration failed: ${(error as Error).message}`,
			};
		}
	}

	async restoreFromHistory(
		entryIndex: number,
	): Promise<{ success: boolean; error?: string }> {
		const history = await this.getModificationHistory(50);

		if (entryIndex < 0 || entryIndex >= history.length) {
			return { success: false, error: "Invalid history entry index" };
		}

		const entry = history[entryIndex];
		if (!entry.filePath) {
			return {
				success: false,
				error: "No file path available for this history entry",
			};
		}
		if (entry.timestamp === undefined) {
			return {
				success: false,
				error: "No timestamp available for this history entry",
			};
		}
		const entryTimestamp = entry.timestamp;

		// Find the corresponding backup file
		const backups = await this.getAvailableBackups();
		const backup = backups.find(
			(b) => Math.abs(b.timestamp - entryTimestamp) < 60000, // Within 1 minute
		);

		if (!backup) {
			return { success: false, error: "Corresponding backup file not found" };
		}

		return await this.restoreFromBackup(backup.path);
	}

	async stop(): Promise<void> {
		logger.info("CharacterFileManager stopped");
	}
}
