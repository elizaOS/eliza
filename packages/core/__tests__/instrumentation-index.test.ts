import { describe, it, expect } from 'vitest';
import * as instrumentation from '../src/instrumentation';

describe('instrumentation index exports', () => {
  it('exports service', () => {
    expect(instrumentation.InstrumentationService).toBeDefined();
  });
});
