import { Cookie, type CookieJar } from "tough-cookie";
import setCookie from "set-cookie-parser";
import type { Headers as HeadersPolyfill } from "headers-polyfill";

/**
 * Updates a cookie jar with the Set-Cookie headers from the provided Headers instance.
 * @param cookieJar The cookie jar to update.
 * @param headers The response headers to populate the cookie jar with.
 */
export async function updateCookieJar(
	cookieJar: CookieJar,
	headers: Headers | HeadersPolyfill,
) {
	const setCookieHeader = headers.get("set-cookie");
	if (setCookieHeader) {
		const cookies = setCookie.splitCookiesString(setCookieHeader);
		for (const cookie of cookies.map((c) => Cookie.parse(c))) {
			if (!cookie) continue;
			await cookieJar.setCookie(
				cookie,
				`${cookie.secure ? "https" : "http"}://${cookie.domain}${cookie.path}`,
			);
		}
	} else if (typeof document !== "undefined") {
		for (const cookie of document.cookie.split(";")) {
			const hardCookie = Cookie.parse(cookie);
			if (hardCookie) {
				await cookieJar.setCookie(hardCookie, document.location.toString());
			}
		}
	}
}
