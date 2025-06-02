import { PGlite } from '@electric-sql/pglite';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { vector } from '@electric-sql/pglite/vector';
import { worker } from '@electric-sql/pglite/worker';

// Worker configuration for PGlite
// This runs in a Web Worker and manages the actual PGlite instance
worker({
  async init(options) {
    console.log('[PGlite Worker] Initializing PGlite instance in worker', {
      dataDir: options?.dataDir,
      meta: options?.meta,
    });

    // Create the PGlite instance with extensions
    // Extensions must be configured here in the worker, not passed from PgliteWorker
    const pg = new PGlite({
      dataDir: options?.dataDir || 'idb://eliza-db',
      relaxedDurability: options?.meta?.relaxedDurability !== false, // Default to true for better performance
      extensions: {
        vector,
        fuzzystrmatch,
      },
    });

    // Wait for the database to be ready
    await pg.waitReady;
    console.log('[PGlite Worker] PGlite instance ready');

    return pg as any; // Type cast to resolve bundler/module resolution conflicts
  },
});
