import path from 'node:path';
import fs from 'node:fs';

/**
 * Extracts the Vite output directory from vite.config.ts
 */
export async function getViteOutDir(rootDir: string): Promise<string> {
  const viteConfigPath = path.join(rootDir, 'vite.config.ts');
  const configContent = await fs.promises.readFile(viteConfigPath, 'utf-8');

  // Extract the outDir value using regex
  const outDirMatch = configContent.match(/outDir\s*:\s*['"`]([^'"`]+)['"`]/);
  if (!outDirMatch) {
    throw new Error('Could not find outDir in vite.config.ts');
  }

  let outDir = outDirMatch[1];

  // Handle variable references like ${outDir}
  if (outDir.includes('${')) {
    // Look for the variable definition
    const varMatch = configContent.match(/const\s+outDir\s*=\s*['"`]([^'"`]+)['"`]/);
    if (varMatch) {
      outDir = outDir.replace('${outDir}', varMatch[1]);
    } else {
      // Default fallback
      outDir = 'dist/.vite';
    }
  }

  // The outDir in vite.config.ts is relative to the root option (src/frontend)
  // We need to normalize it to be relative to the project root
  if (outDir.startsWith('../../')) {
    // Convert ../../dist/frontend to dist/frontend
    outDir = outDir.replace('../../', '');
  }

  return outDir;
}
