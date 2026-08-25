/**
 * Negative browser fixtures prove the exact-root bridge audit cannot be fooled by coarse wrappers.
 */

import { expect, test } from "@playwright/test";
import {
  expectExactRootAgentParity,
  inspectExactRootControls,
} from "./agent-bridge-audit";

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
  expect(audit.humanOnlyIds).toEqual([]);
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

test("inventoried human-authority controls are never counted as agent wired", async ({
  page,
}) => {
  await page.setContent(`
    <main data-testid="audit-root">
      <button
        type="button"
        data-agent-authority="human"
        data-agent-human-id="delete-task"
      >Delete task</button>
    </main>
  `);

  const audit = await inspectExactRootControls(page.getByTestId("audit-root"));
  expect(audit.wiredIds).toEqual([]);
  expect(audit.humanOnlyIds).toEqual(["delete-task"]);
  expect(audit.unwired).toEqual([]);
});

test("finds hidden and open-shadow-root controls instead of treating them as absent", async ({
  page,
}) => {
  await page.setContent(`
    <main data-testid="audit-root">
      <button type="button" style="display:none">Hidden action</button>
      <div id="shadow-host"></div>
    </main>
  `);
  await page.evaluate(() => {
    const host = document.querySelector("#shadow-host");
    if (!host) throw new Error("shadow host missing");
    host.attachShadow({ mode: "open" }).innerHTML =
      '<button type="button">Shadow action</button>';
  });

  const audit = await inspectExactRootControls(page.getByTestId("audit-root"));
  expect(audit.unwired).toEqual([
    "button(Hidden action)",
    "button(Shadow action)",
  ]);
});

test("rejects an interactive bridge registration rendered through an external portal", async ({
  page,
}) => {
  await page.setContent(`
    <main data-testid="audit-root">
      <button type="button" data-agent-id="owned">Owned action</button>
    </main>
    <aside><button type="button" data-agent-id="portal">Portal action</button></aside>
  `);
  await page.evaluate(() => {
    window.__ELIZA_BRIDGE__ = {
      viewInteract: async (_viewId, _viewType, capability) => {
        if (capability !== "list-elements") return null;
        return [
          {
            id: "owned",
            role: "button",
            label: "Owned action",
            fillable: false,
            clickable: true,
          },
          {
            id: "portal",
            role: "button",
            label: "Portal action",
            fillable: false,
            clickable: true,
          },
        ];
      },
    };
  });

  await expect(
    expectExactRootAgentParity({
      page,
      root: page.getByTestId("audit-root"),
      viewId: "fixture",
      label: "Portal fixture",
    }),
  ).rejects.toThrow(/interactive bridge ids must exactly match the owned root/);
});
