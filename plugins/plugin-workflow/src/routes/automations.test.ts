import { describe, expect, it, vi } from 'vitest';
import { handleAutomationsRoutes } from './automations.js';

vi.mock('../lib/automations-builder', () => ({
  buildAutomationListResponse: vi.fn(),
}));

vi.mock('./_helpers', () => ({
  getRouteOwnerEntityId: vi.fn(() => 'owner-1'),
}));

import { buildAutomationListResponse } from '../lib/automations-builder';

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    req: {},
    res: {},
    method: 'GET',
    pathname: '/api/automations',
    runtime: {},
    json: vi.fn(),
    ...overrides,
  };
}

describe('handleAutomationsRoutes', () => {
  it('declines non-GET methods so other routers can handle them', async () => {
    const c = ctx({ method: 'POST' });
    expect(await handleAutomationsRoutes(c as never)).toBe(false);
    expect(c.json).not.toHaveBeenCalled();
  });

  it('declines unknown paths', async () => {
    const c = ctx({ pathname: '/api/other' });
    expect(await handleAutomationsRoutes(c as never)).toBe(false);
    expect(c.json).not.toHaveBeenCalled();
  });

  it('answers 503 when the agent runtime is unavailable', async () => {
    const c = ctx({ runtime: null });
    expect(await handleAutomationsRoutes(c as never)).toBe(true);
    expect(c.json).toHaveBeenCalledWith(c.res, { error: 'Agent runtime is not available' }, 503);
  });

  it('answers 200 with the builder payload, scoped to the trimmed principal', async () => {
    vi.mocked(buildAutomationListResponse).mockResolvedValue({
      automations: [],
    });
    const c = ctx({ principalId: '  principal-7 ' });
    expect(await handleAutomationsRoutes(c as never)).toBe(true);
    expect(buildAutomationListResponse).toHaveBeenCalledWith(c.runtime, 'principal-7');
    expect(c.json).toHaveBeenCalledWith(c.res, { automations: [] }, 200);
  });

  it('falls back to the route owner entity when no principal is supplied', async () => {
    vi.mocked(buildAutomationListResponse).mockResolvedValue({
      automations: [],
    });
    const c = ctx();
    await handleAutomationsRoutes(c as never);
    expect(buildAutomationListResponse).toHaveBeenCalledWith(c.runtime, 'owner-1');
  });

  it('translates builder failures to a 500 with the message only (no stack leak)', async () => {
    vi.mocked(buildAutomationListResponse).mockRejectedValue(new Error('boom'));
    const c = ctx();
    expect(await handleAutomationsRoutes(c as never)).toBe(true);
    expect(c.json).toHaveBeenCalledWith(c.res, { error: 'boom' }, 500);
  });

  it('handles non-Error throws from the builder', async () => {
    vi.mocked(buildAutomationListResponse).mockRejectedValue('string failure');
    const c = ctx();
    expect(await handleAutomationsRoutes(c as never)).toBe(true);
    expect(c.json).toHaveBeenCalledWith(c.res, { error: 'string failure' }, 500);
  });
});
