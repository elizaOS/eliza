export type FileLimits = {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxDirectoryEntries: number;
  maxSearchMatches: number;
  maxSearchFileBytes: number;
};

export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
export const DEFAULT_MAX_WRITE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_DIRECTORY_ENTRIES = 500;
export const DEFAULT_MAX_SEARCH_MATCHES = 100;
export const DEFAULT_MAX_SEARCH_FILE_BYTES = 512 * 1024;

export function loadFileLimits(
  env: NodeJS.ProcessEnv = process.env,
): FileLimits {
  return {
    maxReadBytes: readPositiveInteger(
      env.ELIZA_FS_MAX_READ_BYTES,
      DEFAULT_MAX_READ_BYTES,
    ),
    maxWriteBytes: readPositiveInteger(
      env.ELIZA_FS_MAX_WRITE_BYTES,
      DEFAULT_MAX_WRITE_BYTES,
    ),
    maxDirectoryEntries: readPositiveInteger(
      env.ELIZA_FS_MAX_DIR_ENTRIES,
      DEFAULT_MAX_DIRECTORY_ENTRIES,
    ),
    maxSearchMatches: readPositiveInteger(
      env.ELIZA_FS_MAX_SEARCH_MATCHES,
      DEFAULT_MAX_SEARCH_MATCHES,
    ),
    maxSearchFileBytes: readPositiveInteger(
      env.ELIZA_FS_MAX_SEARCH_FILE_BYTES,
      DEFAULT_MAX_SEARCH_FILE_BYTES,
    ),
  };
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
