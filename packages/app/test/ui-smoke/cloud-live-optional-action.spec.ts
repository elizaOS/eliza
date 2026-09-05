/** Real-browser regression coverage for bounded optional Cloud actions. */

import { expect, type Locator, test } from "@playwright/test";
import { installDedicatedAdoptionConsentProof } from "../cloud-live-dedicated-adoption-consent";
import {
  CloudLiveDedicatedConfirmationRequiredError,
  CloudLiveOptionalActionDeadlineError,
  CloudLivePersonalIdentityDeadlineError,
  CloudLivePersonalIdentityRecoveryError,
  clickCloudLiveOptionalAction,
  createCloudLiveDedicatedConsentGate,
  prepareCloudLivePersonalIdentity,
  waitForCloudLivePersonalIdentity,
} from "../cloud-live-optional-action";

test.describe("Cloud live optional action boundary", () => {
  test.use({ serviceWorkers: "block" });

  test("keeps Dedicated activation and adoption confirmation fail-closed by default", async ({
    page,
  }) => {
    let mutationRequestCount = 0;
    await page.route("**/upgrade-tier{,/**}", async (route) => {
      mutationRequestCount += 1;
      await route.fulfill({ status: 204, body: "" });
    });
    await page.setContent(`
      <button data-testid="activation-confirm">Confirm and start — private quote $17.42</button>
      <button data-testid="activation-cancel">Not now</button>
      <button data-testid="adoption-confirm">Confirm existing private-agent-id</button>
      <button data-testid="adoption-cancel">Not now</button>
      <output data-testid="click-count">0</output>
      <script>
        document.addEventListener("click", async (event) => {
          if (!(event.target instanceof HTMLElement)) return;
          if (!event.target.dataset.testid?.endsWith("-confirm")) return;
          const output = document.querySelector('[data-testid="click-count"]');
          output.textContent = String(Number(output.textContent) + 1);
          await fetch("https://api.test/api/v1/eliza/agents/private-agent-id/upgrade-tier/adopt-existing", { method: "POST" });
        });
      </script>
    `);
    const gate = createCloudLiveDedicatedConsentGate({});
    const startedAt = Date.now();

    const result = await waitForCloudLivePersonalIdentity({
      readBinding: async () => null,
      runtimeCloudRecovery: page.getByTestId("runtime-cloud"),
      retryRecovery: page.getByTestId("identity-retry"),
      dedicatedConsent: {
        gate,
        confirmationChoices: page.locator(
          '[data-testid="activation-confirm"], [data-testid="adoption-confirm"]',
        ),
        cancellationChoices: page.locator(
          '[data-testid="activation-cancel"], [data-testid="adoption-cancel"]',
        ),
        performConfirmation: async (confirmation) => {
          await confirmation.click();
          return "activation";
        },
      },
      timeoutMs: 500,
      runtimeCloudGraceMs: 50,
      pollIntervalMs: 5,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("unapproved confirmation unexpectedly resolved");
    expect(result.error).toBeInstanceOf(
      CloudLiveDedicatedConfirmationRequiredError,
    );
    expect(result.error).toMatchObject({
      code: "CLOUD_LIVE_DEDICATED_CONFIRMATION_REQUIRED",
      reason: "approval-required",
    });
    expect(String(result.error)).not.toMatch(
      /private|17\.42|quote|selector|locator|upgrade-tier/i,
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(page.getByTestId("click-count")).toHaveText("0");
    expect(mutationRequestCount).toBe(0);
    expect(gate.snapshot()).toEqual({
      approvalGrantedCount: 0,
      confirmationOfferCount: 1,
      confirmationClickCount: 0,
      cancellationCount: 0,
    });
    expect(gate.confirmedKind()).toBe("none");
  });

  test("permits exactly one visible UI confirmation for an explicitly approved staging dispatch", async ({
    page,
  }) => {
    await page.setContent(`
      <button data-testid="activation-confirm">Confirm and start</button>
      <button data-testid="activation-cancel">Not now</button>
      <output data-testid="click-count">0</output>
      <script>
        document.addEventListener("click", (event) => {
          if (!(event.target instanceof HTMLButtonElement)) return;
          if (event.target.dataset.testid !== "activation-confirm") return;
          const output = document.querySelector('[data-testid="click-count"]');
          output.textContent = String(Number(output.textContent) + 1);
          event.target.disabled = true;
          document.querySelector('[data-testid="activation-cancel"]').disabled = true;
          setTimeout(() => { window.__testActiveBinding = "dedicated"; }, 25);
        });
      </script>
    `);
    const gate = createCloudLiveDedicatedConsentGate({
      ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION: "1",
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });

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
        dedicatedConsent: {
          gate,
          confirmationChoices: page.getByTestId("activation-confirm"),
          cancellationChoices: page.getByTestId("activation-cancel"),
          performConfirmation: async (confirmation) => {
            await confirmation.click();
            return "activation";
          },
        },
        timeoutMs: 500,
        runtimeCloudGraceMs: 50,
        pollIntervalMs: 5,
      }),
    ).resolves.toBe("dedicated");
    await expect(page.getByTestId("click-count")).toHaveText("1");
    expect(gate.snapshot()).toEqual({
      approvalGrantedCount: 1,
      confirmationOfferCount: 1,
      confirmationClickCount: 1,
      cancellationCount: 0,
    });
    expect(gate.confirmedKind()).toBe("activation");
  });

  test("ignores a stale locked confirmation while a binding resolves", async ({
    page,
  }) => {
    await page.setContent(`
      <button data-testid="adoption-confirm" aria-pressed="true" disabled>Confirmed</button>
      <button data-testid="adoption-cancel" aria-pressed="false" disabled>Not now</button>
      <script>setTimeout(() => { window.__testActiveBinding = "dedicated"; }, 25);</script>
    `);
    const gate = createCloudLiveDedicatedConsentGate({});

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
        dedicatedConsent: {
          gate,
          confirmationChoices: page.getByTestId("adoption-confirm"),
          cancellationChoices: page.getByTestId("adoption-cancel"),
          performConfirmation: async (confirmation) => {
            await confirmation.click();
            return "adoption";
          },
        },
        timeoutMs: 500,
        runtimeCloudGraceMs: 50,
        pollIntervalMs: 5,
      }),
    ).resolves.toBe("dedicated");
    expect(gate.snapshot().confirmationClickCount).toBe(0);
  });

  test("lets a new current quote supersede an older cancelled turn", async ({
    page,
  }) => {
    await page.setContent(`
      <button data-testid="adoption-confirm" disabled>Confirm old quote</button>
      <button data-testid="adoption-cancel" aria-pressed="true" disabled>Not now</button>
      <button data-testid="activation-confirm">Confirm current quote</button>
      <button data-testid="activation-cancel">Not now</button>
      <output data-testid="click-count">0</output>
      <script>
        document.addEventListener("click", (event) => {
          if (!(event.target instanceof HTMLButtonElement)) return;
          if (event.target.dataset.testid !== "activation-confirm") return;
          document.querySelector('[data-testid="click-count"]').textContent = "1";
          event.target.disabled = true;
          document.querySelector('[data-testid="activation-cancel"]').disabled = true;
          setTimeout(() => { window.__testActiveBinding = "dedicated"; }, 25);
        });
      </script>
    `);
    const gate = createCloudLiveDedicatedConsentGate({
      ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION: "1",
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });

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
        dedicatedConsent: {
          gate,
          confirmationChoices: page.locator(
            '[data-testid="activation-confirm"], [data-testid="adoption-confirm"]',
          ),
          cancellationChoices: page.locator(
            '[data-testid="activation-cancel"], [data-testid="adoption-cancel"]',
          ),
          performConfirmation: async (confirmation) => {
            await confirmation.click();
            return "activation";
          },
        },
        timeoutMs: 500,
        runtimeCloudGraceMs: 50,
        pollIntervalMs: 5,
      }),
    ).resolves.toBe("dedicated");
    await expect(page.getByTestId("click-count")).toHaveText("1");
    expect(gate.snapshot().cancellationCount).toBe(0);
  });

  test("requires fresh dispatch approval when a changed quote is reissued", async ({
    page,
  }) => {
    await page.setContent(`
      <main data-testid="choices">
        <button data-testid="adoption-confirm">Confirm current quote</button>
        <button data-testid="adoption-cancel">Not now</button>
      </main>
      <output data-testid="click-count">0</output>
      <script>
        document.addEventListener("click", (event) => {
          if (!(event.target instanceof HTMLButtonElement)) return;
          if (event.target.dataset.testid !== "adoption-confirm") return;
          const output = document.querySelector('[data-testid="click-count"]');
          output.textContent = String(Number(output.textContent) + 1);
          event.target.disabled = true;
          document.querySelector('[data-testid="adoption-cancel"]').disabled = true;
          document.querySelector('[data-testid="choices"]').insertAdjacentHTML(
            "beforeend",
            '<button data-testid="adoption-confirm">Confirm changed private quote</button><button data-testid="adoption-cancel">Not now</button>',
          );
        });
      </script>
    `);
    const gate = createCloudLiveDedicatedConsentGate({
      ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION: "1",
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });

    await expect(
      waitForCloudLivePersonalIdentity({
        readBinding: async () => null,
        runtimeCloudRecovery: page.getByTestId("runtime-cloud"),
        retryRecovery: page.getByTestId("identity-retry"),
        dedicatedConsent: {
          gate,
          confirmationChoices: page.getByTestId("adoption-confirm"),
          cancellationChoices: page.getByTestId("adoption-cancel"),
          performConfirmation: async (confirmation) => {
            await confirmation.click();
            return "adoption";
          },
        },
        timeoutMs: 500,
        runtimeCloudGraceMs: 50,
        pollIntervalMs: 5,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_LIVE_DEDICATED_CONFIRMATION_REQUIRED",
      reason: "quote-changed",
    });
    await expect(page.getByTestId("click-count")).toHaveText("1");
    expect(gate.snapshot()).toEqual({
      approvalGrantedCount: 1,
      confirmationOfferCount: 2,
      confirmationClickCount: 1,
      cancellationCount: 0,
    });
    expect(gate.confirmedKind()).toBe("adoption");
  });

  test("classifies cancellation without replaying confirmation", async ({
    page,
  }) => {
    await page.setContent(`
      <button data-testid="activation-confirm" aria-pressed="false" disabled>Confirm</button>
      <button data-testid="activation-cancel" aria-pressed="true" disabled>Not now</button>
    `);
    const gate = createCloudLiveDedicatedConsentGate({
      ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION: "1",
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });

    await expect(
      waitForCloudLivePersonalIdentity({
        readBinding: async () => null,
        runtimeCloudRecovery: page.getByTestId("runtime-cloud"),
        retryRecovery: page.getByTestId("identity-retry"),
        dedicatedConsent: {
          gate,
          confirmationChoices: page.getByTestId("activation-confirm"),
          cancellationChoices: page.getByTestId("activation-cancel"),
          performConfirmation: async (confirmation) => {
            await confirmation.click();
            return "activation";
          },
        },
        timeoutMs: 500,
        runtimeCloudGraceMs: 50,
        pollIntervalMs: 5,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_LIVE_DEDICATED_CONFIRMATION_REQUIRED",
      reason: "cancelled",
    });
    expect(gate.snapshot()).toEqual({
      approvalGrantedCount: 1,
      confirmationOfferCount: 0,
      confirmationClickCount: 0,
      cancellationCount: 1,
    });
  });

  test("rejects billable approval outside an explicit staging dispatch", () => {
    for (const env of [
      {
        ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION: "1",
        ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "production",
        GITHUB_EVENT_NAME: "workflow_dispatch",
      },
      {
        ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION: "1",
        ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
        GITHUB_EVENT_NAME: "schedule",
      },
    ]) {
      expect(() => createCloudLiveDedicatedConsentGate(env)).toThrow(
        "Dedicated confirmation approval requires an explicit staging workflow dispatch",
      );
    }
  });

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

  test("reuses a Dedicated quote only after explicit staging approval", async ({
    page,
  }) => {
    let quoteGetCount = 0;
    await page.route(
      "**/api/v1/eliza/agents/*/upgrade-tier/adopt-existing",
      async (route) => {
        quoteGetCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              quoteId: "private-quote",
              dedicatedAgentId: "private-dedicated",
              adoptionState: "available",
              status: "stopped",
              startsCompute: true,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 115.54059,
              deficitUsd: 0,
              stateDisposition: "verified_backup_present",
              canAdopt: true,
              requiresCatalogRestore: false,
              requiresConfirmation: true,
              action: "adopt_existing_dedicated",
            },
          }),
        });
      },
    );
    await page.goto("/");
    await page.setContent(`
      <div data-testid="dedicated-adoption-review">
        <h1>Bring this Dedicated Eliza online?</h1>
        <p>We found an existing Dedicated Eliza for this account. Confirming reuses it — it does not create another one.</p>
        <p>This starts Dedicated hosting at $0.24/day ($0.01/hr).</p>
        <p>Balance: $115.54 · Required: $0.72 (3 days of runway)</p>
        <p>Current Dedicated status: stopped.</p>
        <p>Cloud will restore its reviewed backup before switching.</p>
        <p>Your Shared Eliza keeps working until Dedicated is healthy. If setup fails or you cancel, nothing switches.</p>
        <button data-testid="dedicated-adoption-cancel">Cancel setup</button>
        <button data-testid="dedicated-adoption-confirm">Start Dedicated</button>
      </div>
      <output data-testid="confirmation-count">0</output>
      <script>
        document.addEventListener("click", (event) => {
          if (!(event.target instanceof HTMLElement)) return;
          if (event.target.dataset.testid !== "dedicated-adoption-confirm") return;
          const output = document.querySelector('[data-testid="confirmation-count"]');
          output.textContent = String(Number(output.textContent) + 1);
          window.__testActiveBinding = "dedicated";
        });
      </script>
    `);
    const dedicatedAdoptionProof = installDedicatedAdoptionConsentProof(page);
    const quoteStatus = await page.evaluate(async () => {
      const response = await fetch(
        "/api/v1/eliza/agents/private-personal/upgrade-tier/adopt-existing",
      );
      await response.json();
      return response.status;
    });
    expect(quoteStatus).toBe(200);
    expect(quoteGetCount).toBe(1);
    let consentHandlerCalls = 0;
    let approvedBinding:
      | {
          sourceAgentId: string;
          quoteId: string;
          dedicatedAgentId: string;
        }
      | undefined;
    let bindingReadCount = 0;
    const dedicatedAdoptionConsent = page.getByTestId(
      "dedicated-adoption-confirm",
    );
    const gate = createCloudLiveDedicatedConsentGate({
      ELIZA_UI_SMOKE_APPROVE_BILLABLE_DEDICATED_CONFIRMATION: "1",
      ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV: "staging",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });

    try {
      await expect(
        waitForCloudLivePersonalIdentity({
          readBinding: () => {
            bindingReadCount += 1;
            return page.evaluate(
              () =>
                (window as typeof window & { __testActiveBinding?: string })
                  .__testActiveBinding ?? null,
            );
          },
          runtimeCloudRecovery: page.getByTestId("runtime-cloud"),
          retryRecovery: page.getByTestId("identity-retry"),
          dedicatedConsent: {
            gate,
            confirmationChoices: dedicatedAdoptionConsent,
            cancellationChoices: page.getByTestId("dedicated-adoption-cancel"),
            performConfirmation: async (confirmation) => {
              consentHandlerCalls += 1;
              approvedBinding =
                await dedicatedAdoptionProof.confirmVisibleConsent(
                  confirmation,
                );
              return "adoption";
            },
          },
          timeoutMs: 2_000,
          runtimeCloudGraceMs: 50,
          pollIntervalMs: 5,
        }),
      ).resolves.toBe("dedicated");
      expect(bindingReadCount).toBeGreaterThan(0);
      expect(quoteGetCount).toBe(1);
      expect(consentHandlerCalls).toBe(1);
      expect(approvedBinding).toEqual({
        sourceAgentId: "private-personal",
        quoteId: "private-quote",
        dedicatedAgentId: "private-dedicated",
      });
      await expect(page.getByTestId("confirmation-count")).toHaveText("1");
      expect(gate.snapshot()).toEqual({
        approvalGrantedCount: 1,
        confirmationOfferCount: 1,
        confirmationClickCount: 1,
        cancellationCount: 0,
      });
      expect(gate.confirmedKind()).toBe("adoption");
    } finally {
      dedicatedAdoptionProof.dispose();
    }
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
