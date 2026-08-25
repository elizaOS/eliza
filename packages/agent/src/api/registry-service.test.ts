/**
 * Exercises the ERC-8004 registry service against a deterministic contract
 * boundary, including status projections, transaction arguments, event parsing,
 * token lookup fallback, and registration preconditions. No live chain is used.
 */

import * as ethers from "ethers";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentRegistrationParams,
  type RegistrationResult,
  RegistryService,
  type RegistryStatus,
} from "./registry-service.ts";
import type { TxService } from "./tx-service.ts";

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";
const REGISTRY_ADDRESS = "0x2222222222222222222222222222222222222222";
const DEFAULT_CAPABILITIES_HASH = ethers.id("eliza-agent");

function transaction(
  hash: string,
  logs: Array<Pick<ethers.LogParams, "data" | "topics">> = [],
) {
  return {
    hash,
    wait: vi.fn().mockResolvedValue({ hash, logs }),
  };
}

function makeHarness() {
  const contract = {
    getAgentInfo: vi.fn(),
    getTokenId: vi.fn(),
    isRegistered: vi.fn(),
    registerAgent: vi.fn(),
    syncProfile: vi.fn(),
    tokenURI: vi.fn(),
    totalAgents: vi.fn(),
    updateAgent: vi.fn(),
    updateAgentProfile: vi.fn(),
    updateTokenURI: vi.fn(),
  };
  const getContract = vi.fn(
    (_address: string, _abi: ethers.InterfaceAbi) =>
      contract as unknown as ethers.Contract,
  );
  const txService = {
    address: WALLET_ADDRESS,
    getChainId: vi.fn().mockResolvedValue(8453),
    getContract,
    getFreshNonce: vi.fn().mockResolvedValue(17),
  } as unknown as TxService;

  return {
    contract,
    getContract,
    service: new RegistryService(txService, REGISTRY_ADDRESS),
    txService,
  };
}

