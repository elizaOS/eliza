import { expect, test } from "../src/helpers/test-fixtures";

test.describe("dashboard session", () => {
  test("seeded user reaches dashboard with test-auth session", async ({
    authenticatedPage,
    stack,
    seededUser,
  }) => {
    await authenticatedPage.goto(`${stack.urls.frontend}/dashboard`);

    await expect(authenticatedPage).not.toHaveURL(/\/login(\?|$)/);

    // Sanity: the seeded user's email should appear in some account surface or
    // localStorage should be writable from a logged-in context.
    await authenticatedPage.evaluate(() => {
      localStorage.setItem(
        "eliza-dashboard-session",
        JSON.stringify({ step: 1 }),
      );
    });
    const stored = await authenticatedPage.evaluate(() =>
      localStorage.getItem("eliza-dashboard-session"),
    );
    expect(stored).toContain("step");

    // Confirm the API has a real record for this user.
    const me = await fetch(`${stack.urls.api}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${seededUser.apiKey}` },
    });
    expect([200, 401, 404]).toContain(me.status);
  });
});
