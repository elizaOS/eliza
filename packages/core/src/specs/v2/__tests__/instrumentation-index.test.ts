import { describe, it, expect } from 'vitest';
import * as instrumentation from '../../../instrumentation';

describe('instrumentation index exports', () => {
  it('exports service', () => {
    expect(instrumentation.InstrumentationService).toBeDefined();
  });
});
