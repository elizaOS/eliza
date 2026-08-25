import { beforeEach, describe, expect, it, vi } from "vitest";

const tiktokenMock = vi.hoisted(() => ({
  encodingForModel: vi.fn(),
  getEncoding: vi.fn(),
}));

const configMock = vi.hoisted(() => ({
  getLargeModel: vi.fn(),
  getSmallModel: vi.fn(),
}));

const coreMock = vi.hoisted(() => ({
  ModelType: { TEXT_SMALL: "TEXT_SMALL" },
}));

vi.mock("js-tiktoken", () => tiktokenMock);
vi.mock("@elizaos/core", () => coreMock);
vi.mock("./config", () => configMock);

import { countTokens, detokenizeText, tokenizeText } from "./tokenization";

function makeEncoder() {
  return {
    encode: vi.fn((text: string) => [...text].map((ch) => ch.charCodeAt(0))),
    decode: vi.fn((tokens: number[]) => tokens.map((t) => String.fromCharCode(t)).join("")),
  };
}

const runtime = { modelProvider: "openai" } as never;

describe("openai tokenization", () => {
  beforeEach(() => {
    tiktokenMock.encodingForModel.mockReset();
    tiktokenMock.getEncoding.mockReset();
    configMock.getLargeModel.mockReset();
    configMock.getSmallModel.mockReset();
  });

  it("tokenizes through the model's registered encoding", () => {
    const encoder = makeEncoder();
    tiktokenMock.encodingForModel.mockReturnValue(encoder);
    configMock.getLargeModel.mockReturnValue("gpt-4o-mini");
    const tokens = tokenizeText(runtime, "TEXT_LARGE" as never, "hi");
    expect(tiktokenMock.encodingForModel).toHaveBeenCalledWith("gpt-4o-mini");
    expect(encoder.encode).toHaveBeenCalledWith("hi");
    expect(tokens).toEqual([104, 105]);
  });

  it("resolves the small-model slot for TEXT_SMALL requests", () => {
    const encoder = makeEncoder();
    tiktokenMock.encodingForModel.mockReturnValue(encoder);
    configMock.getSmallModel.mockReturnValue("gpt-4.1-nano");
    tokenizeText(runtime, "TEXT_SMALL" as never, "x");
    expect(configMock.getSmallModel).toHaveBeenCalledWith(runtime);
    expect(configMock.getLargeModel).not.toHaveBeenCalled();
    expect(tiktokenMock.encodingForModel).toHaveBeenCalledWith("gpt-4.1-nano");
  });

  it("falls back to o200k_base for unknown 4o-family models instead of throwing", () => {
    const encoder = makeEncoder();
    tiktokenMock.encodingForModel.mockImplementation(() => {
      throw new Error("Unknown model gpt-4o-custom");
    });
    tiktokenMock.getEncoding.mockReturnValue(encoder);
    configMock.getLargeModel.mockReturnValue("gpt-4o-custom");
    const tokens = tokenizeText(runtime, "TEXT_LARGE" as never, "hi");
    expect(tiktokenMock.getEncoding).toHaveBeenCalledWith("o200k_base");
    expect(tokens).toEqual([104, 105]);
  });

  it("falls back to cl100k_base for unknown non-4o models", () => {
    const encoder = makeEncoder();
    tiktokenMock.encodingForModel.mockImplementation(() => {
      throw new Error("Unknown model claude-3-5-sonnet");
    });
    tiktokenMock.getEncoding.mockReturnValue(encoder);
    configMock.getLargeModel.mockReturnValue("claude-3-5-sonnet");
    tokenizeText(runtime, "TEXT_LARGE" as never, "hi");
    expect(tiktokenMock.getEncoding).toHaveBeenCalledWith("cl100k_base");
  });

  it("detects the 4o family case-insensitively for the fallback choice", () => {
    const encoder = makeEncoder();
    tiktokenMock.encodingForModel.mockImplementation(() => {
      throw new Error("Unknown model GPT-4O-MINI");
    });
    tiktokenMock.getEncoding.mockReturnValue(encoder);
    configMock.getLargeModel.mockReturnValue("GPT-4O-MINI");
    tokenizeText(runtime, "TEXT_LARGE" as never, "hi");
    expect(tiktokenMock.getEncoding).toHaveBeenCalledWith("o200k_base");
  });

  it("counts tokens as the encoded array length", () => {
    const encoder = makeEncoder();
    tiktokenMock.encodingForModel.mockReturnValue(encoder);
    configMock.getLargeModel.mockReturnValue("gpt-4o");
    expect(countTokens(runtime, "TEXT_LARGE" as never, "hello")).toBe(5);
  });

  it("detokenizes through the resolved encoding's decoder", () => {
    const encoder = makeEncoder();
    tiktokenMock.encodingForModel.mockReturnValue(encoder);
    configMock.getLargeModel.mockReturnValue("gpt-4o");
    const out = detokenizeText(runtime, "TEXT_LARGE" as never, [104, 105]);
    expect(encoder.decode).toHaveBeenCalledWith([104, 105]);
    expect(out).toBe("hi");
  });

  it("never falls back for a model that is registered (encoders are cached per model)", () => {
    const encoder = makeEncoder();
    tiktokenMock.encodingForModel.mockReturnValue(encoder);
    configMock.getLargeModel.mockReturnValue("gpt-4.1");
    tokenizeText(runtime, "TEXT_LARGE" as never, "a");
    expect(tiktokenMock.getEncoding).not.toHaveBeenCalled();
  });
});
