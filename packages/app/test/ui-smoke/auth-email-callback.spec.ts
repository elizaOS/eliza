/**
 * Real hosted callback, Steward SDK, session publication, and browser navigation
 * against a deterministic one-use HTTP boundary. No email is sent and no
 * Steward/database verifier runs here. Run with VITE_PLAYWRIGHT_TEST_AUTH=false
 * so the production auth provider owns the complete callback exchange.
 */
import { expect, test } from "@playwright/test";
import { createStewardSessionToken } from "./helpers/test-auth";

const TEST_AUTH_ENABLED =
  process.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true";

test("fresh email callback commits its session before navigation and rejects replay", async ({
  page,
}) => {
  test.skip(
    TEST_AUTH_ENABLED,
    "requires production Steward auth provider; run with VITE_PLAYWRIGHT_TEST_AUTH=false and NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH=false",
  );
  const email = "callback-browser@example.test";
  const proof = "single-use-browser-proof";
  const token = createStewardSessionToken({ jwt: true, email });
  let consumed = false;
  let verifyRequests = 0;
  let sessionRequests = 0;
  let releaseSession: () => void = () => {
    throw new Error("Session gate not initialized");
  };
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/steward/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/email/verify")) {
      verifyRequests += 1;
      const request = route.request().postDataJSON();
      expect(route.request().method()).toBe("POST");
      expect(request).toMatchObject({ email, token: proof });
      const accepted = !consumed;
      consumed = true;
      await route.fulfill({
        status: accepted ? 200 : 401,
        json: accepted
          ? { token, user: { id: "ui-smoke-user", email }, expiresIn: 900 }
          : { error: "One-time credential rejected" },
      });
      return;
    }
    await route.fulfill({ status: 401, json: { error: "No session" } });
  });
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) =>
    route.fulfill({ status: 401, json: { error: "No fixture session" } }),
  );
  await page.route(/^https?:\/\/[^/]+\/api\/auth\//, async (route) => {
    if (
      new URL(route.request().url()).pathname.endsWith("/steward-session") &&
      route.request().method() === "POST"
    ) {
      sessionRequests += 1;
      expect(route.request().postDataJSON()).toMatchObject({ token });
      await sessionGate;
      await route.fulfill({
        status: 200,
        json: { ok: true },
        headers: {
          "Set-Cookie":
            "callback_session=committed; Path=/; HttpOnly; SameSite=Lax",
        },
      });
      return;
    }
    await route.fulfill({ status: 401, json: { error: "No session" } });
  });
  const callback = `/auth/callback/email?token=${proof}&email=${encodeURIComponent(email)}`;
  await page.goto(callback, { waitUntil: "domcontentloaded" });
  await expect
    .poll(() => sessionRequests, { timeout: 90_000 })
    .toBeGreaterThan(0);
  // Outlast the success redirect while the session response is withheld.
  // A fire-and-forget cookie sync must not appear to finish authentication.
  await page.waitForTimeout(2_000);
  expect(verifyRequests).toBe(1);
  expect(new URL(page.url()).pathname).toBe("/auth/callback/email");
  expect(new URL(page.url()).searchParams.has("token")).toBe(false);
  expect(new URL(page.url()).searchParams.has("email")).toBe(false);
  const joined = page.waitForURL("**/join");
  releaseSession();
  await joined;
  expect(
    (await page.context().cookies()).some(
      (cookie) => cookie.name === "callback_session" && cookie.httpOnly,
    ),
  ).toBe(true);
  // Replay in a signed-out browser document; an existing session otherwise
  // legitimately triggers its own passive cookie sync during boot.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.context().clearCookies();
  const committedRequests = sessionRequests;
  await page.goto(callback, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Sign-in failed" }),
  ).toBeVisible();
  await expect(page.getByText(/expired or was already used/)).toBeVisible();
  expect(verifyRequests).toBe(2);
  expect(sessionRequests).toBe(committedRequests);
  await page.getByRole("link", { name: /Back to login/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(pageErrors).toEqual([]);
});
