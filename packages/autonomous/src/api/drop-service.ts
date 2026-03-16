/**
 * MiladyMaker drop/mint service.
 *
 * Handles the ERC-8041 fixed-supply collection minting:
 * - Public free mint (user pays gas)
 * - Shiny mint (0.1 ETH + gas)
 * - Whitelist mint (Merkle proof)
 * - Supply tracking and status
 */

import { logger } from "@elizaos/core";
import { ethers } from "ethers";
import type { DropStatus, MintResult } from "../contracts/drop";
import type { TxService } from "./tx-service";

export type { DropStatus, MintResult } from "../contracts/drop";

// ── ABI ──────────────────────────────────────────────────────────────────

const COLLECTION_ABI = [
  "function mint(string,string,bytes32) external returns (uint256)",
  "function mintShiny(string,string,bytes32) external payable returns (uint256)",
  "function mintWhitelist(string,string,bytes32,bytes32[]) external returns (uint256)",
  "function mintFor(address,string,string,bytes32,bool) external returns (uint256)",
  "function currentSupply() view returns (uint256)",
  "function publicMintOpen() view returns (bool)",
  "function whitelistMintOpen() view returns (bool)",
  "function hasMinted(address) view returns (bool)",
  "function getAgentMintNumber(uint256) view returns (uint256)",
  "function isShiny(uint256) view returns (bool)",
  "function getCollectionDetails() view returns (uint256,uint256,bool)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function SHINY_PRICE() view returns (uint256)",
  "function merkleRoot() view returns (bytes32)",
  "event AgentMinted(uint256 indexed agentId, uint256 indexed mintNumber, address indexed owner, bool shiny)",
  "event CollectionUpdated(uint256 maxSupply, uint256 currentSupply, bool publicOpen, bool whitelistOpen)",
] as const;

const DEFAULT_CAP_HASH = ethers.id("milady-agent");

// ── Service ──────────────────────────────────────────────────────────────

export class DropService {
  private readonly contract: ethers.Contract;
  private readonly txService: TxService;
  private readonly dropEnabled: boolean;

  constructor(
    txService: TxService,
    collectionAddress: string,
    dropEnabled: boolean,
  ) {
    this.txService = txService;
    this.contract = txService.getContract(collectionAddress, COLLECTION_ABI);
    this.dropEnabled = dropEnabled;
  }

  async getStatus(): Promise<DropStatus> {
    if (!this.dropEnabled) {
      return {
        dropEnabled: false,
        publicMintOpen: false,
        whitelistMintOpen: false,
        mintedOut: false,
        currentSupply: 0,
        maxSupply: 2138,
        shinyPrice: "0.1",
        userHasMinted: false,
      };
    }

    const [collectionDetails, whitelistOpen, hasMinted, shinyPriceBN] =
      await Promise.all([
        this.contract.getCollectionDetails() as Promise<
          [bigint, bigint, boolean]
        >,
        this.contract.whitelistMintOpen() as Promise<boolean>,
        this.contract.hasMinted(this.txService.address) as Promise<boolean>,
        this.contract.SHINY_PRICE() as Promise<bigint>,
      ]);

    const [maxSupply, currentSupply, publicOpen] = collectionDetails;
    const maxSupplyNum = Number(maxSupply);
    const currentSupplyNum = Number(currentSupply);

    return {
      dropEnabled: true,
      publicMintOpen: publicOpen,
      whitelistMintOpen: whitelistOpen,
      mintedOut: currentSupplyNum >= maxSupplyNum,
      currentSupply: currentSupplyNum,
      maxSupply: maxSupplyNum,
      shinyPrice: ethers.formatEther(shinyPriceBN),
      userHasMinted: hasMinted,
    };
  }

  async mint(
    name: string,
    endpoint: string,
    capabilitiesHash?: string,
  ): Promise<MintResult> {
    const capHash = capabilitiesHash || DEFAULT_CAP_HASH;

    logger.info(`[drop] Minting agent "${name}" for ${this.txService.address}`);

    // Get fresh nonce before transaction
    const nonce = await this.txService.getFreshNonce();

    const tx = await this.contract.mint(name, endpoint, capHash, { nonce });
    logger.info(`[drop] Mint tx submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    return this.parseMintReceipt(receipt, false);
  }

  async mintShiny(
    name: string,
    endpoint: string,
    capabilitiesHash?: string,
  ): Promise<MintResult> {
    const capHash = capabilitiesHash || DEFAULT_CAP_HASH;
    const shinyPrice = (await this.contract.SHINY_PRICE()) as bigint;

    logger.info(
      `[drop] Minting SHINY agent "${name}" for ${this.txService.address} (${ethers.formatEther(shinyPrice)} ETH)`,
    );

    // Get fresh nonce before transaction
    const nonce = await this.txService.getFreshNonce();

    const tx = await this.contract.mintShiny(name, endpoint, capHash, {
      value: shinyPrice,
      nonce,
    });
    logger.info(`[drop] Shiny mint tx submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    return this.parseMintReceipt(receipt, true);
  }

  async mintWithWhitelist(
    name: string,
    endpoint: string,
    proof: string[],
    capabilitiesHash?: string,
  ): Promise<MintResult> {
    const capHash = capabilitiesHash || DEFAULT_CAP_HASH;

    logger.info(
      `[drop] Whitelist minting agent "${name}" for ${this.txService.address}`,
    );

    // Get fresh nonce before transaction
    const nonce = await this.txService.getFreshNonce();

    const tx = await this.contract.mintWhitelist(
      name,
      endpoint,
      capHash,
      proof,
      { nonce },
    );
    logger.info(`[drop] Whitelist mint tx submitted: ${tx.hash}`);

    const receipt = await tx.wait();
    return this.parseMintReceipt(receipt, false);
  }

  async getMintNumber(agentId: number): Promise<number> {
    return Number(await this.contract.getAgentMintNumber(agentId));
  }

  async checkIsShiny(agentId: number): Promise<boolean> {
    return this.contract.isShiny(agentId) as Promise<boolean>;
  }

  private parseMintReceipt(
    receipt: ethers.TransactionReceipt,
    shiny: boolean,
  ): MintResult {
    const iface = new ethers.Interface(COLLECTION_ABI);
    let agentId = 0;
    let mintNumber = 0;

    for (const log of receipt.logs) {
      const parsed = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (parsed && parsed.name === "AgentMinted") {
        agentId = Number(parsed.args[0]);
        mintNumber = Number(parsed.args[1]);
        shiny = parsed.args[3] as boolean;
        break;
      }
    }

    logger.info(
      `[drop] Minted: agentId=${agentId} mintNumber=${mintNumber} shiny=${shiny} txHash=${receipt.hash}`,
    );

    return { agentId, mintNumber, txHash: receipt.hash, isShiny: shiny };
  }
}
