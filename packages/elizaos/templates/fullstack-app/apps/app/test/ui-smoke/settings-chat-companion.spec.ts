import { expect, test } from "@playwright/test";
import { openAppPath, readLocalStorage, seedAppStorage } from "./helpers";

const VRM_POWER_KEY = "eliza:companion-vrm-power";
const HALF_FRAMERATE_KEY = "eliza:companion-half-framerate";
const ANIMATE_WHEN_HIDDEN_KEY = "eliza:companion-animate-when-hidden";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
});

test("companion media settings persist across reloads", async ({ page }) => {
  await openAppPath(page, "/voice");
  await expect(page.getByTestId("settings-shell")).toBeVisible();

  await page
    .getByTestId("settings-companion-vrm-power")
    .getByRole("button", { name: "Always quality" })
    .click();
  await page
    .getByTestId("settings-companion-half-framerate")
    .getByRole("button", { name: "Always half" })
    .click();

  const animateSwitch = page
    .getByTestId("settings-companion-animate-when-hidden")
    .getByRole("switch", { name: "Animate in background" });
  await animateSwitch.click();

  await expect
    .poll(async () => readLocalStorage(page, VRM_POWER_KEY))
    .toBe("quality");
  await expect
    .poll(async () => readLocalStorage(page, HALF_FRAMERATE_KEY))
    .toBe("always");
  await expect
    .poll(async () => readLocalStorage(page, ANIMATE_WHEN_HIDDEN_KEY))
    .toBe("1");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  await expect(
    page
      .getByTestId("settings-companion-vrm-power")
      .getByRole("button", { name: "Always quality" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByTestId("settings-companion-half-framerate")
      .getByRole("button", { name: "Always half" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(animateSwitch).toHaveAttribute("aria-checked", "true");
});
