/**
 * Utility functions for file operations
 */

/**
 * Creates a safe filename from a given string by removing special characters
 * and limiting the length to avoid potential issues
 *
 * @param {string} input - The input string to convert to a safe filename
 * @returns {string} - A string safe to use as a filename
 */
function createSafeFilename(input) {
  if (!input) return 'untitled';

  // Replace non-alphanumeric characters with hyphens
  let safeFilename = input
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-')     // Replace spaces with hyphens
    .replace(/-+/g, '-');     // Replace multiple hyphens with a single one

  // Limit the filename length to avoid issues with long filenames
  if (safeFilename.length > 80) {
    safeFilename = safeFilename.substring(0, 80);
  }

  return safeFilename;
}

module.exports = {
  createSafeFilename
};
