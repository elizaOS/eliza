import { describe, it, expect } from 'vitest';
import { isOttoPayload } from '../otto/detect.js';

describe('otto/executor', () => {
  describe('isOttoPayload', () => {
    it('detects systemEvent payload', () => {
      expect(isOttoPayload({ kind: 'systemEvent', text: 'hello' })).toBe(true);
    });

    it('detects agentTurn payload', () => {
      expect(isOttoPayload({ kind: 'agentTurn', message: 'do stuff' })).toBe(true);
    });

    it('rejects prompt payload', () => {
      expect(isOttoPayload({ kind: 'prompt', text: 'hello' })).toBe(false);
    });

    it('rejects action payload', () => {
      expect(isOttoPayload({ kind: 'action', actionName: 'foo' })).toBe(false);
    });

    it('rejects event payload', () => {
      expect(isOttoPayload({ kind: 'event', eventName: 'bar' })).toBe(false);
    });

    it('rejects empty object', () => {
      expect(isOttoPayload({})).toBe(false);
    });

    it('rejects unknown kind', () => {
      expect(isOttoPayload({ kind: 'whatever' })).toBe(false);
    });
  });
});
