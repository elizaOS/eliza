/**
 * Covers the API Explorer toast adapter's dispatch: each explorer mode routes
 * to its matching sonner verb, the message is forwarded verbatim, and the
 * delegate's return value passes through. sonner is mocked at the module
 * boundary; the switch dispatch in toast.ts is driven for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(() => "success-id"),
    error: vi.fn(() => "error-id"),
    info: vi.fn(() => "info-id"),
  },
}));

import { toast as sonnerToast } from "sonner";
import { toast } from "./toast.ts";

describe("api-explorer toast adapter", () => {
  beforeEach(() => {
    vi.mocked(sonnerToast.success).mockClear();
    vi.mocked(sonnerToast.error).mockClear();
    vi.mocked(sonnerToast.info).mockClear();
  });

  it("routes mode 'success' to sonner success with the message", () => {
    const returned = toast({ message: "Key created", mode: "success" });

    expect(sonnerToast.success).toHaveBeenCalledTimes(1);
    expect(sonnerToast.success).toHaveBeenCalledWith("Key created");
    expect(returned).toBe("success-id");
  });

  it("routes mode 'error' to sonner error with the message", () => {
    const returned = toast({ message: "Request failed", mode: "error" });

    expect(sonnerToast.error).toHaveBeenCalledTimes(1);
    expect(sonnerToast.error).toHaveBeenCalledWith("Request failed");
    expect(returned).toBe("error-id");
  });

  it("routes mode 'info' to sonner info with the message", () => {
    const returned = toast({ message: "Using saved key", mode: "info" });

    expect(sonnerToast.info).toHaveBeenCalledTimes(1);
    expect(sonnerToast.info).toHaveBeenCalledWith("Using saved key");
    expect(returned).toBe("info-id");
  });

  it("fires exactly one sonner verb per call and none of the others", () => {
    toast({ message: "only success", mode: "success" });
    toast({ message: "only error", mode: "error" });
    toast({ message: "only info", mode: "info" });

    expect(sonnerToast.success).toHaveBeenCalledTimes(1);
    expect(sonnerToast.error).toHaveBeenCalledTimes(1);
    expect(sonnerToast.info).toHaveBeenCalledTimes(1);

    vi.mocked(sonnerToast.error).mockClear();
    vi.mocked(sonnerToast.info).mockClear();
    toast({ message: "again", mode: "success" });
    expect(sonnerToast.success).toHaveBeenCalledTimes(2);
    expect(sonnerToast.error).not.toHaveBeenCalled();
    expect(sonnerToast.info).not.toHaveBeenCalled();
  });

  it("forwards the message verbatim without trimming or rewriting", () => {
    const message = "  padded key name  ";

    toast({ message, mode: "info" });

    expect(vi.mocked(sonnerToast.info).mock.calls[0]).toEqual([message]);
  });

  it("returns undefined when no declared branch matches (no default case)", () => {
    const returned = toast({
      message: "unexpected",
      mode: "unknown" as "info",
    });

    expect(sonnerToast.success).not.toHaveBeenCalled();
    expect(sonnerToast.error).not.toHaveBeenCalled();
    expect(sonnerToast.info).not.toHaveBeenCalled();
    expect(returned).toBeUndefined();
  });
});
