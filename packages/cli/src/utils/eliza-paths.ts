import path from 'node:path';

/**
 * Utility helpers for resolving standard Eliza directories.
 *
 * All CLI-generated data should live under the hidden `.eliza` folder
 * that sits in the project root (i.e. <project>/.eliza/…).  By
 * centralising the path logic here we avoid the hard-coded scattered
 * variants that previously lived throughout the codebase.
 */

export function getElizaBaseDir(cwd: string = process.cwd()): string {
  return path.join(cwd, '.eliza');
}

export function getElizaDbDir(cwd: string = process.cwd()): string {
  return path.join(getElizaBaseDir(cwd), '.elizadb');
}

export function getElizaDataDir(cwd: string = process.cwd()): string {
  return path.join(getElizaBaseDir(cwd), 'data');
}

export function getElizaUploadsDir(cwd: string = process.cwd()): string {
  return path.join(getElizaDataDir(cwd), 'uploads');
}

export function getElizaGeneratedDir(cwd: string = process.cwd()): string {
  return path.join(getElizaDataDir(cwd), 'generated');
}

export function getElizaCharactersDir(cwd: string = process.cwd()): string {
  return path.join(getElizaDataDir(cwd), 'characters');
}
