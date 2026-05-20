import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const marketingFooterPath = path.resolve(
  import.meta.dir,
  '../../../apps/web/src/components/shared/MarketingFooter.tsx'
);

describe('MarketingFooter links', () => {
  it('keeps main resource links and removes legacy Website link', () => {
    const source = readFileSync(marketingFooterPath, 'utf8');

    expect(source.includes('EXTERNAL_LINKS.docs')).toBe(true);
    expect(source.includes('EXTERNAL_LINKS.blog')).toBe(true);
    expect(source.includes('EXTERNAL_LINKS.github')).toBe(true);

    expect(source.includes('EXTERNAL_LINKS.website')).toBe(false);
    expect(
      source.includes('>\n                  Website\n                <')
    ).toBe(false);
  });
});
