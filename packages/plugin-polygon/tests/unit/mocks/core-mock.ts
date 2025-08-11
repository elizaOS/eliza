/**
 * This file re-exports the core mocks from vitest.setup.ts
 * This enables legacy tests to be migrated more easily and 
 * maintain backward compatibility with existing tests.
 */

import { mockRuntime } from '../../../vitest.setup';

export { mockRuntime };

// Use this file only for legacy test migrations
// New tests should import mocks directly from vitest.setup.ts 