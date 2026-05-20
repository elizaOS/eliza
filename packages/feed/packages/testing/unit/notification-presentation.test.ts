import { describe, expect, test } from 'bun:test';
import { getNotificationPresentation } from '../../../apps/web/src/lib/notifications/presentation';

describe('getNotificationPresentation', () => {
  test('shows explicit title and message for reward notifications', () => {
    const presentation = getNotificationPresentation({
      type: 'achievement_unlocked',
      title: 'Achievement Unlocked: Macro Hunter',
      message: 'Epic tier - +250 points',
      actor: null,
    });

    expect(presentation).toEqual({
      isSystemStyle: true,
      title: 'Achievement Unlocked: Macro Hunter',
      message: 'Epic tier - +250 points',
    });
  });

  test('keeps actor notifications in actor layout', () => {
    const presentation = getNotificationPresentation({
      type: 'follow',
      title: 'New Follower',
      message: 'Alice started following you',
      actor: { displayName: 'Alice' },
    });

    expect(presentation).toEqual({
      isSystemStyle: false,
      title: null,
      message: 'Alice started following you',
    });
  });
});