describe("RegistryService", () => {
  it("exposes its wallet, registry, and chain identity", async () => {
    const { getContract, service, txService } = makeHarness();

    expect(service.address).toBe(WALLET_ADDRESS);
    expect(service.contractAddress).toBe(REGISTRY_ADDRESS);
    await expect(service.getChainId()).resolves.toBe(8453);
    expect(getContract).toHaveBeenCalledOnce();
    expect(getContract.mock.calls[0]?.[0]).toBe(REGISTRY_ADDRESS);
    expect(getContract.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("registerAgent("),
        expect.stringContaining("AgentRegistered("),
      ]),
    );
    expect(txService.getChainId).toHaveBeenCalledOnce();
  });

  it("returns the observed empty registration projection without profile reads", async () => {
    const { contract, service } = makeHarness();
    contract.isRegistered.mockResolvedValue(false);
    contract.totalAgents.mockResolvedValue(9n);

    const status = await service.getStatus();

    expect(status).toEqual({
      registered: false,
      tokenId: 0,
      agentName: "",
      agentEndpoint: "",
      capabilitiesHash: "",
      isActive: false,
      tokenURI: "",
      walletAddress: WALLET_ADDRESS,
      totalAgents: 9,
    } satisfies RegistryStatus);
    expect(contract.isRegistered).toHaveBeenCalledWith(WALLET_ADDRESS);
    expect(contract.getTokenId).not.toHaveBeenCalled();
    expect(contract.getAgentInfo).not.toHaveBeenCalled();
    expect(contract.tokenURI).not.toHaveBeenCalled();
  });

  it("projects a registered agent and converts bigint identifiers", async () => {
    const { contract, service } = makeHarness();
    contract.isRegistered.mockResolvedValue(true);
    contract.totalAgents.mockResolvedValue(12n);
    contract.getTokenId.mockResolvedValue(7n);
    contract.getAgentInfo.mockResolvedValue([
      "Astra",
      "https://agent.example",
      "0xcapabilities",
      true,
    ]);
    contract.tokenURI.mockResolvedValue("ipfs://metadata");

    await expect(service.getStatus()).resolves.toEqual({
      registered: true,
      tokenId: 7,
      agentName: "Astra",
      agentEndpoint: "https://agent.example",
      capabilitiesHash: "0xcapabilities",
      isActive: true,
      tokenURI: "ipfs://metadata",
      walletAddress: WALLET_ADDRESS,
      totalAgents: 12,
    } satisfies RegistryStatus);
    expect(contract.getAgentInfo).toHaveBeenCalledWith(7);
    expect(contract.tokenURI).toHaveBeenCalledWith(7);
  });

  it("returns the token id encoded in the first registration event", async () => {
    const { contract, service, txService } = makeHarness();
    const event = new ethers.Interface([
      "event AgentRegistered(uint256 indexed tokenId, address indexed owner, string name, string endpoint)",
    ]).encodeEventLog("AgentRegistered", [
      23n,
      WALLET_ADDRESS,
      "Astra",
      "https://agent.example",
    ]);
    contract.registerAgent.mockResolvedValue(
      transaction("0xregistration", [event]),
    );
    const params = {
      name: "Astra",
      endpoint: "https://agent.example",
      capabilitiesHash: "0xcustom",
      tokenURI: "ipfs://metadata",
    } satisfies AgentRegistrationParams;

    const result = await service.register(params);

    expect(result).toEqual({
      tokenId: 23,
      txHash: "0xregistration",
    } satisfies RegistrationResult);
    expect(txService.getFreshNonce).toHaveBeenCalledOnce();
    expect(contract.registerAgent).toHaveBeenCalledWith(
      params.name,
      params.endpoint,
      params.capabilitiesHash,
      params.tokenURI,
      { nonce: 17 },
    );
    expect(contract.getTokenId).not.toHaveBeenCalled();
  });

  it("uses the default capability hash and token lookup when no event supplies an id", async () => {
    const { contract, service } = makeHarness();
    contract.registerAgent.mockResolvedValue(transaction("0xfallback"));
    contract.getTokenId.mockResolvedValue(41n);

    await expect(
      service.register({
        name: "Astra",
        endpoint: "https://agent.example",
        capabilitiesHash: "",
        tokenURI: "ipfs://metadata",
      }),
    ).resolves.toEqual({ tokenId: 41, txHash: "0xfallback" });
    expect(contract.registerAgent).toHaveBeenCalledWith(
      "Astra",
      "https://agent.example",
      DEFAULT_CAPABILITIES_HASH,
      "ipfs://metadata",
      { nonce: 17 },
    );
    expect(contract.getTokenId).toHaveBeenCalledWith(WALLET_ADDRESS);
  });

  it("rejects a token URI update before allocating a nonce when unregistered", async () => {
    const { contract, service, txService } = makeHarness();
    contract.getTokenId.mockResolvedValue(0n);

    await expect(service.updateTokenURI("ipfs://next")).rejects.toThrow(
      "Agent not registered, cannot update token URI",
    );
    expect(txService.getFreshNonce).not.toHaveBeenCalled();
    expect(contract.updateTokenURI).not.toHaveBeenCalled();
  });

  it("updates a registered token URI with a fresh nonce", async () => {
    const { contract, service } = makeHarness();
    contract.getTokenId.mockResolvedValue(8n);
    contract.updateTokenURI.mockResolvedValue(transaction("0xtoken-uri"));

    await expect(service.updateTokenURI("ipfs://next")).resolves.toBe(
      "0xtoken-uri",
    );
    expect(contract.updateTokenURI).toHaveBeenCalledWith(8, "ipfs://next", {
      nonce: 17,
    });
  });

  it.each([
    ["0xexplicit", "0xexplicit"],
    ["", DEFAULT_CAPABILITIES_HASH],
  ])(
    "updates the endpoint using capability input %j",
    async (inputHash, expectedHash) => {
      const { contract, service } = makeHarness();
      contract.updateAgent.mockResolvedValue(transaction("0xagent"));

      await expect(
        service.updateAgent("https://next.example", inputHash),
      ).resolves.toBe("0xagent");
      expect(contract.updateAgent).toHaveBeenCalledWith(
        "https://next.example",
        expectedHash,
        { nonce: 17 },
      );
    },
  );

  it.each([
    ["0xexplicit", "0xexplicit"],
    ["", DEFAULT_CAPABILITIES_HASH],
  ])(
    "synchronizes the full profile using capability input %j",
    async (inputHash, expectedHash) => {
      const { contract, service } = makeHarness();
      contract.updateAgentProfile.mockResolvedValue(transaction("0xprofile"));

      await expect(
        service.syncProfile({
          name: "Astra",
          endpoint: "https://next.example",
          capabilitiesHash: inputHash,
          tokenURI: "ipfs://next",
        }),
      ).resolves.toBe("0xprofile");
      expect(contract.updateAgentProfile).toHaveBeenCalledWith(
        "Astra",
        "https://next.example",
        expectedHash,
        "ipfs://next",
        { nonce: 17 },
      );
    },
  );

  it("forwards arbitrary registration checks and exposes the stable default hash", async () => {
    const { contract, service } = makeHarness();
    const otherAddress = "0x3333333333333333333333333333333333333333";
    contract.isRegistered.mockResolvedValue(true);

    await expect(service.isRegistered(otherAddress)).resolves.toBe(true);
    expect(contract.isRegistered).toHaveBeenCalledWith(otherAddress);
    expect(RegistryService.defaultCapabilitiesHash()).toBe(
      DEFAULT_CAPABILITIES_HASH,
    );
  });
});
