/** Verifies every persisted workflow table is exposed to the runtime migrator. */
import { describe, expect, it } from 'vitest';
import { workflowPlugin } from '../../src/index';

describe('workflow schema registration', () => {
  it('registers the revision table used by workflow history', () => {
    expect(workflowPlugin.schema).toHaveProperty('workflowRevisions');
  });
});
