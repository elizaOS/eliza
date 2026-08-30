/** Exercises deterministic workflow search ordering through the persistence service contract. */
import { describe, expect, test } from 'bun:test';
import { compareWorkflowSearchCandidates } from '../../src/services/workflow-service.js';
import type { WorkflowDefinitionResponse } from '../../src/types/index';

describe('workflow contract', () => {
  test('orders search candidates by score and breaks ties on workflow id', () => {
    const candidate = (id: string, score: number) => ({
      workflow: { id } as unknown as WorkflowDefinitionResponse,
      score,
    });
    const candidates = [candidate('z-wf', 5), candidate('a-wf', 5), candidate('m-wf', 9)];

    candidates.sort(compareWorkflowSearchCandidates);

    expect(candidates.map(({ workflow }) => workflow.id)).toEqual(['m-wf', 'a-wf', 'z-wf']);
  });
});
