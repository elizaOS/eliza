import { describe, expect, test } from 'bun:test';
import { detectDevice } from './react-device-detect-shim';

describe('detectDevice', () => {
  test('returns all false when navigator is undefined (SSR)', () => {
    expect(detectDevice(undefined)).toEqual({
      isAndroid: false,
      isFirefox: false,
      isIOS: false,
      isMobile: false,
      isSafari: false,
    });
  });

  test('detects Firefox on iOS without touching vendor globals', () => {
    expect(
      detectDevice({
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15',
      })
    ).toEqual({
      isAndroid: false,
      isFirefox: true,
      isIOS: true,
      isMobile: true,
      isSafari: false,
    });
  });

  test('treats iPadOS desktop user agents as iOS mobile devices', () => {
    expect(
      detectDevice({
        maxTouchPoints: 5,
        platform: 'MacIntel',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      })
    ).toEqual({
      isAndroid: false,
      isFirefox: false,
      isIOS: true,
      isMobile: true,
      isSafari: true,
    });
  });

  test('detects Android Chrome as mobile but not Safari or Firefox', () => {
    expect(
      detectDevice({
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
      })
    ).toEqual({
      isAndroid: true,
      isFirefox: false,
      isIOS: false,
      isMobile: true,
      isSafari: false,
    });
  });

  test('detects desktop Safari as non-mobile', () => {
    expect(
      detectDevice({
        platform: 'MacIntel',
        maxTouchPoints: 0,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      })
    ).toEqual({
      isAndroid: false,
      isFirefox: false,
      isIOS: false,
      isMobile: false,
      isSafari: true,
    });
  });

  test('detects desktop Chrome as none of the target flags', () => {
    expect(
      detectDevice({
        platform: 'MacIntel',
        maxTouchPoints: 0,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      })
    ).toEqual({
      isAndroid: false,
      isFirefox: false,
      isIOS: false,
      isMobile: false,
      isSafari: false,
    });
  });
});
