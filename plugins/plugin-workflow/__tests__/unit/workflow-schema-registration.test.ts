/** Verifies every persisted workflow table is exposed to the runtime migrator. */
import { describe, expect, it } from 'vitest';
import { workflowPlugin } from '../../src/index';

describe('workflow schema registration', () => {
  it('registers the revision table used by workflow history', () => {
    expect(workflowPlugin.schema).toHaveProperty('workflowRevisions');
  });

  it('does not register foreign credential stores or embedded secret tables', () => {
    expect(workflowPlugin.schema).not.toHaveProperty('credentialMappings');
    expect(workflowPlugin.schema).not.toHaveProperty('embeddedCredentials');
    expect(workflowPlugin.services?.map((service) => service.serviceType)).not.toContain(
      'workflow_credential_store'
    );
  });
});
