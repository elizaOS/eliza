import { afterAll, expect, it, mock } from 'bun:test';

const initMock = mock<(key: string, options?: Record<string, unknown>) => void>(
  () => {}
);
const infoMock = mock(() => {});
const warnMock = mock(() => {});

mock.module('posthog-js', () => ({
  default: {
    init: initMock,
  },
}));

mock.module('@babylon/shared', () => ({
  logger: {
    info: infoMock,
    warn: warnMock,
  },
}));

const originalWindow = globalThis.window;
const originalPostHogProjectId = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID;
const originalPostHogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
const originalVercelEnv = process.env.NEXT_PUBLIC_VERCEL_ENV;

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });

  if (originalPostHogProjectId === undefined) {
    delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID;
  } else {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID = originalPostHogProjectId;
  }

  if (originalPostHogHost === undefined) {
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  } else {
    process.env.NEXT_PUBLIC_POSTHOG_HOST = originalPostHogHost;
  }

  if (originalVercelEnv === undefined) {
    delete process.env.NEXT_PUBLIC_VERCEL_ENV;
  } else {
    process.env.NEXT_PUBLIC_VERCEL_ENV = originalVercelEnv;
  }
});

it('initializes PostHog without automatic exception capture', async () => {
  process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID = 'phc_test_key';
  process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
  process.env.NEXT_PUBLIC_VERCEL_ENV = 'production';

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://babylon.market' } },
  });

  const { initPostHog } = await import('./client');

  initPostHog();

  expect(initMock).toHaveBeenCalledTimes(1);

  const [, options] = initMock.mock.calls[0] as unknown as [
    unknown,
    { capture_pageview: boolean; capture_exceptions: boolean },
  ];
  expect(options.capture_pageview).toBe(false);
  expect(options.capture_exceptions).toBe(false);
});
