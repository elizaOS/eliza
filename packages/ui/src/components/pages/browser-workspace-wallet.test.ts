/**
 * Unit tests for the browser-workspace wallet value helpers. Browser-engine
 * integration is exercised at the native preload and service boundaries.
 */
import { describe, expect, it } from "vitest";
import {
  parseBrowserWorkspaceEvmChainId,
  resolveBrowserWorkspaceSignMessage,
} from "./browser-workspace-wallet";

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";

describe("browser workspace wallet helpers", () => {
  it("resolves personal_sign message from both common parameter orders", () => {
    expect(
      resolveBrowserWorkspaceSignMessage([EVM_ADDRESS, "hello"], EVM_ADDRESS),
    ).toBe("hello");
    expect(
      resolveBrowserWorkspaceSignMessage(["hello", EVM_ADDRESS], EVM_ADDRESS),
    ).toBe("hello");
    expect(
      resolveBrowserWorkspaceSignMessage(
        [EVM_ADDRESS.toUpperCase(), "hello"],
        EVM_ADDRESS,
      ),
    ).toBe("hello");
  });

  it("parses decimal and hexadecimal EVM chain IDs", () => {
    expect(parseBrowserWorkspaceEvmChainId("0x1")).toBe(1);
    expect(parseBrowserWorkspaceEvmChainId("8453")).toBe(8453);
    expect(parseBrowserWorkspaceEvmChainId(42161)).toBe(42161);
    expect(parseBrowserWorkspaceEvmChainId("0x")).toBeNull();
    expect(parseBrowserWorkspaceEvmChainId(-1)).toBeNull();
  });
});
