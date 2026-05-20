import { describe, expect, it, mock } from 'bun:test';

mock.module('@feed/api', () => ({
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

import { POST } from './route';

describe('POST /api/points/transfer', () => {
  it('returns 410 with an explicit disabled message', async () => {
    const response = (await POST(
      new Request(
        'https://example.com'
      ) as unknown as import('next/server').NextRequest
    )) as Response;
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.code).toBe('TRANSFER_POINTS_DISABLED');
    expect(body.error).toContain('Point transfers are no longer supported');
  });
});
