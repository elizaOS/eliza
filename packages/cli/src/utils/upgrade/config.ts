// Configuration constants for the migration system
export const MAX_TOKENS = 100000;
export const BRANCH_NAME = '1.x-claude-migrator';
export const CLAUDE_CODE_TIMEOUT = 15 * 60 * 1000; // 15 minutes
export const MIN_DISK_SPACE_GB = 2; // Minimum 2GB free space required
export const LOCK_FILE_NAME = '.elizaos-migration.lock';

// Default API key for test environments during migration
// This is used to ensure tests can run during the migration process
export const DEFAULT_OPENAI_API_KEY = '';


