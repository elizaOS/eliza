import { expect, test } from "bun:test";
import {
  fetchWithoutRedirects,
  isRedirectResponse,
  NO_FOLLOW_REDIRECT,
  RedirectRefusedError,
  refuseRedirect,
  withoutRedirects,
} from "./no-redirect-fetch";

/** Mirrors workerd: "error" is a TypeError before any request is made. */
function workerdFetch(respond: () => Response) {
  const modes: Array<RequestRedirect | undefined> = [];
  const impl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    modes.push(init?.redirect);
    if (init?.redirect === "error") {
      throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    }
    return respond();
  };
  return { impl, modes };
}

function redirect(status: number) {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  // 304 is a null-body status; there is nothing to release.
  const response = new Response(status === 304 ? null : body, {
    status,
    headers: { location: "https://elsewhere.test/" },
  });
  return { response, cancelled: () => status === 304 || cancelled };
}

test("asks the platform for manual redirects, which workerd accepts", async () => {
  const { impl, modes } = workerdFetch(() => Response.json({ ok: true }));
  const response = await fetchWithoutRedirects("https://api.test/x", { method: "GET" }, impl);
  expect(response.status).toBe(200);
  expect(modes).toEqual([NO_FOLLOW_REDIRECT]);
  expect(NO_FOLLOW_REDIRECT).toBe("manual");
});

test("overrides a caller's redirect mode so nothing is ever followed", async () => {
  const { impl, modes } = workerdFetch(() => new Response("ok"));
  await withoutRedirects(impl)("https://api.test/x", { redirect: "follow" });
  expect(modes).toEqual(["manual"]);
});

for (const status of [301, 302, 303, 307, 308, 300, 304]) {
  test(`a ${status} rejects with RedirectRefusedError and releases its body`, async () => {
    const served = redirect(status);
    const { impl } = workerdFetch(() => served.response);
    const failure = await fetchWithoutRedirects("https://api.test/x", {}, impl).catch((e) => e);
    expect(failure).toBeInstanceOf(RedirectRefusedError);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as RedirectRefusedError).status).toBe(status);
    expect(served.cancelled()).toBe(true);
  });
}

test("a browser opaqueredirect (status 0) is refused too", async () => {
  const opaque = new Response(null, { status: 200 });
  Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
  Object.defineProperty(opaque, "status", { value: 0 });
  expect(isRedirectResponse(opaque)).toBe(true);
  await expect(refuseRedirect(opaque)).rejects.toBeInstanceOf(RedirectRefusedError);
});

test("non-redirect failures pass through for the caller's own status handling", async () => {
  for (const status of [200, 204, 404, 429, 500]) {
    const response = new Response(status === 204 ? null : "x", { status });
    expect(await refuseRedirect(response)).toBe(response);
  }
});
