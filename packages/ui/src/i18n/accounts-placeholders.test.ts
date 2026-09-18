/**
 * Unit coverage for accounts i18n catalog placeholders (#30664).
 * Verifies that English translation keys consume dynamic values via the
 * {{variable}} interpolation contract rather than leaking literal template source.
 */
import { describe, expect, it } from "vitest";
import { t } from "./index";

describe("accounts i18n catalog placeholders (#30664)", () => {
  it("interpolates healthy account count and pool size dynamically", () => {
    expect(
      t("en", "accounts.row.healthy", {
        healthy: 2,
        total: 5,
      }),
    ).toBe("2/5 healthy");
  });

  it("interpolates active reason label and reset duration in account row", () => {
    expect(
      t("en", "accounts.row.activeReason", {
        reason: "resets soonest",
      }),
    ).toBe("active · resets soonest");

    expect(
      t("en", "accounts.row.activeResetIn", {
        resetIn: "42m",
      }),
    ).toBe(" · resets in 42m");
  });

  it("renders enter key symbol without escaped unicode literals", () => {
    expect(t("en", "accounts.add.enterHint")).toBe("↵");
  });

  it("interpolates connect count and reauth titles correctly", () => {
    expect(
      t("en", "accounts.connect.currentCount", {
        count: 3,
      }),
    ).toBe("3 connected");

    expect(
      t("en", "accounts.reauthenticate.title", {
        account: "Codex Primary",
      }),
    ).toBe("Reauthenticate Codex Primary");

    expect(
      t("en", "accounts.replaceCredential.title", {
        account: "Codex Secondary",
      }),
    ).toBe("Replace credential for Codex Secondary");
  });

  it("interpolates table action aria-labels and reset tooltips", () => {
    expect(
      t("en", "accounts.table.enabledToggle", { label: "Work Account" }),
    ).toBe("Toggle Work Account");
    expect(
      t("en", "accounts.table.moveDown", { label: "Work Account" }),
    ).toBe("Lower priority of Work Account");
    expect(
      t("en", "accounts.table.moveUp", { label: "Work Account" }),
    ).toBe("Raise priority of Work Account");
    expect(
      t("en", "accounts.table.refresh", { label: "Work Account" }),
    ).toBe("Refresh usage for Work Account");
    expect(
      t("en", "accounts.table.remove", { label: "Work Account" }),
    ).toBe("Remove Work Account");
    expect(
      t("en", "accounts.table.renameInput", { label: "Work Account" }),
    ).toBe("Rename Work Account");
    expect(
      t("en", "accounts.table.resetsIn", { countdown: "15m" }),
    ).toBe("resets in 15m");
  });
});
