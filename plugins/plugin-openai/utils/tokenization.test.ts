import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEncoder = {
  encode: vi.fn((text: string) => Array.from(text).map((_, i) => i)),
  decode: vi.fn((tokens: number[]) => String.fromCharCode(...tokens)),
};

vi.mock("js-tiktoken", () => ({
  encodingForModel: vi.fn(),
  getEncoding: vi.fn(() => mockEncoder),
}));

vi.mock("./config", () => ({
  getLargeModel: vi.fn(() => "gpt-4o"),
  getSmallModel: vi.fn(() => "gpt-4o-mini"),
}));

import { ModelType } from "@elizaos/core";
import { encodingForModel, getEncoding } from "js-tiktoken";
import { getLargeModel, getSmallModel } from "./config";
import { countTokens, detokenizeText, tokenizeText } from "./tokenization.js";

const runtime = {} as never;

describe("tokenizeText", () => {
  beforeEach(() => {
    vi.mocked(encodingForModel).mockReset();
    vi.mocked(getEncoding).mockReset().mockReturnValue(mockEncoder);
    vi.mocked(getLargeModel).mockReset().mockReturnValue("gpt-4o");
    vi.mocked(getSmallModel).mockReset().mockReturnValue("gpt-4o-mini");
  });

  it("uses the tiktoken registry encoding for a known model name", () => {
    vi.mocked(encodingForModel).mockReturnValue(mockEncoder);
    const tokens = tokenizeText(runtime, ModelType.TEXT_LARGE as never, "hello");
    expect(vi.mocked(encodingForModel)).toHaveBeenCalledWith("gpt-4o");
    expect(tokens).toEqual([0, 1, 2, 3, 4]);
  });

  it("falls back to o200k_base for an unknown 4o-family model name", () => {
    vi.mocked(getLargeModel).mockReturnValue("gpt-4o-custom");
    vi.mocked(encodingForModel).mockImplementation(() => {
      throw new Error("Unknown model gpt-4o-custom");
    });
    const tokens = tokenizeText(runtime, ModelType.TEXT_LARGE as never, "hi");
    expect(tokens).toEqual([0, 1]);
    expect(vi.mocked(getEncoding)).toHaveBeenCalledWith("o200k_base");
  });

  it("falls back to cl100k_base for an unknown model without the 4o marker", () => {
    vi.mocked(getLargeModel).mockReturnValue("my-private-llm");
    vi.mocked(encodingForModel).mockImplementation(() => {
      throw new Error("Unknown model");
    });
    const tokens = tokenizeText(runtime, ModelType.TEXT_LARGE as never, "hi");
    expect(tokens).toEqual([0, 1]);
    expect(vi.mocked(getEncoding)).toHaveBeenCalledWith("cl100k_base");
  });

  it("routes TEXT_SMALL through the small model setting", () => {
    vi.mocked(encodingForModel).mockReturnValue(mockEncoder);
    tokenizeText(runtime, ModelType.TEXT_SMALL as never, "hi");
    expect(vi.mocked(getSmallModel)).toHaveBeenCalled();
    expect(vi.mocked(encodingForModel)).toHaveBeenCalledWith("gpt-4o-mini");
    expect(vi.mocked(getLargeModel)).not.toHaveBeenCalled();
  });
});

describe("countTokens", () => {
  it("returns the encoded length", () => {
    vi.mocked(encodingForModel).mockReturnValue(mockEncoder);
    expect(countTokens(runtime, ModelType.TEXT_LARGE as never, "hello")).toBe(5);
  });
});

describe("detokenizeText", () => {
  it("decodes through the resolved encoder", () => {
    vi.mocked(encodingForModel).mockReturnValue(mockEncoder);
    expect(detokenizeText(runtime, ModelType.TEXT_LARGE as never, [72, 105])).toBe(
      String.fromCharCode(72, 105)
    );
  });
});
