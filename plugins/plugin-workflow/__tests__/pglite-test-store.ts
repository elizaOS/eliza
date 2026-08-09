/**
 * Per-test PGlite storage allocation for the workflow suites. Delegates the
 * memory-vs-disk decision to core's shared test policy (in-memory `memory://`
 * by default; `ELIZA_TEST_PGLITE_STORAGE=disk` restores temp directories),
 * so these suites stop writing WASM filesystem pages to host tmp — the
 * NODEFS path faults mid-suite on loaded CI runners (elizaOS/eliza#18053).
 * Suites that prove restart persistence keep constructing their own on-disk
 * data dirs and must not use this helper.
 */
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createTestPgliteDataDir,
  isInMemoryPgliteDataDir,
} from '../../../packages/core/src/testing/pglite-storage.ts';

export interface WorkflowPgliteStore {
  /** Value for `new PGlite({ dataDir })`: a `memory://` URL or a temp path. */
  dataDir: string;
  /** Removes the on-disk store if one was created; no-op for memory stores. */
  cleanup: () => Promise<void>;
}

export function makeWorkflowPgliteStore(prefix: string): WorkflowPgliteStore {
  const allocated = createTestPgliteDataDir(prefix);
  if (isInMemoryPgliteDataDir(allocated)) {
    return { dataDir: allocated, cleanup: async () => {} };
  }
  // Disk mode: keep the historical layout of a `pglite/` dir inside the temp
  // root so the whole mkdtemp root is removed on cleanup.
  const dataDir = `${allocated}/pglite`;
  return {
    dataDir,
    cleanup: async () => {
      await rm(dirname(dataDir), { recursive: true, force: true });
    },
  };
}
