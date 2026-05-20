// Game Guide - Unit/Specification Tests

import { describe, expect, test } from 'bun:test';
import { GAME_GUIDE_SLIDES } from '../../../apps/web/src/components/onboarding/game-guide-slides';

describe('Game Guide - Slide Content', () => {
  test('should have exactly 5 slides', () => {
    expect(GAME_GUIDE_SLIDES.length).toBe(5);
  });

  test('each slide should have a non-empty title', () => {
    for (const slide of GAME_GUIDE_SLIDES) {
      expect(slide.title).toBeDefined();
      expect(slide.title.length).toBeGreaterThan(0);
    }
  });

  test('each slide should have a non-empty description', () => {
    for (const slide of GAME_GUIDE_SLIDES) {
      expect(slide.description).toBeDefined();
      expect(slide.description.length).toBeGreaterThan(10);
    }
  });

  test('slide titles should be unique', () => {
    const titles = GAME_GUIDE_SLIDES.map((s) => s.title);
    const uniqueTitles = new Set(titles);
    expect(uniqueTitles.size).toBe(titles.length);
  });

  test('first slide should be Welcome', () => {
    expect(GAME_GUIDE_SLIDES[0]!.title).toContain('Welcome');
  });

  test('last slide should be the CTA slide', () => {
    const lastSlide = GAME_GUIDE_SLIDES[GAME_GUIDE_SLIDES.length - 1]!;
    expect(lastSlide.title).toContain('Trade');
    expect('ctas' in lastSlide).toBe(true);
    if (!('ctas' in lastSlide) || !lastSlide.ctas) {
      throw new Error('Expected last slide to include CTAs');
    }
    expect(lastSlide.ctas.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Game Guide - Navigation Logic', () => {
  class SlideNavigator {
    currentSlide = 0;
    completed = false;
    totalSlides: number;

    constructor(totalSlides: number) {
      this.totalSlides = totalSlides;
    }

    get isFirstSlide() {
      return this.currentSlide === 0;
    }

    get isLastSlide() {
      return this.currentSlide === this.totalSlides - 1;
    }

    goToNext(): boolean {
      if (this.isLastSlide) {
        this.completed = true;
        return true; // Completed
      }
      this.currentSlide++;
      return false;
    }

    goToPrevious(): boolean {
      if (this.isFirstSlide) {
        return false; // No action
      }
      this.currentSlide--;
      return true;
    }

    goToSlide(index: number): boolean {
      if (index < 0 || index >= this.totalSlides) {
        return false;
      }
      this.currentSlide = index;
      return true;
    }
  }

  test('should start at slide 0', () => {
    const nav = new SlideNavigator(5);
    expect(nav.currentSlide).toBe(0);
    expect(nav.isFirstSlide).toBe(true);
    expect(nav.isLastSlide).toBe(false);
  });

  test('goToNext should increment slide', () => {
    const nav = new SlideNavigator(5);
    nav.goToNext();
    expect(nav.currentSlide).toBe(1);
  });

  test('goToNext on last slide should mark completed', () => {
    const nav = new SlideNavigator(5);
    nav.currentSlide = 4;
    expect(nav.isLastSlide).toBe(true);
    const completed = nav.goToNext();
    expect(completed).toBe(true);
    expect(nav.completed).toBe(true);
  });

  test('goToPrevious should decrement slide', () => {
    const nav = new SlideNavigator(5);
    nav.currentSlide = 2;
    nav.goToPrevious();
    expect(nav.currentSlide).toBe(1);
  });

  test('goToPrevious on first slide should do nothing', () => {
    const nav = new SlideNavigator(5);
    expect(nav.isFirstSlide).toBe(true);
    const result = nav.goToPrevious();
    expect(result).toBe(false);
    expect(nav.currentSlide).toBe(0);
  });

  test('should navigate through all slides to completion', () => {
    const nav = new SlideNavigator(5);
    const visitedSlides: number[] = [];

    while (!nav.completed) {
      visitedSlides.push(nav.currentSlide);
      nav.goToNext();
    }

    expect(visitedSlides).toEqual([0, 1, 2, 3, 4]);
    expect(nav.completed).toBe(true);
  });

  test('goToSlide should reject invalid indices', () => {
    const nav = new SlideNavigator(5);
    expect(nav.goToSlide(-1)).toBe(false);
    expect(nav.goToSlide(5)).toBe(false);
    expect(nav.goToSlide(100)).toBe(false);
    expect(nav.currentSlide).toBe(0); // Unchanged
  });

  test('goToSlide should accept valid indices', () => {
    const nav = new SlideNavigator(5);
    expect(nav.goToSlide(3)).toBe(true);
    expect(nav.currentSlide).toBe(3);
    expect(nav.goToSlide(0)).toBe(true);
    expect(nav.currentSlide).toBe(0);
  });

  test('boundary: single slide guide', () => {
    const nav = new SlideNavigator(1);
    expect(nav.isFirstSlide).toBe(true);
    expect(nav.isLastSlide).toBe(true);
    nav.goToNext();
    expect(nav.completed).toBe(true);
  });

  test('boundary: two slide guide', () => {
    const nav = new SlideNavigator(2);
    expect(nav.isFirstSlide).toBe(true);
    expect(nav.isLastSlide).toBe(false);
    nav.goToNext();
    expect(nav.currentSlide).toBe(1);
    expect(nav.isLastSlide).toBe(true);
    nav.goToNext();
    expect(nav.completed).toBe(true);
  });
});

describe('Game Guide - Display Logic', () => {
  interface UserState {
    authenticated: boolean;
    profileComplete: boolean;
    isActor: boolean;
    gameGuideCompletedAt: string | null;
    needsOnboarding: boolean;
  }

  function shouldShowGuide(state: UserState): boolean {
    return (
      state.authenticated &&
      state.profileComplete &&
      !state.isActor &&
      !state.gameGuideCompletedAt &&
      !state.needsOnboarding
    );
  }

  const baseUser: UserState = {
    authenticated: true,
    profileComplete: true,
    isActor: false,
    gameGuideCompletedAt: null,
    needsOnboarding: false,
  };

  test('should show for first-time authenticated user with complete profile', () => {
    expect(shouldShowGuide(baseUser)).toBe(true);
  });

  test('should NOT show for unauthenticated user', () => {
    expect(shouldShowGuide({ ...baseUser, authenticated: false })).toBe(false);
  });

  test('should NOT show for user still in profile onboarding', () => {
    expect(shouldShowGuide({ ...baseUser, needsOnboarding: true })).toBe(false);
  });

  test('should NOT show for actors/NPCs', () => {
    expect(shouldShowGuide({ ...baseUser, isActor: true })).toBe(false);
  });

  test('should NOT show if already completed', () => {
    expect(
      shouldShowGuide({
        ...baseUser,
        gameGuideCompletedAt: '2025-01-06T12:00:00.000Z',
      })
    ).toBe(false);
  });

  test('should NOT show for incomplete profile', () => {
    expect(shouldShowGuide({ ...baseUser, profileComplete: false })).toBe(
      false
    );
  });

  test('multiple conditions: actor with incomplete profile', () => {
    expect(
      shouldShowGuide({
        ...baseUser,
        isActor: true,
        profileComplete: false,
      })
    ).toBe(false);
  });

  test('edge case: all conditions false except authenticated', () => {
    expect(
      shouldShowGuide({
        authenticated: true,
        profileComplete: false,
        isActor: true,
        gameGuideCompletedAt: '2025-01-01T00:00:00.000Z',
        needsOnboarding: true,
      })
    ).toBe(false);
  });
});

describe('Game Guide - Completion Tracking', () => {
  test('completion timestamp should be valid ISO-8601', () => {
    const timestamp = new Date().toISOString();
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  test('should parse completion timestamp correctly', () => {
    const timestamp = '2025-01-06T19:52:48.599Z';
    const date = new Date(timestamp);
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(0); // January
    expect(date.getDate()).toBe(6);
  });

  test('should detect completed vs not completed', () => {
    const hasCompleted = (timestamp: string | null): boolean =>
      Boolean(timestamp);

    expect(hasCompleted(null)).toBe(false);
    expect(hasCompleted('2025-01-06T19:52:48.599Z')).toBe(true);
  });

  test('should handle empty string as not completed', () => {
    // Empty string is falsy in JS, should be treated as not completed
    const timestamp = '';
    expect(Boolean(timestamp)).toBe(false);
  });
});

describe('Game Guide - Keyboard Navigation', () => {
  type KeyHandler = (key: string) => void;

  function createKeyboardHandler(
    onNext: () => void,
    onPrev: () => void
  ): KeyHandler {
    return (key: string) => {
      if (key === 'ArrowRight' || key === 'Enter') {
        onNext();
      } else if (key === 'ArrowLeft') {
        onPrev();
      }
      // Escape is intentionally not handled (cannot skip)
    };
  }

  test('ArrowRight should trigger next', () => {
    let nextCalled = false;
    const handler = createKeyboardHandler(
      () => (nextCalled = true),
      () => {}
    );
    handler('ArrowRight');
    expect(nextCalled).toBe(true);
  });

  test('Enter should trigger next', () => {
    let nextCalled = false;
    const handler = createKeyboardHandler(
      () => (nextCalled = true),
      () => {}
    );
    handler('Enter');
    expect(nextCalled).toBe(true);
  });

  test('ArrowLeft should trigger previous', () => {
    let prevCalled = false;
    const handler = createKeyboardHandler(
      () => {},
      () => (prevCalled = true)
    );
    handler('ArrowLeft');
    expect(prevCalled).toBe(true);
  });

  test('Escape should NOT close modal (no skip)', () => {
    let anyCalled = false;
    const handler = createKeyboardHandler(
      () => (anyCalled = true),
      () => (anyCalled = true)
    );
    handler('Escape');
    expect(anyCalled).toBe(false);
  });

  test('random keys should be ignored', () => {
    let anyCalled = false;
    const handler = createKeyboardHandler(
      () => (anyCalled = true),
      () => (anyCalled = true)
    );
    handler('a');
    handler('Space');
    handler('Tab');
    expect(anyCalled).toBe(false);
  });
});

describe('Game Guide - Progress Indicator', () => {
  function getProgressState(
    currentSlide: number,
    totalSlides: number
  ): ('current' | 'completed' | 'pending')[] {
    return Array.from({ length: totalSlides }, (_, i) => {
      if (i === currentSlide) return 'current';
      if (i < currentSlide) return 'completed';
      return 'pending';
    });
  }

  test('first slide should show first dot as current', () => {
    const state = getProgressState(0, 5);
    expect(state).toEqual([
      'current',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  test('middle slide should show correct states', () => {
    const state = getProgressState(2, 5);
    expect(state).toEqual([
      'completed',
      'completed',
      'current',
      'pending',
      'pending',
    ]);
  });

  test('last slide should show all previous as completed', () => {
    const state = getProgressState(4, 5);
    expect(state).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'current',
    ]);
  });
});
