/** Real-browser regression coverage for bounded optional Cloud actions. */

import { expect, type Locator, test } from "@playwright/test";
import {
  CloudLiveOptionalActionDeadlineError,
  CloudLivePersonalIdentityDeadlineError,
  CloudLivePersonalIdentityRecoveryError,
  clickCloudLiveOptionalAction,
  prepareCloudLivePersonalIdentity,
  waitForCloudLivePersonalIdentity,
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

  test("allows post-choice overlay removal while the binding resolves", async ({
    page,
  }) => {
    await page.setContent(`
      <main data-testid="chat-overlay">
        <button data-testid="runtime-cloud">Use Cloud</button>
      </main>
      <script>
        document.addEventListener("click", (event) => {
          if (!(event.target instanceof HTMLElement)) return;
          if (event.target.dataset.testid !== "runtime-cloud") return;
          document.querySelector('[data-testid="chat-overlay"]').remove();
          setTimeout(() => { window.__testActiveBinding = "dedicated"; }, 25);
        });
      </script>
    `);
    await expect(page.getByTestId("chat-overlay")).toBeVisible();

    await prepareCloudLivePersonalIdentity({
      chooseRuntime: true,
      chatOverlay: page.getByTestId("chat-overlay"),
      chatOverlayTimeoutMs: 500,
      chooseRuntimeAction: async () => {
        await expect(
          clickCloudLiveOptionalAction(page.getByTestId("runtime-cloud"), {
            phase: "pre-identity-runtime-choice",
            action: "runtime-cloud",
            offerTimeoutMs: 500,
            actionTimeoutMs: 500,
          }),
        ).resolves.toBe(true);
      },
    });
    await expect(page.getByTestId("chat-overlay")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __testActiveBinding?: string })
              .__testActiveBinding ?? null,
        ),
      )
      .toBe("dedicated");
  });

  test("skips a detached post-choice overlay gate while a valid binding resolves", async ({
    page,
  }) => {
    await page.setContent(`
      <main data-testid="chat-overlay">Transitioning</main>
      <script>
        const churn = () => {
          const current = document.querySelector('[data-testid="chat-overlay"]');
          if (current) current.remove();
          else document.body.insertAdjacentHTML("afterbegin", '<main data-testid="chat-overlay">Transitioning</main>');
          requestAnimationFrame(churn);
        };
        requestAnimationFrame(churn);
        setTimeout(() => { window.__testActiveBinding = "dedicated"; }, 25);
      </script>
    `);
    let runtimeChoiceCalled = false;

    await prepareCloudLivePersonalIdentity({
      chooseRuntime: false,
      chatOverlay: page.getByTestId("chat-overlay"),
      chatOverlayTimeoutMs: 100,
      chooseRuntimeAction: async () => {
        runtimeChoiceCalled = true;
      },
    });
    expect(runtimeChoiceCalled).toBe(false);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __testActiveBinding?: string })
              .__testActiveBinding ?? null,
        ),
      )
      .toBe("dedicated");
  });

  test("fails closed when a post-choice binding and retry both remain absent", async ({
    page,
  }) => {
    await page.setContent("<main>Transitioning</main>");
    await prepareCloudLivePersonalIdentity({
      chooseRuntime: false,
      chatOverlay: page.getByTestId("chat-overlay"),
      chatOverlayTimeoutMs: 100,
      chooseRuntimeAction: async () => {
        throw new Error("post-choice runtime action must not repeat");
      },
    });

    const result = await expect
      .poll(
        async () =>
          Boolean(
            await page.evaluate(
              () =>
                (window as typeof window & { __testActiveBinding?: string })
                  .__testActiveBinding,
            ),
          ) || (await page.getByTestId("identity-retry").isVisible()),
        { timeout: 100 },
      )
      .toBe(true)
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    expect(result.ok).toBe(false);
  });

  test("resolves one stable binding without replaying a recovery action", async ({
    page,
  }) => {
    await page.setContent(`
      <main>Transitioning</main>
      <script>
        setTimeout(() => { window.__testActiveBinding = "dedicated"; }, 25);
      </script>
    `);
    let recoveryObserved = false;

    await expect(
      waitForCloudLivePersonalIdentity({
        readBinding: () =>
          page.evaluate(
            () =>
              (window as typeof window & { __testActiveBinding?: string })
                .__testActiveBinding ?? null,
          ),
        runtimeCloudRecovery: page.getByTestId("runtime-cloud"),
        retryRecovery: page.getByTestId("identity-retry"),
        timeoutMs: 500,
        runtimeCloudGraceMs: 50,
        pollIntervalMs: 5,
        onRecovery: () => {
          recoveryObserved = true;
        },
      }),
    ).resolves.toBe("dedicated");
    expect(recoveryObserved).toBe(false);
  });

  test("fails with the closed runtime-cloud recovery after the initial choice reappears", async ({
    page,
  }) => {
    await page.setContent(`
      <button data-testid="runtime-cloud">Use Cloud</button>
      <script>
        setTimeout(() => {
          document.querySelector('[data-testid="runtime-cloud"]').remove();
        }, 10);
        setTimeout(() => {
          document.body.insertAdjacentHTML("beforeend", '<button data-testid="runtime-cloud">Use Cloud</button>');
        }, 30);
      </script>
    `);
    const recoveries: string[] = [];

    const result = await waitForCloudLivePersonalIdentity({
      readBinding: async () => null,
      runtimeCloudRecovery: page.getByTestId("runtime-cloud"),
      retryRecovery: page.getByTestId("identity-retry"),
      timeoutMs: 500,
      runtimeCloudGraceMs: 100,
      pollIntervalMs: 5,
      onRecovery: (recovery) => {
        recoveries.push(recovery);
      },
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("runtime recovery unexpectedly resolved");
    expect(result.error).toBeInstanceOf(CloudLivePersonalIdentityRecoveryError);
    expect(result.error).toMatchObject({
      code: "CLOUD_LIVE_PERSONAL_IDENTITY_RECOVERY",
      recovery: "runtime-cloud",
    });
    expect(recoveries).toEqual(["runtime-cloud"]);
    expect(String(result.error)).not.toMatch(/data-testid|Use Cloud|locator/);
  });

  test("fails with the closed retry recovery without clicking it", async ({
    page,
  }) => {
    await page.setContent(`
      <button data-testid="identity-retry">Retry</button>
      <output data-testid="retry-count">0</output>
      <script>
        document.addEventListener("click", () => {
          document.querySelector('[data-testid="retry-count"]').textContent = "1";
        });
      </script>
    `);

    await expect(
      waitForCloudLivePersonalIdentity({
        readBinding: async () => null,
        runtimeCloudRecovery: page.getByTestId("runtime-cloud"),
        retryRecovery: page.getByTestId("identity-retry"),
        timeoutMs: 500,
        runtimeCloudGraceMs: 50,
        pollIntervalMs: 5,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_LIVE_PERSONAL_IDENTITY_RECOVERY",
      recovery: "retry",
    });
    await expect(page.getByTestId("retry-count")).toHaveText("0");
  });

  test("preserves the typed recovery when its diagnostic sink rejects", async ({
    page,
  }) => {
    await page.setContent(
      '<button data-testid="identity-retry">Retry</button>',
    );

    await expect(
      waitForCloudLivePersonalIdentity({
        readBinding: async () => null,
        runtimeCloudRecovery: page.getByTestId("runtime-cloud"),
        retryRecovery: page.getByTestId("identity-retry"),
        timeoutMs: 500,
        runtimeCloudGraceMs: 50,
        pollIntervalMs: 5,
        onRecovery: async () => {
          throw new Error("diagnostic sink unavailable");
        },
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_LIVE_PERSONAL_IDENTITY_RECOVERY",
      recovery: "retry",
    });
  });

  test("fails with a closed deadline when binding and recovery stay absent", async ({
    page,
  }) => {
    await page.setContent("<main>Transitioning</main>");

    await expect(
      waitForCloudLivePersonalIdentity({
        readBinding: async () => null,
        runtimeCloudRecovery: page.getByTestId("runtime-cloud"),
        retryRecovery: page.getByTestId("identity-retry"),
        timeoutMs: 50,
        runtimeCloudGraceMs: 10,
        pollIntervalMs: 5,
      }),
    ).rejects.toBeInstanceOf(CloudLivePersonalIdentityDeadlineError);
  });

  for (const hungPhase of [
    "read-binding",
    "retry-visibility",
    "runtime-visibility",
    "recovery-diagnostic",
  ] as const) {
    test(`bounds a hung ${hungPhase} operation by the same absolute identity deadline`, async ({
      page,
    }) => {
      const pending = async () => await new Promise<never>(() => undefined);
      const hidden = {
        isVisible: async () => false,
      } as unknown as Locator;
      const visible = {
        isVisible: async () => true,
      } as unknown as Locator;
      const hung = {
        isVisible: pending,
      } as unknown as Locator;
      const startedAt = Date.now();

      await expect(
        waitForCloudLivePersonalIdentity({
          readBinding:
            hungPhase === "read-binding" ? pending : async () => null,
          retryRecovery:
            hungPhase === "retry-visibility"
              ? hung
              : hungPhase === "recovery-diagnostic"
                ? visible
                : hidden,
          runtimeCloudRecovery:
            hungPhase === "runtime-visibility" ? hung : hidden,
          timeoutMs: 50,
          runtimeCloudGraceMs: 10,
          pollIntervalMs: 5,
          ...(hungPhase === "recovery-diagnostic"
            ? { onRecovery: pending }
            : {}),
        }),
      ).rejects.toBeInstanceOf(CloudLivePersonalIdentityDeadlineError);
      expect(Date.now() - startedAt).toBeLessThan(500);
      await expect(page.locator("body")).toBeVisible();
    });
  }

  test("fails closed when an offered action is continuously replaced", async ({
    page,
  }) => {
    await page.setContent(`
      <main data-testid="chat-overlay">
        <button data-testid="runtime-cloud">Sign in</button>
      </main>
      <script>
        let replacing = true;
        let offset = false;
        document.addEventListener("click", (event) => {
          if (!(event.target instanceof HTMLElement)) return;
          if (event.target.dataset.testid !== "runtime-cloud") return;
          document.querySelector('[data-testid="chat-overlay"]').remove();
          window.__testActiveBinding = "dedicated";
        });
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
    await expect(page.getByTestId("chat-overlay")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __testActiveBinding?: string })
            .__testActiveBinding ?? null,
      ),
    ).toBeNull();
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
