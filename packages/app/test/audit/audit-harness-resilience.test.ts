/** Unit coverage for hover reachability and transient live-stack request retries. */
import type { APIResponse, Locator } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import {
  getAuditResponseWithTransportRetry,
  isTransientAuditTransportError,
} from "../ui-smoke/helpers/audit-request";
import {
  collectHoverViolations,
  isActionableHoverTarget,
} from "../ui-smoke/helpers/brand-color-scans";

type HoverProbe = "visible" | "pointer-events";

function locator({
  visible = true,
  enabled = true,
  ariaDisabled = null,
  pointerEvents = "auto",
  rejectAt,
}: {
  visible?: boolean;
  enabled?: boolean;
  ariaDisabled?: string | null;
  pointerEvents?: string;
  rejectAt?: HoverProbe;
} = {}): Locator {
  const reject = (probe: HoverProbe) => {
    if (rejectAt === probe) throw new Error(`${probe} probe failed`);
  };
  return {
    isVisible: vi.fn(async () => {
      reject("visible");
      return visible;
    }),
    isEnabled: vi.fn(async () => enabled),
    getAttribute: vi.fn(async () => ariaDisabled),
    evaluate: vi.fn(async () => {
      reject("pointer-events");
      return pointerEvents !== "none";
    }),
  } as unknown as Locator;
}

describe("aesthetic audit hover targeting", () => {
  it("keeps disabled controls whose pointer hover remains reachable", async () => {
    expect(await isActionableHoverTarget(locator({ enabled: false }))).toBe(
      true,
    );
    expect(
      await isActionableHoverTarget(locator({ ariaDisabled: "true" })),
    ).toBe(true);
  });

  it("skips only invisible or pointer-inert controls", async () => {
    expect(await isActionableHoverTarget(locator({ visible: false }))).toBe(
      false,
    );
    expect(
      await isActionableHoverTarget(locator({ pointerEvents: "none" })),
    ).toBe(false);
  });

  it("keeps enabled pointer-actionable buttons in the hover scan", async () => {
    expect(await isActionableHoverTarget(locator())).toBe(true);
  });

  it.each([
    "visible",
    "pointer-events",
  ] as const)("surfaces a rejected %s probe", async (rejectAt) => {
    await expect(
      isActionableHoverTarget(locator({ rejectAt })),
    ).rejects.toThrow(`${rejectAt} probe failed`);
  });

  it.each([
    { enabled: false, ariaDisabled: null, label: "native disabled" },
    { enabled: true, ariaDisabled: "true", label: "ARIA-disabled" },
  ])("catches orange-to-black hover on $label controls", async (state) => {
    let hovered = false;
    let evaluation = 0;
    const control = {
      isVisible: vi.fn(async () => true),
      isEnabled: vi.fn(async () => state.enabled),
      getAttribute: vi.fn(async () => state.ariaDisabled),
      evaluate: vi.fn(async () => {
        evaluation += 1;
        if (evaluation === 1) return true;
        return hovered ? "rgb(0, 0, 0)" : "rgb(255, 88, 0)";
      }),
      hover: vi.fn(async () => {
        hovered = true;
      }),
      innerText: vi.fn(async () => "Disabled orange"),
    } as unknown as Locator;
    const buttons = {
      count: vi.fn(async () => 1),
      nth: vi.fn(() => control),
    };
    const page = {
      locator: vi.fn(() => buttons),
    } as unknown as Parameters<typeof collectHoverViolations>[0];

    await expect(collectHoverViolations(page)).resolves.toEqual({
      violations: [
        '"Disabled orange" orange→black (rgb(255, 88, 0) -> rgb(0, 0, 0))',
      ],
      hoverFailures: [],
    });
    expect(control.isEnabled).not.toHaveBeenCalled();
    expect(control.getAttribute).not.toHaveBeenCalled();
  });
});

describe("aesthetic audit request retry", () => {
  it("retries ECONNRESET once and returns the recovered response", async () => {
    const response = { ok: () => true } as APIResponse;
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      )
      .mockResolvedValueOnce(response);
    const wait = vi.fn(async () => {});

    await expect(
      getAuditResponseWithTransportRetry({ get }, "/api/views", { wait }),
    ).resolves.toBe(response);
    expect(get).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("surfaces the transient error after exhausting every retry", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const get = vi.fn().mockRejectedValue(reset);
    const wait = vi.fn(async () => {});

    await expect(
      getAuditResponseWithTransportRetry({ get }, "/api/views", {
        attempts: 3,
        wait,
      }),
    ).rejects.toBe(reset);
    expect(get).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 75);
    expect(wait).toHaveBeenNthCalledWith(2, 150);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient errors or ordinary HTTP responses", async () => {
    const denied = { ok: () => false, status: () => 401 } as APIResponse;
    const httpGet = vi.fn(async () => denied);
    await expect(
      getAuditResponseWithTransportRetry({ get: httpGet }, "/api/views"),
    ).resolves.toBe(denied);
    expect(httpGet).toHaveBeenCalledTimes(1);

    const fatal = new Error("certificate rejected");
    const failingGet = vi.fn(async () => {
      throw fatal;
    });
    await expect(
      getAuditResponseWithTransportRetry({ get: failingGet }, "/api/views"),
    ).rejects.toBe(fatal);
    expect(failingGet).toHaveBeenCalledTimes(1);
  });

  it("recognizes nested socket-reset causes", () => {
    expect(
      isTransientAuditTransportError({
        cause: { code: "ECONNRESET" },
      }),
    ).toBe(true);
  });
});
