import { describe, expect, it, vi } from "vitest";
import { displayQRUrl } from "./qrcode.ts";

describe("displayQRUrl", () => {
  it("prints the url inside the box", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    displayQRUrl("https://weixin.qq.com/x/abc123");
    expect(spy).toHaveBeenCalled();
    const printed = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(printed).toContain("https://weixin.qq.com/x/abc123");
    expect(printed).toContain("Scan this QR code with WeChat");
    spy.mockRestore();
  });

  it("handles empty urls without crashing", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => displayQRUrl("")).not.toThrow();
    spy.mockRestore();
  });
});
