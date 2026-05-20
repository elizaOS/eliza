import { describe, expect, it } from 'bun:test';

import {
  getLegacyCanonicalOrigin,
  isLegacyCanonicalHostname,
} from '../../../apps/web/src/lib/host-routing';

describe('host-routing (legacy redirects)', () => {
  it('identifies legacy babylon.social hosts', () => {
    expect(isLegacyCanonicalHostname('babylon.social')).toBe(true);
    expect(isLegacyCanonicalHostname('www.babylon.social')).toBe(true);
    expect(isLegacyCanonicalHostname('babylon.market')).toBe(false);
  });

  it('maps legacy babylon.social hosts to babylon.market', () => {
    expect(getLegacyCanonicalOrigin('babylon.social', 'https:')).toBe(
      'https://babylon.market'
    );
    expect(getLegacyCanonicalOrigin('www.babylon.social', 'https:')).toBe(
      'https://babylon.market'
    );
  });

  it('returns null for non-legacy hosts', () => {
    expect(getLegacyCanonicalOrigin('babylon.market', 'https:')).toBeNull();
    expect(
      getLegacyCanonicalOrigin('staging.babylon.market', 'https:')
    ).toBeNull();
  });
});
