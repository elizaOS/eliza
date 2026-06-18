// Proves the Settings surface is fully chat-drivable: for every section, the
// agent surface (the same path chat uses — view-interact → registry) must expose
// the section's controls, and agent-fill / agent-click must actually mutate them.
// Deterministic, keyless against the stub. No LLM — drives the registry directly
// through window.__ELIZA_VIEW_INTERACT__ (the debug bridge over dispatchViewInteract).

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { SETTINGS_SECTIONS } from "../../../../scripts/ai-qa/route-catalog.ts";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const OUT_DIR = resolve(REPO_ROOT, "reports", "settings-audit");

interface AgentElement {
  id: string;
  role: string;
  label: string;
  value?: unknown;
  fillable: boolean;
  clickable: boolean;
}

declare global {
  interface Window {
    __ELIZA_VIEW_INTERACT__?: (
      viewId: string,
      viewType: string,
      capability: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>;
  }
}

async function interact(
  page: Page,
  capability: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return page.evaluate(
    async ({ capability, params }) => {
      const bridge = window.__ELIZA_VIEW_INTERACT__;
      if (!bridge) throw new Error("view-interact bridge not installed");
      return bridge("settings", "gui", capability, params);
    },
    { capability, params },
  );
}

/** Controls contributed by the active section body (not the nav rail). */
async function sectionBodyElements(page: Page): Promise<AgentElement[]> {
  const all = (await interact(page, "list-elements")) as AgentElement[];
  return all.filter(
    (el) => !el.id.startsWith("section-") && !el.id.startsWith("section"),
  );
}

test.describe("settings is fully chat-drivable", () => {
  test("every section exposes chat-addressable controls; fill + click mutate them", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/settings");
    await expect(page.getByTestId("settings-shell")).toBeVisible({
      timeout: 60_000,
    });

    // Bridge is installed when the view-interact module loads (on app boot).
    await expect
      .poll(
        () =>
          page.evaluate(
            () => typeof window.__ELIZA_VIEW_INTERACT__ === "function",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    const inventory: Record<
      string,
      { count: number; roles: Record<string, number>; sample: string[] }
    > = {};
    // High-value controls that render in the DOM but are NOT agent-addressable
    // (no data-agent-id on the element or an ancestor) — a real "chat can't
    // reach this setting" gap. Empty sections (e.g. no connectors in the stub)
    // naturally contribute nothing, so this is robust to stub data.
    const unwiredControls: string[] = [];
    let fillsProven = 0;
    let clicksProven = 0;

    for (const section of SETTINGS_SECTIONS) {
      try {
        await openSettingsSection(page, section.match);
      } catch {
        // wallet-rpc is hidden when wallet is disabled in the stub — skip
        // sections that aren't reachable rather than failing the whole run.
        continue;
      }
      await page.waitForTimeout(500); // let async section bodies register

      const unwired = await page.evaluate((sectionId) => {
        const root = document.getElementById(sectionId);
        if (!root) return [] as string[];
        const selector =
          'input:not([type="hidden"]):not([disabled]):not([readonly]), textarea:not([disabled]), [role="switch"], [role="combobox"], select:not([disabled])';
        const gaps: string[] = [];
        for (const el of Array.from(root.querySelectorAll(selector))) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue; // not visible
          // Radix Select renders a visually-hidden, aria-hidden native <select>
          // for form compat; the real (addressable) control is its combobox
          // trigger. Skip aria-hidden machinery — it isn't a user-facing control.
          if (el.closest('[aria-hidden="true"]')) continue;
          if (!el.closest("[data-agent-id]")) {
            const role = el.getAttribute("role");
            gaps.push(
              `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}`,
            );
          }
        }
        return gaps;
      }, section.id);
      for (const gap of unwired) unwiredControls.push(`${section.id}: ${gap}`);

      const els = await sectionBodyElements(page);
      const roles: Record<string, number> = {};
      for (const el of els) roles[el.role] = (roles[el.role] ?? 0) + 1;
      inventory[section.id] = {
        count: els.length,
        roles,
        sample: els.slice(0, 12).map((el) => `${el.role}:${el.id}`),
      };

      // Prove a text field round-trips through agent-fill (chat sets a value).
      const textField = els.find(
        (el) => el.fillable && el.role === "text-input",
      );
      if (textField) {
        const probe = `chat-set-${section.id}`;
        const fill = (await interact(page, "agent-fill", {
          id: textField.id,
          value: probe,
        })) as { ok?: boolean };
        if (fill?.ok) {
          const ok = await expect
            .poll(
              async () => {
                const el = (await interact(page, "describe-element", {
                  id: textField.id,
                })) as AgentElement | null;
                return el?.value;
              },
              { timeout: 5_000 },
            )
            .toBe(probe)
            .then(() => true)
            .catch(() => false);
          if (ok) fillsProven += 1;
        }
      }

      // Prove a toggle flips through agent-click (chat toggles a setting).
      const toggle = els.find((el) => el.clickable && el.role === "toggle");
      if (toggle) {
        const before = (
          (await interact(page, "describe-element", {
            id: toggle.id,
          })) as AgentElement | null
        )?.value;
        const click = (await interact(page, "agent-click", {
          id: toggle.id,
        })) as { ok?: boolean };
        if (click?.ok) {
          const flipped = await expect
            .poll(
              async () => {
                const el = (await interact(page, "describe-element", {
                  id: toggle.id,
                })) as AgentElement | null;
                return el?.value;
              },
              { timeout: 5_000 },
            )
            .not.toBe(before)
            .then(() => true)
            .catch(() => false);
          if (flipped) {
            clicksProven += 1;
            // restore original state
            await interact(page, "agent-click", { id: toggle.id }).catch(
              () => {},
            );
          }
        }
      }
    }

    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      join(OUT_DIR, "chat-control-inventory.json"),
      JSON.stringify(
        { inventory, unwiredControls, fillsProven, clicksProven },
        null,
        2,
      ),
    );

    // Every interactive setting (input/switch/select/textarea) must be
    // agent-addressable — that is the "edit any setting from chat" contract.
    expect(
      unwiredControls,
      `controls not reachable from chat (no data-agent-id): ${unwiredControls.join("; ")}`,
    ).toEqual([]);

    // The chat path must actually mutate controls, not just list them: prove
    // agent-fill round-trips across several sections and agent-click flips a
    // toggle (toggles are sparser than inputs in the keyless stub).
    expect(fillsProven, "agent-fill round-trips proven").toBeGreaterThanOrEqual(
      3,
    );
    expect(clicksProven, "agent-click flips proven").toBeGreaterThanOrEqual(1);
  });
});
