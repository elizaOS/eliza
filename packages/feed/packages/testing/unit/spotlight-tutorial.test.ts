import { describe, expect, it } from 'bun:test';
import { getSpotlightActivationState } from '../../../apps/web/src/components/tutorial/SpotlightTutorial';

describe('getSpotlightActivationState', () => {
  it('marks the first active step as a fresh activation', () => {
    expect(
      getSpotlightActivationState({
        hasStep: true,
        isActive: true,
        wasActive: false,
      })
    ).toEqual({
      justActivated: true,
      nextWasActive: true,
    });
  });

  it('does not re-trigger activation while the tutorial stays active', () => {
    expect(
      getSpotlightActivationState({
        hasStep: true,
        isActive: true,
        wasActive: true,
      })
    ).toEqual({
      justActivated: false,
      nextWasActive: true,
    });
  });

  it('resets the active flag when the tutorial is inactive or has no step', () => {
    expect(
      getSpotlightActivationState({
        hasStep: true,
        isActive: false,
        wasActive: true,
      })
    ).toEqual({
      justActivated: false,
      nextWasActive: false,
    });

    expect(
      getSpotlightActivationState({
        hasStep: false,
        isActive: true,
        wasActive: true,
      })
    ).toEqual({
      justActivated: false,
      nextWasActive: false,
    });
  });
});
