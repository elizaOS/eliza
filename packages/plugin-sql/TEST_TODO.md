# Test TODO List

This file outlines the tasks required to fix the failing test suite in `plugin-sql`.

- [x] **1. Fix Database Isolation in PGLite:**
  - In `src/pglite/manager.ts`, remove the singleton pattern (`getInstance` and `instance` property) from `PGliteClientManager`.
  - Update `__tests__/test-helpers.ts` to instantiate a new `PGliteClientManager` for each test setup to ensure test isolation.

- [x] **2. Fix `worldTable` `serverId` Constraint Violation:**
  - In `src/schema/world.ts`, modify the `serverId` column in `worldTable` to have a default value to prevent insertion errors when it's not explicitly provided in tests. A default value of `'local'` seems appropriate.

- [x] **3. Make Migrator Less Noisy:**
  - In the custom migrator logic (inferred to be in `src/custom-migrator.ts`), wrap constraint creation in `try/catch` blocks. If a constraint already exists, log an informational message instead of an error to clean up test output for idempotent migration tests.

- [x] **4. Full Test Suite Pass:**
  - After implementing the fixes above, run the entire test suite to ensure all tests pass. Address any remaining specific test failures. The initial fixes should resolve the majority of the cascading errors. 