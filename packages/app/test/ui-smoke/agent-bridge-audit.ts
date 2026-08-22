/**
 * Audits one explicitly owned view root against the live chat/voice view-interact bridge.
 *
 * Callers provide the exact rendered root rather than relying on document-wide
 * heuristics, so shell chrome, chat controls, and sibling plugin surfaces cannot
 * hide an unwired control or pollute the bridge inventory.
 */

import { expect, type Locator, type Page } from "@playwright/test";

export interface AgentBridgeElement {
  id: string;
  role: string;
  label: string;
  status?: string;
  value?: unknown;
  fillable: boolean;
  clickable: boolean;
}

declare global {
  interface Window {
    __ELIZA_BRIDGE__?: {
      readonly viewInteract?: (
        viewId: string,
        viewType: string,
        capability: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }
}

export async function waitForViewInteract(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => typeof window.__ELIZA_BRIDGE__?.viewInteract === "function",
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

export async function viewInteract(
  page: Page,
  viewId: string,
  capability: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return page.evaluate(
    async ({ viewId, capability, params }) => {
      const bridge = window.__ELIZA_BRIDGE__?.viewInteract;
      if (!bridge) throw new Error("view-interact bridge not installed");
      return bridge(viewId, "gui", capability, params);
    },
    { viewId, capability, params },
  );
}

export async function listViewElements(
  page: Page,
  viewId: string,
): Promise<AgentBridgeElement[]> {
  return (await viewInteract(
    page,
    viewId,
    "list-elements",
  )) as AgentBridgeElement[];
}

export interface RootControlAudit {
  wiredIds: string[];
  unwired: string[];
  duplicateControlIds: string[];
}

export async function inspectExactRootControls(
  root: Locator,
): Promise<RootControlAudit> {
  return root.evaluate((node) => {
    const selector = [
      "button:not([disabled])",
      "a[href]",
      'input:not([type="hidden"]):not([disabled]):not([readonly])',
      "textarea:not([disabled]):not([readonly])",
      "select:not([disabled])",
      '[contenteditable="true"]',
      '[role="button"]',
      '[role="switch"]',
      '[role="combobox"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="listbox"]',
      '[role="option"]',
      '[role="slider"]',
      '[role="textbox"]',
    ].join(", ");
    const owners = new Map<string, Set<HTMLElement>>();
    const unwired = new Set<string>();
    for (const element of Array.from(
      node.querySelectorAll<HTMLElement>(selector),
    )) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (element.closest('[aria-hidden="true"]')) continue;
      if (element.getAttribute("aria-disabled") === "true") continue;

      // An interactive element must own its bridge identity directly. Accepting
      // `closest()` here lets one coarse wrapper falsely claim any number of
      // unrelated child buttons, leaving chat/voice unable to address them.
      const id = element.dataset.agentId;
      if (id) {
        const controls = owners.get(id) ?? new Set<HTMLElement>();
        controls.add(element);
        owners.set(id, controls);
        continue;
      }
      const role = element.getAttribute("role");
      const name =
        element.getAttribute("aria-label") ??
        element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ??
        "";
      const inheritedId = element.parentElement
        ?.closest<HTMLElement>("[data-agent-id]")
        ?.getAttribute("data-agent-id");
      unwired.add(
        `${element.tagName.toLocaleLowerCase()}${role ? `[role=${role}]` : ""}${
          name ? `(${name})` : ""
        }${inheritedId ? `[nested-under=${inheritedId}]` : ""}`,
      );
    }
    return {
      wiredIds: [...owners.keys()].sort(),
      unwired: [...unwired].sort(),
      duplicateControlIds: [...owners.entries()]
        .filter(([, controls]) => controls.size > 1)
        .map(([id]) => id)
        .sort(),
    };
  });
}

/**
 * Prove that every enabled, visible control under `root` is registered by the
 * active view and that the bridge inventory has no malformed duplicate ids.
 */
export async function expectExactRootAgentParity({
  page,
  root,
  viewId,
  label,
}: {
  page: Page;
  root: Locator;
  viewId: string;
  label: string;
}): Promise<AgentBridgeElement[]> {
  await waitForViewInteract(page);
  const audit = await inspectExactRootControls(root);
  expect(
    audit.unwired,
    `${label}: visible controls without data-agent-id: ${audit.unwired.join("; ")}`,
  ).toEqual([]);
  expect(
    audit.duplicateControlIds,
    `${label}: distinct controls sharing one data-agent-id: ${audit.duplicateControlIds.join(", ")}`,
  ).toEqual([]);

  const elements = await listViewElements(page, viewId);
  const bridgeIds = elements.map(({ id }) => id);
  expect(
    new Set(bridgeIds).size,
    `${label}: the bridge must not expose duplicate element ids`,
  ).toBe(bridgeIds.length);
  for (const element of elements) {
    expect(element.id, `${label}: element id`).not.toBe("");
    expect(element.role, `${label}: ${element.id} role`).not.toBe("");
    expect(element.label, `${label}: ${element.id} label`).not.toBe("");
    expect(typeof element.fillable, `${label}: ${element.id} fillable`).toBe(
      "boolean",
    );
    expect(typeof element.clickable, `${label}: ${element.id} clickable`).toBe(
      "boolean",
    );
  }
  expect(
    bridgeIds,
    `${label}: every exact-root data-agent-id must be registered`,
  ).toEqual(expect.arrayContaining(audit.wiredIds));
  return elements;
}
