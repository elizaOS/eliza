import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import { globby } from 'globby';

export class FileTracker {
  private fileHashes: Map<string, string> = new Map();
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async captureSnapshot(): Promise<void> {
    const files = await globby(['**/*.{ts,js,json}'], {
      cwd: this.repoPath,
      ignore: ['node_modules/**', 'dist/**', '.turbo/**'],
    });

    for (const file of files) {
      const filePath = path.join(this.repoPath, file);
      const hash = await this.hashFile(filePath);
      this.fileHashes.set(file, hash);
    }
  }

  async getChangedFiles(): Promise<{
    modified: string[];
    created: string[];
    deleted: string[];
  }> {
    const currentFiles = await globby(['**/*.{ts,js,json}'], {
      cwd: this.repoPath,
      ignore: ['node_modules/**', 'dist/**', '.turbo/**'],
    });

    const modified: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];

    // Check for modified and new files
    for (const file of currentFiles) {
      const filePath = path.join(this.repoPath, file);
      const currentHash = await this.hashFile(filePath);
      const originalHash = this.fileHashes.get(file);

      if (!originalHash) {
        created.push(file);
      } else if (originalHash !== currentHash) {
        modified.push(file);
      }
    }

    // Check for deleted files
    for (const [file] of this.fileHashes) {
      if (!currentFiles.includes(file)) {
        deleted.push(file);
      }
    }

    return { modified, created, deleted };
  }

  private async hashFile(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
