/**
 * Compile-time guard: ArcStateType in @babylon/shared must stay in sync
 * with the canonical definition in @babylon/db.
 *
 * If these two types diverge (a state added/removed in the DB schema but
 * not updated in shared), this file will fail to compile and surface the
 * drift immediately — before any runtime behavior breaks.
 *
 * The test itself is trivial; the value is in the type-level assertions.
 */
import { describe, expect, it } from 'bun:test';
import type { ArcStateType as DbArcStateType } from '@babylon/db';
import type { ArcStateType as SharedArcStateType } from '@babylon/shared';

// If SharedArcStateType and DbArcStateType diverge, one or both of these
// assignments will produce a TS error at compile time.
type _SharedExtendsDb = SharedArcStateType extends DbArcStateType
  ? true
  : false;
type _DbExtendsShared = DbArcStateType extends SharedArcStateType
  ? true
  : false;

const _sharedExtendsDb: _SharedExtendsDb = true;
const _dbExtendsShared: _DbExtendsShared = true;

describe('ArcStateType sync: @babylon/shared ↔ @babylon/db', () => {
  it('shared ArcStateType is identical to db ArcStateType (compile-time check)', () => {
    // The real assertion is the TypeScript above. This runtime check just
    // ensures the test file runs and reports a pass in the test suite.
    expect(_sharedExtendsDb).toBe(true);
    expect(_dbExtendsShared).toBe(true);
  });
});
