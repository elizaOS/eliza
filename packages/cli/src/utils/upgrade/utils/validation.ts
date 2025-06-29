import { execa } from 'execa';
import * as fs from 'fs';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const access = promisify(fs.access);

export async function validateBuild(repoPath: string): Promise<boolean> {
  try {
    await execa('bun', ['run', 'build'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

export async function validateTypeScript(repoPath: string): Promise<boolean> {
  try {
    await execa('bunx', ['tsc', '--noEmit'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

export async function getTestCoverage(repoPath: string): Promise<number> {
  try {
    const result = await execa('bun', ['test', '--coverage'], {
      cwd: repoPath,
    });

    // Parse coverage from output
    const coverageMatch = result.stdout.match(/All files\s+\|\s+([\d.]+)/);
    if (coverageMatch) {
      return parseFloat(coverageMatch[1]);
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
