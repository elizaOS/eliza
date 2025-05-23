import { describe, it, expect } from 'vitest';
import { createService, defineService } from '../src/services';
import { Service } from '../src/types';

describe('service builder', () => {
  it('createService builds custom class', async () => {
    const Builder = createService('TEST')
      .withDescription('d')
      .withStart(
        async () =>
          new (class extends Service {
            async stop() {}
          })()
      )
      .build();
    const instance = await Builder.start({} as any);
    expect(instance).toBeInstanceOf(Service);
    await instance.stop();
  });

  it('defineService builds from definition', async () => {
    const Def = defineService({
      serviceType: 'DEF' as any,
      description: 'desc',
      start: async () =>
        new (class extends Service {
          async stop() {}
        })(),
    });
    const instance = await Def.start({} as any);
    expect(instance).toBeInstanceOf(Service);
    await instance.stop();
  });
});
