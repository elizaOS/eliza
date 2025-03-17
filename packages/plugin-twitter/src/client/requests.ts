import type { Headers as HeadersPolyfill } from 'headers-polyfill';
import setCookie from 'set-cookie-parser';
import { Cookie, type CookieJar } from 'tough-cookie';

/**
 * Updates a cookie jar with the Set-Cookie headers from the provided Headers instance.
 * @param cookieJar The cookie jar to update.
 * @param headers The response headers to populate the cookie jar with.
 */
/**
 * Updates the provided CookieJar with cookies from the given Headers or document.cookie.
 * @param {CookieJar} cookieJar - The CookieJar to update.
 * @param {Headers | HeadersPolyfill} headers - The Headers object containing cookie information.
 * @returns {Promise<void>} - A Promise that resolves once the update is complete.
 */
export async function updateCookieJar(cookieJar: CookieJar, headers: Headers | HeadersPolyfill) {
  const setCookieHeader = headers.get('set-cookie');
  if (setCookieHeader) {
    const cookies = setCookie.splitCookiesString(setCookieHeader);
    for (const cookie of cookies.map((c) => Cookie.parse(c))) {
      if (!cookie) continue;
      await cookieJar.setCookie(
        cookie,
        `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path}`
      );
    }
  } else if (typeof document !== 'undefined') {
    for (const cookie of document.cookie.split(';')) {
      const hardCookie = Cookie.parse(cookie);
      if (hardCookie) {
        await cookieJar.setCookie(hardCookie, document.location.toString());
      }
    }
  }
}
