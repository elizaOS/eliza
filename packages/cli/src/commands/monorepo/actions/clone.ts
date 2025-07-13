import { bunExecInherit } from '@/src/utils/bun-exec';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CloneInfo } from '../types';

/**
 * Clones a GitHub repository at a specified branch into a target directory.
 *
 * @param repo - The GitHub repository in "owner/repo" shorthand or full URL.
 * @param branch - The branch to clone from the repository.
 * @param destination - The directory where the repository will be cloned.
 *
 * @throws {Error} If the specified branch does not exist in the repository.
 * @throws {Error} If cloning fails for any other reason.
 */
export async function cloneRepository(
  repo: string,
  branch: string,
  destination: string
): Promise<void> {
  try {
    const repoUrl = `https://github.com/${repo}`;

    // Clone specific branch using bun-exec
    await bunExecInherit('git', ['clone', '-b', branch, repoUrl, destination]);
  } catch (error) {
    // Special handling for likely branch errors
    if (error instanceof Error && error.message.includes('exit code 128')) {
      console.error(`\n[X] Branch '${branch}' doesn't exist in the ElizaOS repository.`);
      console.error(`Please specify a valid branch name. Common branches include:`);
      console.error(`  • main - The main branch`);
      console.error(`  • develop - The development branch (default)`);
      console.error(
        `\nFor a complete list of branches, visit: https://github.com/elizaOS/eliza/branches`
      );
      throw new Error(`Branch '${branch}' not found`);
    }
    throw new Error(
      `Failed to clone repository: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Prepares the destination directory for cloning
 *
 * Creates the directory if it doesn't exist, or validates that it's empty if it does exist.
 */
export function prepareDestination(dir: string): string {
  const destinationDir = path.resolve(process.cwd(), dir);

  // Check if destination directory already exists and is not empty
  if (existsSync(destinationDir)) {
    const files = readdirSync(destinationDir);
    if (files.length > 0) {
      throw new Error(`Destination directory ${destinationDir} already exists and is not empty`);
    }
  } else {
    mkdirSync(destinationDir, { recursive: true });
  }

  return destinationDir;
}

/**
 * Main monorepo cloning action
 *
 * Handles the complete cloning process including directory preparation and error handling.
 */
export async function cloneMonorepo(cloneInfo: CloneInfo): Promise<void> {
  const { repo, branch, destination } = cloneInfo;

  // Prepare the destination directory
  const destinationDir = prepareDestination(destination);

  // Clone the repository
  await cloneRepository(repo, branch, destinationDir);

  return;
}
