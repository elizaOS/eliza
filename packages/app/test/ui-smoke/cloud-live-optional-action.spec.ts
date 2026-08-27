/** Real-browser regression coverage for bounded optional Cloud actions. */

import { expect, test } from "@playwright/test";
import {
  CloudLiveOptionalActionDeadlineError,
  clickCloudLiveOptionalAction,
} from "../cloud-live-optional-action";

test.describe("Cloud live optional action boundary", () => {
  test.use({ serviceWorkers: "block" });

  test("clicks a stable offered action", async ({ page }) => {
    await page.setContent(`
      <button data-testid="runtime-cloud">Sign in</button>
      <output data-testid="click-count">0</output>
      <script>
        document.addEventListener("click", (event) => {
          if (!(event.target instanceof HTMLElement)) return;
          if (event.target.dataset.testid !== "runtime-cloud") return;
          const output = document.querySelector('[data-testid="click-count"]');
          output.textContent = String(Number(output.textContent) + 1);
        });
      </script>
    `);

    await expect(
      clickCloudLiveOptionalAction(page.getByTestId("runtime-cloud"), {
        phase: "pre-identity-runtime-choice",
        action: "runtime-cloud",
        offerTimeoutMs: 500,
        actionTimeoutMs: 500,
      }),
    ).resolves.toBe(true);
    await expect(page.getByTestId("click-count")).toHaveText("1");
  });

  test("clicks a stable Personal identity retry", async ({ page }) => {
    await page.setContent(`
      <button data-testid="identity-retry">Retry</button>
      <output data-testid="retry-count">0</output>
      <script>
        document.addEventListener("click", (event) => {
          if (!(event.target instanceof HTMLElement)) return;
          if (event.target.dataset.testid !== "identity-retry") return;
          const output = document.querySelector('[data-testid="retry-count"]');
          output.textContent = String(Number(output.textContent) + 1);
        });
      </script>
    `);

    await expect(
      clickCloudLiveOptionalAction(page.getByTestId("identity-retry"), {
        phase: "personal-identity-retry",
        action: "identity-retry",
        offerTimeoutMs: 500,
        actionTimeoutMs: 500,
      }),
    ).resolves.toBe(true);
    await expect(page.getByTestId("retry-count")).toHaveText("1");
  });

  test("fails closed when an offered action is continuously replaced", async ({
    page,
  }) => {
    await page.setContent(`
      <button data-testid="runtime-cloud">Sign in</button>
      <script>
        let replacing = true;
        let offset = false;
        const replace = () => {
          if (!replacing) return;
          const current = document.querySelector('[data-testid="runtime-cloud"]');
          const replacement = current.cloneNode(true);
          offset = !offset;
          replacement.style.transform = "translateX(" + (offset ? 12 : 0) + "px)";
          current.replaceWith(replacement);
          requestAnimationFrame(replace);
        };
        requestAnimationFrame(replace);
      </script>
    `);
    await page.evaluate(
      () =>
        new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    );

    const startedAt = Date.now();
    const result = await clickCloudLiveOptionalAction(
      page.getByTestId("runtime-cloud"),
      {
        phase: "pre-identity-runtime-choice",
        action: "runtime-cloud",
        offerTimeoutMs: 500,
        actionTimeoutMs: 250,
      },
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("continuous replacement unexpectedly clicked");
    expect(result.error).toBeInstanceOf(CloudLiveOptionalActionDeadlineError);
    expect(result.error).toMatchObject({
      name: "CloudLiveOptionalActionDeadlineError",
      code: "CLOUD_LIVE_OPTIONAL_ACTION_DEADLINE",
      phase: "pre-identity-runtime-choice",
      action: "runtime-cloud",
    });
    expect(String(result.error)).not.toMatch(/data-testid|Sign in|locator/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("fails closed when a Personal identity retry is continuously replaced", async ({
    page,
  }) => {
    await page.setContent(`
      <button data-testid="identity-retry">Retry</button>
      <script>
        let offset = false;
        const replace = () => {
          const current = document.querySelector('[data-testid="identity-retry"]');
          const replacement = current.cloneNode(true);
          offset = !offset;
          replacement.style.transform = "translateX(" + (offset ? 12 : 0) + "px)";
          current.replaceWith(replacement);
          requestAnimationFrame(replace);
        };
        requestAnimationFrame(replace);
      </script>
    `);
    await page.evaluate(
      () =>
        new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    );

    const startedAt = Date.now();
    const result = await clickCloudLiveOptionalAction(
      page.getByTestId("identity-retry"),
      {
        phase: "personal-identity-retry",
        action: "identity-retry",
        offerTimeoutMs: 500,
        actionTimeoutMs: 250,
      },
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unstable retry unexpectedly clicked");
    expect(result.error).toBeInstanceOf(CloudLiveOptionalActionDeadlineError);
    expect(result.error).toMatchObject({
      name: "CloudLiveOptionalActionDeadlineError",
      code: "CLOUD_LIVE_OPTIONAL_ACTION_DEADLINE",
      phase: "personal-identity-retry",
      action: "identity-retry",
    });
    expect(String(result.error)).not.toMatch(/data-testid|Retry|locator/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
