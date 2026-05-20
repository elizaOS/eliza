import { describe, expect, it } from 'bun:test';
import type { PortfolioBreakdownSnapshot } from '@feed/engine/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PortfolioPnLCard } from '../../../../apps/web/src/components/markets/PortfolioPnLCard';

const snapshot: PortfolioBreakdownSnapshot = {
  wallet: 0,
  agents: 0,
  positions: 0,
  available: 0,
  netPeerTransfers: 0,
  originalAmount: 0,
  totalAssets: 0,
  totalPnL: 0,
  agentCount: 0,
};

describe('PortfolioPnLCard rendering', () => {
  const noop = () => {};

  it('disabled when loading', () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioPnLCard, {
        data: snapshot,
        loading: true,
        onShare: noop,
        onShowBuyPoints: noop,
      })
    );
    expect(html).toMatch(/<button[^>]*\sdisabled(=|\s|>)[^>]*>.*Share P&amp;L/);
  });

  it('disabled when no data', () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioPnLCard, {
        data: null,
        loading: false,
        onShare: noop,
        onShowBuyPoints: noop,
      })
    );
    expect(html).toMatch(/<button[^>]*\sdisabled(=|\s|>)[^>]*>.*Share P&amp;L/);
  });

  it('enabled when has data and not loading', () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioPnLCard, {
        data: snapshot,
        loading: false,
        onShare: noop,
        onShowBuyPoints: noop,
      })
    );
    expect(html).not.toMatch(
      /<button[^>]*\sdisabled(=|\s|>)[^>]*>.*Share P&amp;L/
    );
  });

  it('adds an accessible name for Buy Points', () => {
    const html = renderToStaticMarkup(
      createElement(PortfolioPnLCard, {
        data: snapshot,
        loading: false,
        onShare: noop,
        onShowBuyPoints: noop,
      })
    );
    expect(html).toContain('aria-label="Buy Points"');
  });
});
