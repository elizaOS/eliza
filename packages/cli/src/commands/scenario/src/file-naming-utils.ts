/**
 * Utilities for consistent file naming in the scenario system
 */

/**
 * Generates a PST timestamp in the format YYYY-MM-DD-HH-MM-SS
 * @returns Timestamp string in PST timezone
 */
export function generatePSTTimestamp(): string {
  const now = new Date();

  // Convert to PST (UTC-8) or PDT (UTC-7) depending on daylight saving time
  const pstDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));

  const year = pstDate.getFullYear();
  const month = String(pstDate.getMonth() + 1).padStart(2, '0');
  const day = String(pstDate.getDate()).padStart(2, '0');
  const hour = String(pstDate.getHours()).padStart(2, '0');
  const minute = String(pstDate.getMinutes()).padStart(2, '0');
  const second = String(pstDate.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}-${hour}-${minute}-${second}`;
}

/**
 * Generates a run filename in the format: run-YYYY-MM-DD-XXX-HH-MM-SS
 * @param index - Run index (e.g., 001, 002)
 * @param timestamp - Optional timestamp, defaults to current PST time
 * @returns Formatted filename
 */
export function generateRunFilename(index: number, timestamp?: string): string {
  const ts = timestamp || generatePSTTimestamp();
  const paddedIndex = String(index).padStart(3, '0');
  return `run-${ts.slice(0, 10)}-${paddedIndex}-${ts.slice(11)}`;
}

/**
 * Generates a matrix filename in the format: matrix-YYYY-MM-DD-XXX-HH-MM-SS
 * @param index - Matrix index (e.g., 001, 002)
 * @param timestamp - Optional timestamp, defaults to current PST time
 * @returns Formatted filename
 */
export function generateMatrixFilename(index: number, timestamp?: string): string {
  const ts = timestamp || generatePSTTimestamp();
  const paddedIndex = String(index).padStart(3, '0');
  return `matrix-${ts.slice(0, 10)}-${paddedIndex}-${ts.slice(11)}`;
}

/**
 * Generates a step-specific filename for evaluation/execution results
 * @param baseFilename - Base filename (e.g., run-2025-08-17-001-14-30-15)
 * @param stepIndex - Step index (0, 1, 2, etc.)
 * @param suffix - File suffix (e.g., 'evaluation', 'execution')
 * @returns Formatted filename with step info
 */
export function generateStepFilename(
  baseFilename: string,
  stepIndex: number,
  suffix: string
): string {
  return `${baseFilename}-step-${stepIndex}-${suffix}.json`;
}
