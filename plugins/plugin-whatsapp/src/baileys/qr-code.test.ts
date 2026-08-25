import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toDataURL: vi.fn(),
  terminalGenerate: vi.fn(),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: mocks.toDataURL },
}));

vi.mock("qrcode-terminal", () => ({
  generate: mocks.terminalGenerate,
}));

import { QRCodeGenerator } from "./qr-code";

describe("QRCodeGenerator", () => {
  const qrString = "1@example.com,abc123,,pairing,";
  let generator: QRCodeGenerator;

  beforeEach(() => {
    mocks.toDataURL.mockReset();
    mocks.terminalGenerate.mockReset();
    mocks.toDataURL.mockResolvedValue("data:image/png;base64,AA==");
    mocks.terminalGenerate.mockImplementation(
      (_qr: string, _opts: unknown, cb: (out: string) => void) => {
        cb("▄▄▄▄▄▄");
      }
    );
    generator = new QRCodeGenerator();
  });

  it("returns the raw pairing string unchanged", async () => {
    const out = await generator.generate(qrString);
    expect(out.raw).toBe(qrString);
  });

  it("renders the terminal block from the qrcode-terminal callback", async () => {
    const out = await generator.generate(qrString);
    expect(out.terminal).toBe("▄▄▄▄▄▄");
  });

  it("requests a small terminal rendering of the exact QR string", async () => {
    await generator.generate(qrString);
    expect(mocks.terminalGenerate).toHaveBeenCalledWith(
      qrString,
      { small: true },
      expect.any(Function)
    );
  });

  it("produces a data-URL image for the pairing string", async () => {
    const out = await generator.generate(qrString);
    expect(mocks.toDataURL).toHaveBeenCalledWith(qrString);
    expect(out.dataURL).toBe("data:image/png;base64,AA==");
  });

  it("propagates data-URL render failures to the caller", async () => {
    mocks.toDataURL.mockRejectedValueOnce(new Error("png encode failed"));
    await expect(generator.generate(qrString)).rejects.toThrow("png encode failed");
  });

  it("handles an empty QR string without crashing", async () => {
    const out = await generator.generate("");
    expect(out.raw).toBe("");
    expect(out.terminal).toBe("▄▄▄▄▄▄");
  });
});
