/**
 * E2E Tests: Landing Page Blog Links
 *
 * Tests the blog link feature on the landing page:
 * - Blog link card in CTA section renders correctly
 * - Blog links in footer (mobile and desktop) render correctly
 * - Links have correct href and open in new tab
 */

import { expect, test } from "@playwright/test";

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  process.env.TEST_API_URL?.replace(/\/api$/, "") ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://127.0.0.1:3400";

const EXPECTED_BLOG_URL =
  process.env.NEXT_PUBLIC_BLOG_URL || "https://blog.feed.market";
const EXPECTED_GITHUB_URL = "https://github.com/FeedSocial/feed";

test.describe("Landing Page Blog Links", () => {
  // Landing page redirects to /feed; blog links are not exposed on that route.
  test.skip();

  test.beforeEach(async ({ page }) => {
    // Navigate to the landing page
    await page.goto(BASE_URL);
    await page.waitForLoadState("domcontentloaded");
  });

  test("should display blog link card in CTA section with correct attributes", async ({
    page,
  }) => {
    // Find the "Read Blog" link in the CTA section
    const blogCard = page.locator('a:has-text("Read Blog")').first();

    // Check the link is visible
    await expect(blogCard).toBeVisible({ timeout: 10000 });

    // Verify href attribute points to the blog URL
    const href = await blogCard.getAttribute("href");
    expect(href).toBe(EXPECTED_BLOG_URL);

    // Verify link opens in new tab
    const target = await blogCard.getAttribute("target");
    expect(target).toBe("_blank");

    // Verify security attributes for external link
    const rel = await blogCard.getAttribute("rel");
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");

    // Verify subtext is present
    const subtextLocator = blogCard.locator("text=Explore our innovation");
    await expect(subtextLocator).toBeVisible();
  });

  test("should render a single combined develop and deploy card", async ({
    page,
  }) => {
    const developCard = page
      .locator("a")
      .filter({ has: page.locator('h3:has-text("Develop and Deploy")') })
      .first();

    await expect(developCard).toBeVisible({ timeout: 10000 });
    await expect(
      developCard.locator('p:has-text("Apply for Agent Developer Access")'),
    ).toBeVisible();

    const href = await developCard.getAttribute("href");
    expect(href).toBe(EXPECTED_GITHUB_URL);

    const separateApplyHeading = page.locator(
      'a h3:has-text("Apply for agent developer access")',
    );
    await expect(separateApplyHeading).toHaveCount(0);
  });

  test("should display blog link in desktop footer resources section", async ({
    page,
  }) => {
    // Set viewport to desktop size
    await page.setViewportSize({ width: 1280, height: 800 });

    // Scroll to footer
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);

    // Find the footer Resources section
    const footerResourcesSection = page
      .locator("footer")
      .locator('h3:has-text("Resources")');
    await expect(footerResourcesSection.first()).toBeVisible({ timeout: 5000 });

    // Find blog link in footer
    const footerBlogLink = page
      .locator("footer")
      .locator('a:has-text("Blog")')
      .first();

    await expect(footerBlogLink).toBeVisible();

    // Verify href attribute
    const href = await footerBlogLink.getAttribute("href");
    expect(href).toBe(EXPECTED_BLOG_URL);

    // Verify opens in new tab
    const target = await footerBlogLink.getAttribute("target");
    expect(target).toBe("_blank");
  });

  test("should display blog link in mobile footer resources section", async ({
    page,
  }) => {
    // Set viewport to mobile size
    await page.setViewportSize({ width: 375, height: 667 });

    // Scroll to footer
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);

    // Find the mobile footer Resources section (visible on sm:hidden)
    const mobileResourcesSection = page
      .locator("footer")
      .locator('h3:has-text("RESOURCES")');
    await expect(mobileResourcesSection.first()).toBeVisible({ timeout: 5000 });

    // Find blog link in mobile footer
    const mobileBlogLink = page
      .locator("footer")
      .locator('a:has-text("Blog")')
      .first();

    await expect(mobileBlogLink).toBeVisible();

    // Verify href attribute
    const href = await mobileBlogLink.getAttribute("href");
    expect(href).toBe(EXPECTED_BLOG_URL);

    // Verify opens in new tab
    const target = await mobileBlogLink.getAttribute("target");
    expect(target).toBe("_blank");
  });

  test("should have accessible blog links with proper semantics", async ({
    page,
  }) => {
    // Check all blog links have proper accessibility
    const blogLinks = page.locator(
      'a:has-text("Blog"), a:has-text("Read Blog")',
    );
    const count = await blogLinks.count();

    // Should have at least 2 blog links (CTA card + footer)
    expect(count).toBeGreaterThanOrEqual(2);

    // Check each link is accessible
    for (let i = 0; i < count; i++) {
      const link = blogLinks.nth(i);

      // Link should be focusable
      await link.focus();
      await expect(link).toBeFocused();

      // Link should have valid href
      const href = await link.getAttribute("href");
      expect(href).toBeTruthy();
      expect(href).toMatch(/^https?:\/\//);
    }
  });
});
