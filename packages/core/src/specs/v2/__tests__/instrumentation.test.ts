import { describe, it, expect } from 'vitest';
import { InstrumentationService } from '../../../instrumentation/service';

describe('InstrumentationService', () => {
  it('initializes and can flush and stop', async () => {
    const svc = new InstrumentationService({ enabled: true, serviceName: 'test' });
    expect(svc.isEnabled()).toBe(true);
    await svc.flush();
    await svc.stop();
    expect(svc.isEnabled()).toBe(false);
  });

  it('disabled service reports disabled', () => {
    const svc = new InstrumentationService({ enabled: false, serviceName: 'x' });
    expect(svc.isEnabled()).toBe(false);
  });
});
