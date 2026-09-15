/**
 * Browser negative controls for the bounded renderer activity oracle.
 * Real browser requests hit isolated routes; background polling and denied
 * mutations cannot make an unchanged control report an observed result.
 */
import { expect, test } from "@playwright/test";
import {
  type ControlSnapshot,
  interactionDelta,
} from "./interaction-observation";

test("transport-only activity cannot satisfy the renderer observation oracle", async ({
  page,
}) => {
  await page.route("http://oracle.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: pathname === "/api/notes" ? 403 : 200,
      contentType: pathname === "/" ? "text/html" : "application/json",
      body:
        pathname === "/"
          ? '<button id="save">Save</button>'
          : JSON.stringify({ error: "denied" }),
    });
  });
  await page.goto("http://oracle.test/");
  const snapshot = async (): Promise<ControlSnapshot> => {
    const details = await page.locator("#save").evaluate((el) => ({
      tagName: el.tagName.toLowerCase(),
      role: null,
      type: "button",
      href: null,
      visible: true,
      label: el.textContent ?? "",
      text: el.textContent ?? "",
      value: null,
      checked: null,
      attributes: {},
    }));
    return {
      url: page.url(),
      visibleDismissibleSurfaces: 0,
      pageFingerprint: await page.locator("body").innerText(),
      details,
    };
  };
  const before = await snapshot();
  await page.evaluate(() => {
    document.querySelector("#save")?.addEventListener("click", async () => {
      await fetch("/api/poll");
      await fetch("/api/notes", {
        method: "POST",
        body: JSON.stringify({ title: "Denied note" }),
      });
    });
  });
  const rejection = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/notes") &&
      response.request().method() === "POST",
  );
  await page.locator("#save").click();
  expect((await rejection).status()).toBe(403);
  expect(interactionDelta(before, await snapshot())).toBeNull();
  // A real renderer change is still observable, while remaining distinct
  // from acceptance of the denied operation above.
  await page.locator("#save").evaluate((el) => {
    el.textContent = "Permission denied";
  });
  expect(interactionDelta(before, await snapshot())).not.toBeNull();
});
