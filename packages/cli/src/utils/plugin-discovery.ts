import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import { CachedRegistry } from '../types/plugins';

const CACHE_PATH = join(homedir(), '.eliza', 'cached-registry.json');

/** Read and parse the cached registry file */
// packages/cli/src/utils/plugin-discovery.ts

-import { existsSync, readFileSync } from 'node:fs';
+import { promises as fs } from 'node:fs';

 export async function readCache(): Promise<CachedRegistry | null> {
   try {
-    if (!existsSync(CACHE_PATH)) return null;
-    const raw = readFileSync(CACHE_PATH, 'utf-8');
+    if (!(await fs.access(CACHE_PATH).then(() => true).catch(() => false)))
+      return null;
+    const raw = await fs.readFile(CACHE_PATH, 'utf8');
     return JSON.parse(raw) as CachedRegistry;
   } catch {
     return null;
   }
 }
}

/** Run the parse-registry script to refresh the cache */
export async function updatePluginRegistryCache(): Promise<boolean> {
  const scriptPath = join(__dirname, 'parse-registry.ts');
  try {
    await execa('bun', ['run', scriptPath], { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}
