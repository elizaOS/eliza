import { describe, expect, it } from 'bun:test';
import {
  clearChartContainer,
  getChartInitializationFailureMessage,
} from '../../../../apps/web/src/components/charts/LightweightChartBase';

describe('LightweightChartBase helpers', () => {
  describe('clearChartContainer', () => {
    it('clears stale chart DOM before a retry', () => {
      const container = {
        childElementCount: 2,
        replaceChildren() {
          this.childElementCount = 0;
        },
      };

      clearChartContainer(container);

      expect(container.childElementCount).toBe(0);
    });

    it('leaves an already empty container untouched', () => {
      let replaceCalls = 0;
      const container = {
        childElementCount: 0,
        replaceChildren() {
          replaceCalls += 1;
        },
      };

      clearChartContainer(container);

      expect(replaceCalls).toBe(0);
    });
  });

  describe('getChartInitializationFailureMessage', () => {
    it('keeps the underlying createChart error when one was captured', () => {
      expect(
        getChartInitializationFailureMessage({
          height: 661,
          lastCreateErrorMessage: 'Canvas context is null',
          width: 680,
        })
      ).toBe('Canvas context is null');
    });

    it('falls back to the container dimensions when no createChart error exists', () => {
      expect(
        getChartInitializationFailureMessage({
          height: 661,
          width: 680,
        })
      ).toBe('Chart failed to initialize (container 680x661).');
    });
  });
});
