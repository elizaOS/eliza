import { describe, expect, it } from "vitest";
import { parseBrowserWorkspaceEvmChainId } from "./browser-workspace-wallet";

describe("parseBrowserWorkspaceEvmChainId", () => {
  it("rejects a hex chain id that contains a non-hex character", () => {
    expect(parseBrowserWorkspaceEvmChainId("0x1g")).toBeNull();
  });

  it("still accepts a plain hex chain id and a decimal chain id", () => {
    expect(parseBrowserWorkspaceEvmChainId("0x1")).toBe(1);
    expect(parseBrowserWorkspaceEvmChainId("0x89")).toBe(137);
    expect(parseBrowserWorkspaceEvmChainId("137")).toBe(137);
  });
});
