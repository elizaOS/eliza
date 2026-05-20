import { describe, expect, it } from 'bun:test';
import {
  calculateModelPilotEstimateRange,
  modelPilotDeliverableAffectsEstimate,
} from '@feed/shared';

describe('model pilot inquiry helpers', () => {
  it('treats lowercase fine-tuned deliverables as estimate-affecting', () => {
    expect(
      modelPilotDeliverableAffectsEstimate('Dataset + fine-tuned model')
    ).toBe(true);
  });

  it('includes dataset plus fine-tuned model in the estimate uplift', () => {
    expect(
      calculateModelPilotEstimateRange({
        deliverables: ['Behavioral data'],
        review: 'Light review',
        privateDeployment: false,
        dataExclusivity: false,
        concurrentAgents: 500,
        scenarioRuns: 10_000,
      })
    ).toBe('$7,000 – $12,000');

    expect(
      calculateModelPilotEstimateRange({
        deliverables: ['Dataset + fine-tuned model'],
        review: 'Light review',
        privateDeployment: false,
        dataExclusivity: false,
        concurrentAgents: 500,
        scenarioRuns: 10_000,
      })
    ).toBe('$19,000 – $29,000');
  });
});
