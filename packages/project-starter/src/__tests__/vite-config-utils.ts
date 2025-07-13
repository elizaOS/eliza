import path from 'node:path';
import fs from 'node:fs';

/**
 * Extracts the Vite build.outDir from vite.config.ts
 * Handles both relative and absolute paths, accounting for Vite's root directory
 */
export async function getViteOutDir(packageRoot: string): Promise<string> {
  const viteConfigPath = path.join(packageRoot, 'vite.config.ts');

  if (!fs.existsSync(viteConfigPath)) {
    throw new Error(`vite.config.ts not found at ${viteConfigPath}`);
  }

  // Import the vite config dynamically
  const configModule = await import(viteConfigPath);
  const config =
    typeof configModule.default === 'function'
      ? configModule.default({ command: 'build', mode: 'production' })
      : configModule.default;

  let outDir = config.build?.outDir || 'dist';
  const viteRoot = config.root || '.';

  // If outDir is relative, resolve it relative to the vite root
  if (!path.isAbsolute(outDir)) {
    const viteRootAbsolute = path.resolve(packageRoot, viteRoot);
    outDir = path.resolve(viteRootAbsolute, outDir);
  }

  // Ensure the path is relative to packageRoot for consistency
  return path.relative(packageRoot, outDir);
}
