import {
  Service,
  type IAgentRuntime,
  logger,
  type MessageExample,
  type MessageExampleGroup,
  MemoryType,
} from '@elizaos/core';
import fs from 'fs-extra';
import path from 'path';
import { z } from 'zod';
import { PersonalityServiceType } from '../types';

// Validation schema for character modifications
const CharacterModificationSchema = z.object({
  name: z.string().optional().describe('Character name'),
  system: z
    .string()
    .optional()
    .describe('System prompt that defines agent behavior and instructions'),
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
        })
      )
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
  settings: z.record(z.unknown()).optional(),
});

type CharacterModification = z.infer<typeof CharacterModificationSchema>;

/**
 * Service for safely managing character file modifications
 * Handles backup, validation, and atomic updates of character files
 */
export class CharacterFileManager extends Service {
  static serviceType = PersonalityServiceType.CHARACTER_MANAGEMENT;

  capabilityDescription = 'Manages safe character file modifications with backup and validation';

  private characterFilePath: string | null = null;
  private backupDir: string;
  private maxBackups = 10;
  private validationRules: Map<string, (value: unknown) => boolean> = new Map();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.runtime = runtime;
    }
    this.backupDir = path.join(process.cwd(), '.eliza', 'character-backups');
    this.setupValidationRules();
  }

  static async start(runtime: IAgentRuntime): Promise<CharacterFileManager> {
    const manager = new CharacterFileManager(runtime);
    manager.runtime = runtime;
    await manager.initialize();
    return manager;
  }

  private async initialize(): Promise<void> {
    // Ensure backup directory exists
    await fs.ensureDir(this.backupDir);

    // Try to detect the character file path
    await this.detectCharacterFile();

logger.debug({
      msg: 'CharacterFileManager initialized',
      characterFile: this.characterFilePath,
      backupDir: this.backupDir,
    });
  }

  private async detectCharacterFile(): Promise<void> {
    const character = this.runtime.character;

    // Look for character file in common locations
    const possiblePaths = [
      // Current working directory
      path.join(process.cwd(), `${character.name}.json`),
      path.join(process.cwd(), 'character.json'),

      // Agent directory
      path.join(process.cwd(), 'agent', `${character.name}.json`),
      path.join(process.cwd(), 'agent', 'character.json'),

      // Characters directory
      path.join(process.cwd(), 'characters', `${character.name}.json`),
      path.join(process.cwd(), 'characters', 'character.json'),

      // Relative paths
      path.join(process.cwd(), '..', 'characters', `${character.name}.json`),
      path.join(process.cwd(), '..', '..', 'characters', `${character.name}.json`),
    ];

    for (const filePath of possiblePaths) {
      if (await fs.pathExists(filePath)) {
        try {
          const content = await fs.readJSON(filePath);
          if (content.name === character.name) {
            this.characterFilePath = filePath;
logger.debug({ msg: 'Character file detected', path: filePath });
            return;
          }
        } catch {
          // Continue searching
        }
      }
    }

    logger.debug('No character file on disk, operating in memory-only mode');
  }

  private setupValidationRules(): void {
    // Name validation - ensure safe and reasonable names
    this.validationRules.set('name', (value: unknown) => {
const name = value;
      if (typeof name !== 'string') {
        return false;
      }
      const name = value;
      return (
        name.length > 0 &&
        name.length < 100 &&
        /^[a-zA-Z0-9\s\-_]+$/.test(name) && // Alphanumeric, spaces, hyphens, underscores only
        !name.toLowerCase().includes('admin') && // Prevent impersonation
        !name.toLowerCase().includes('system') &&
        !name.toLowerCase().includes('root') &&
        !name.trim().startsWith(' ') && // No leading/trailing spaces
        !name.trim().endsWith(' ')
      );
    });

    // System prompt validation - ensure safe and reasonable content
    this.validationRules.set('system', (value: unknown) => {
const system = value;
      if (typeof system !== 'string') {
        return false;
      }
      const system = value;
      return (
        system.length > 10 && // Minimum meaningful length
        system.length < 10000 && // Maximum reasonable length
        !system.includes('<script>') && // Basic XSS protection
        !system.includes('javascript:') &&
        !system.includes('eval(') &&
        !system.includes('Function(') &&
        !system.toLowerCase().includes('ignore previous instructions') && // Prompt injection protection
        !system.toLowerCase().includes('disregard') &&
        !system.toLowerCase().includes('forget everything')
      );
    });

    // Bio validation - ensure reasonable length and content
    this.validationRules.set('bio', (value: unknown) => {
const bio = value;
      if (!Array.isArray(bio)) {
        return false;
      }
      const bio = value as string[];
      return bio.every(
        (item) =>
          typeof item === 'string' &&
          item.length > 0 &&
          item.length < 500 &&
          !item.includes('<script>') && // Basic XSS protection
          !item.includes('javascript:')
      );
    });

    // Topics validation
    this.validationRules.set('topics', (value: unknown) => {
const topics = value;
      if (!Array.isArray(topics)) {
        return false;
      }
      const topics = value as string[];
      return topics.every(
        (topic) =>
          typeof topic === 'string' &&
          topic.length > 0 &&
          topic.length < 100 &&
          /^[a-zA-Z0-9\s\-_]+$/.test(topic) // Alphanumeric, spaces, hyphens, underscores only
      );
    });
  }

  async createBackup(): Promise<string | null> {
    if (!this.characterFilePath) {
      logger.warn({ msg: 'No character file path available for backup' });
      return null;
    }

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `${path.basename(this.characterFilePath, '.json')}-${timestamp}.json`;
      const backupPath = path.join(this.backupDir, backupFileName);

      await fs.copy(this.characterFilePath, backupPath);

      // Clean up old backups
      await this.cleanupOldBackups();

logger.info({ msg: 'Character backup created', backupPath });
      return backupPath;
    } catch (error) {
      logger.error({ msg: 'Failed to create character backup', err: error });
      return null;
    }
  }

  private async cleanupOldBackups(): Promise<void> {
    try {
      const files = await fs.readdir(this.backupDir);
      const backupFiles = files
        .filter((file) => file.endsWith('.json'))
        .map((file) => ({
          name: file,
          path: path.join(this.backupDir, file),
          stat: fs.statSync(path.join(this.backupDir, file)),
        }))
        .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

      // Keep only the most recent backups
      const filesToDelete = backupFiles.slice(this.maxBackups);
      for (const file of filesToDelete) {
        await fs.unlink(file.path);
      }

      if (filesToDelete.length > 0) {
        logger.info(`Cleaned up ${filesToDelete.length} old backups`);
      }
    } catch (error) {
logger.error({ msg: 'Error cleaning up old backups', err: error });
    }
  }

  validateModification(modification: Record<string, unknown>): { valid: boolean; errors: string[] } {
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
      errors.push('Too many bio elements - maximum 20 allowed');
    }

    const topicsVal = modification.topics;
    if (Array.isArray(topicsVal) && topicsVal.length > 50) {
      errors.push('Too many topics - maximum 50 allowed');
    }

    return { valid: errors.length === 0, errors };
  }

  async applyModification(
    modification: CharacterModification
  ): Promise<{ success: boolean; error?: string }> {
    // Validate modification
    const validation = this.validateModification(modification);
    if (!validation.valid) {
      return {
        success: false,
        error: `Validation failed: ${validation.errors.join(', ')}`,
      };
    }

    try {
      // Create backup first
      await this.createBackup();

      // Get current character
      const currentCharacter = { ...this.runtime.character };

      // Apply modifications using merge logic (additive, not replacement)

      // Handle name modification - direct replacement
      if (modification.name) {
        const oldName = currentCharacter.name;
        currentCharacter.name = modification.name;
logger.info({
          msg: 'Character name changed',
          oldName,
          newName: modification.name,
        });
      }

      // Handle system prompt modification - this is a direct replacement, not additive
      if (modification.system) {
        const oldSystem = currentCharacter.system || 'No system prompt';
        currentCharacter.system = modification.system;

logger.info({
          msg: 'System prompt modified',
          oldLength: oldSystem.length,
          newLength: modification.system.length,
          changed: oldSystem !== modification.system,
        });
      }

      if (modification.bio) {
        const currentBioRaw = Array.isArray(currentCharacter.bio)
          ? currentCharacter.bio
          : [currentCharacter.bio];
        const currentBio = currentBioRaw.filter((x): x is string => typeof x === 'string');

        // Add new bio elements, avoiding duplicates
        const currentBioStrings = currentBio.filter((x): x is string => typeof x === 'string');
        const newBioElements = modification.bio.filter(
          (newBio) =>
            !currentBioStrings.some(
              (existing) =>
                existing.toLowerCase().includes(newBio.toLowerCase()) ||
                newBio.toLowerCase().includes(existing.toLowerCase())
            )
        );

        currentCharacter.bio = [...currentBioStrings, ...newBioElements];
      }

      if (modification.topics) {
        const currentTopics = currentCharacter.topics || [];
        const newTopics = modification.topics.filter((topic) => !currentTopics.includes(topic));
        currentCharacter.topics = [...currentTopics, ...newTopics];
      }

      if (modification.messageExamples) {
        const currentExamples = currentCharacter.messageExamples || [];
const newGroups = modification.messageExamples.map((examples) => ({
          examples,
        })) as MessageExampleGroup[];
        currentCharacter.messageExamples = [
          ...currentExamples,
          ...newGroups,
        ] as typeof currentCharacter.messageExamples;
      }

      if (modification.style) {
        const prev = currentCharacter.style;
        currentCharacter.style = {
all: prev?.all ?? modification.style?.all ?? [],
          chat: prev?.chat ?? modification.style?.chat ?? [],
          post: prev?.post ?? modification.style?.post ?? [],
          $typeName: 'eliza.v1.StyleGuides' as const,
        };
      }

      if (modification.settings) {
        currentCharacter.settings = {
          ...currentCharacter.settings,
...(modification.settings as Record<string, import('@elizaos/core').JsonValue | undefined>),
        };
      }

      // Update runtime character
      Object.assign(this.runtime.character, currentCharacter);

      // Write to file if available
      if (this.characterFilePath) {
        await fs.writeJSON(this.characterFilePath, currentCharacter, { spaces: 2 });
        logger.info('Character file updated successfully');
      }

      // Log the modification - need roomId for memory creation
      const dummyRoomId = this.runtime.agentId; // Use agentId as fallback roomId
      await this.runtime.createMemory(
        {
          entityId: this.runtime.agentId,
          roomId: dummyRoomId,
          content: {
            text: `Character modification applied to file: ${this.characterFilePath || 'memory-only'}`,
            source: 'character_modification',
          },
          metadata: {
            type: MemoryType.CUSTOM,
            service: PersonalityServiceType,
            action: 'character_modified',
            timestamp: Date.now(),
            filePath: this.characterFilePath ?? undefined,
            modificationType: 'file_update',
          },
        },
        'character_modifications'
      );

      return { success: true };
    } catch (error) {
logger.error({ msg: 'Failed to apply character modification', err: error });
      return {
        success: false,
        error: `Application failed: ${(error as Error).message}`,
      };
    }
  }

  async getModificationHistory(
    limit = 10
  ): Promise<Array<{ timestamp: number | undefined; modification: unknown; filePath: string | undefined }>> {
    const memories = await this.runtime.getMemories({
      entityId: this.runtime.agentId,
      count: limit,
      tableName: 'character_modifications',
    });

    return memories.map((memory) => {
      const meta = memory.metadata as Record<string, unknown> | undefined;
const filePath = meta?.filePath;
      return {
        timestamp: typeof meta?.timestamp === 'number' ? meta.timestamp : undefined,
        modification: meta?.modification,
        filePath: typeof filePath === 'string' ? filePath : undefined,
      };
    });
  }

  async getAvailableBackups(): Promise<Array<{ path: string; timestamp: number; size: number }>> {
    if (!(await fs.pathExists(this.backupDir))) {
      return [];
    }

    const files = await fs.readdir(this.backupDir);
    const backups = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
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

          timestamp = new Date(year, month, day, hour, minute, second).getTime();
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

  async restoreFromBackup(backupPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Validate backup file exists and is readable
      if (!(await fs.pathExists(backupPath))) {
        return { success: false, error: 'Backup file not found' };
      }

      // Read and validate backup content
      const backupContent = await fs.readJSON(backupPath);

      if (!backupContent.name || typeof backupContent.name !== 'string') {
        return { success: false, error: 'Invalid backup file format - missing character name' };
      }

      // Create a backup of the current state before restoration
      const currentBackupPath = await this.createBackup();

      // Update runtime character
      Object.assign(this.runtime.character, backupContent);

      // If we have a character file path, update the file
      if (this.characterFilePath) {
        await fs.writeJSON(this.characterFilePath, backupContent, { spaces: 2 });
      }

      // Log the restoration
      const dummyRoomId = this.runtime.agentId;
      await this.runtime.createMemory(
        {
          entityId: this.runtime.agentId,
          roomId: dummyRoomId,
          content: {
            text: `Character restored from backup: ${path.basename(backupPath)}`,
            source: 'character_restoration',
          },
          metadata: {
            type: MemoryType.CUSTOM,
            service: PersonalityServiceType,
            action: 'character_reset',
            timestamp: Date.now(),
            backupPath,
            previousBackup: currentBackupPath,
            restorationType: 'backup_restoration',
          },
        },
        'character_modifications'
      );

logger.info({
        msg: 'Character restored from backup',
        backupPath,
        characterName: backupContent.name,
        currentBackup: currentBackupPath,
      });

      return { success: true };
    } catch (error) {
      logger.error({ msg: 'Failed to restore from backup', err: error });
      return {
        success: false,
        error: `Restoration failed: ${(error as Error).message}`,
      };
    }
  }

  async restoreFromHistory(entryIndex: number): Promise<{ success: boolean; error?: string }> {
    const history = await this.getModificationHistory(50);

    if (entryIndex < 0 || entryIndex >= history.length) {
      return { success: false, error: 'Invalid history entry index' };
    }

    const entry = history[entryIndex];
    if (!entry.filePath) {
      return { success: false, error: 'No file path available for this history entry' };
    }

    // Find the corresponding backup file
    const backups = await this.getAvailableBackups();
    const entryTs = entry.timestamp ?? 0;
    const backup = backups.find(
(b) => Math.abs(b.timestamp - (entry.timestamp ?? 0)) < 60000 // Within 1 minute
    );

    if (!backup) {
      return { success: false, error: 'Corresponding backup file not found' };
    }

    return await this.restoreFromBackup(backup.path);
  }

  async stop(): Promise<void> {
    logger.info({ msg: 'CharacterFileManager stopped' });
  }
}
