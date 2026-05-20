import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  getPrivyAccessTokenWithRetry,
  isRetryablePrivyAccessTokenError,
} from '../../../apps/web/src/lib/auth/privyAccessToken';

describe('privy access token retry', () => {
  beforeEach(() => {
    mock.restore();
  });

  it('retries transient session fetch failures', async () => {
    const getAccessToken = mock()
      .mockRejectedValueOnce(new Error('Failed to fetch session'))
      .mockResolvedValueOnce('token-123');

    const token = await getPrivyAccessTokenWithRetry(getAccessToken, {
      maxAttempts: 2,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
    });

    expect(token).toBe('token-123');
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const getAccessToken = mock().mockRejectedValue(new Error('Invalid JWT'));

    await expect(
      getPrivyAccessTokenWithRetry(getAccessToken, {
        maxAttempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
      })
    ).rejects.toThrow('Invalid JWT');

    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('classifies network-shaped Privy errors as retryable', () => {
    expect(
      isRetryablePrivyAccessTokenError(
        new Error('Load failed while refreshing session')
      )
    ).toBe(true);
    expect(
      isRetryablePrivyAccessTokenError(new Error('Invalid JWT token'))
    ).toBe(false);
  });
});
