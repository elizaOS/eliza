import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

describe('Environment Setup', () => {
  it('should verify .env.test file exists', () => {
    const possiblePaths = [
      path.join(process.cwd(), '.env.test'),
      path.join(process.cwd(), 'packages/core/.env.test'),
      path.join(__dirname, '../../.env.test'),
      path.join(__dirname, '../.env.test'),
      path.join(__dirname, '.env.test'),
    ];

    const existingPaths = possiblePaths.filter((p) => {
      const exists = fs.existsSync(p);
      console.log(`Path ${p} exists: ${exists}`);
      return exists;
    });

    expect(existingPaths.length).toBeGreaterThan(0);
  });
});
