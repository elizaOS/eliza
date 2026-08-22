/**
 * Negative browser fixtures prove the exact-root bridge audit cannot be fooled by coarse wrappers.
 */

import { expect, test } from "@playwright/test";
import { inspectExactRootControls } from "./agent-bridge-audit";

test("rejects two child buttons nested under one coarse agent owner", async ({
  page,
}) => {
  await page.setContent(`
    <main data-testid="audit-root">
      <section data-agent-id="coarse-wrapper">
        <button type="button">First action</button>
        <button type="button">Second action</button>
      </section>
    </main>
  `);

  const audit = await inspectExactRootControls(page.getByTestId("audit-root"));
  expect(audit.wiredIds).toEqual([]);
  expect(audit.unwired).toEqual([
    "button(First action)[nested-under=coarse-wrapper]",
    "button(Second action)[nested-under=coarse-wrapper]",
  ]);
});

test("rejects one id stamped on two distinct interactive controls", async ({
  page,
}) => {
  await page.setContent(`
    <main data-testid="audit-root">
      <button type="button" data-agent-id="duplicate">First action</button>
      <a href="#next" data-agent-id="duplicate">Second action</a>
    </main>
  `);

  const audit = await inspectExactRootControls(page.getByTestId("audit-root"));
  expect(audit.unwired).toEqual([]);
  expect(audit.duplicateControlIds).toEqual(["duplicate"]);
});
