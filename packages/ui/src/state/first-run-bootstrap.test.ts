import { describe, expect, it, vi } from "vitest";
import {
  detectExistingFirstRunConnection,
  ExistingFirstRunProbeTimeoutError,
} from "./first-run-bootstrap";

describe("detectExistingFirstRunConnection", () => {
  it("surfaces config faults for a committed on-device runtime", async () => {
    const configError = new Error("GET /api/config failed: HTTP 500");

    await expect(
      detectExistingFirstRunConnection({
        client: {
          apiAvailable: true,
          getFirstRunStatus: vi.fn(async () => ({ complete: false })),
          getConfig: vi.fn(async () => {
            throw configError;
          }),
        },
        timeoutMs: 1_000,
        waitForBootingAgent: true,
      }),
    ).rejects.toBe(configError);
  });

  it("keeps the fast onboarding fallback for an uncommitted fresh install", async () => {
    const result = await detectExistingFirstRunConnection({
      client: {
        apiAvailable: true,
        getFirstRunStatus: vi.fn(async () => ({ complete: false })),
        getConfig: vi.fn(async () => {
          throw new Error("agent stopped during fresh-install probe");
        }),
      },
      timeoutMs: 1_000,
      waitForBootingAgent: false,
    });

    expect(result).toBeNull();
  });

  it("surfaces a committed-runtime timeout before a late config fault", async () => {
    const pending = detectExistingFirstRunConnection({
      client: {
        apiAvailable: true,
        getFirstRunStatus: vi.fn(async () => ({ complete: false })),
        getConfig: vi.fn(
          () =>
            new Promise<Record<string, unknown> | null | undefined>(
              (_, reject) => {
                setTimeout(() => reject(new Error("late config failure")), 20);
              },
            ),
        ),
      },
      timeoutMs: 5,
      waitForBootingAgent: true,
    });

    await expect(pending).rejects.toBeInstanceOf(
      ExistingFirstRunProbeTimeoutError,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
});
