import path from 'node:path';
import fs from 'node:fs';

// Default output directories
const DEFAULT_VITE_OUT_DIR = 'dist/frontend';
const DEFAULT_VITE_VAR_DIR = 'dist/.vite';

/**
 * Extracts the Vite output directory from vite.config.ts
 */
export async function getViteOutDir(rootDir: string): Promise<string> {
  const viteConfigPath = path.join(rootDir, 'vite.config.ts');

  // Check if vite config exists
  if (!fs.existsSync(viteConfigPath)) {
    // Return default if config doesn't exist
    return DEFAULT_VITE_OUT_DIR;
  }

  const configContent = await fs.promises.readFile(viteConfigPath, 'utf-8');

  // Extract the outDir value using regex
  const outDirMatch = configContent.match(/outDir\s*:\s*['"`]([^'"`]+)['"`]/);
  if (!outDirMatch) {
    // Return default output directory if outDir configuration is not found in vite.config.ts
    return DEFAULT_VITE_OUT_DIR;
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
      outDir = DEFAULT_VITE_VAR_DIR;
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
