import { describe, expect, it } from "vitest";
import { MessageTransmitterV2Abi, TokenMessengerV2Abi } from "./abis.ts";

describe("CCTP V2 ABIs", () => {
  describe("TokenMessengerV2Abi", () => {
    it("exposes depositForBurn with burn inputs", () => {
      const fn = TokenMessengerV2Abi.find((e) => e.name === "depositForBurn");
      expect(fn).toBeDefined();
      expect(fn?.type).toBe("function");
      expect(fn?.stateMutability).toBe("nonpayable");
      const inputTypes = fn?.inputs.map((i) => i.type) ?? [];
      expect(inputTypes).toContain("uint256"); // amount
      expect(inputTypes).toContain("uint32"); // destinationDomain
      expect(inputTypes).toContain("bytes32"); // mintRecipient
      expect(inputTypes).toContain("address"); // burnToken
      expect(fn?.outputs?.[0]?.type).toBe("uint64"); // nonce
    });

    it("exposes depositForBurnWithHook with hookData", () => {
      const fn = TokenMessengerV2Abi.find(
        (e) => e.name === "depositForBurnWithHook",
      );
      expect(fn).toBeDefined();
      const inputTypes = fn?.inputs.map((i) => i.type) ?? [];
      expect(inputTypes).toContain("bytes"); // hookData
    });

    it("exposes localMessageTransmitter view returning address", () => {
      const fn = TokenMessengerV2Abi.find(
        (e) => e.name === "localMessageTransmitter",
      );
      expect(fn?.type).toBe("function");
      expect(fn?.stateMutability).toBe("view");
      expect(fn?.outputs?.[0]?.type).toBe("address");
    });

    it("exposes localDomain view returning uint32", () => {
      const fn = TokenMessengerV2Abi.find((e) => e.name === "localDomain");
      expect(fn?.stateMutability).toBe("view");
      expect(fn?.outputs?.[0]?.type).toBe("uint32");
    });
  });

  describe("MessageTransmitterV2Abi", () => {
    it("exposes receiveMessage for minting on destination chain", () => {
      const fn = MessageTransmitterV2Abi.find(
        (e) => e.name === "receiveMessage",
      );
      expect(fn).toBeDefined();
      expect(fn?.type).toBe("function");
      expect(fn?.stateMutability).toBe("nonpayable");
    });

    it("exposes usedNonces for replay protection", () => {
      const fn = MessageTransmitterV2Abi.find((e) => e.name === "usedNonces");
      expect(fn).toBeDefined();
      expect(fn?.stateMutability).toBe("view");
      expect(fn?.inputs?.[0]?.type).toBe("bytes32");
      expect(fn?.outputs?.[0]?.type).toBe("uint256");
    });
  });

  it("all ABI entries are well-formed", () => {
    for (const abi of [TokenMessengerV2Abi, MessageTransmitterV2Abi]) {
      for (const entry of abi) {
        expect(entry.name).toBeTruthy();
        expect(entry.type).toBeTruthy();
        if (entry.type === "function") {
          expect(entry.inputs).toBeDefined();
          expect(entry.outputs).toBeDefined();
        }
      }
    }
  });
});
