import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { LocalEoaBackend } from "./local-eoa-backend.js";

const HARDHAT_0_PRIVATE_KEY =
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

function makeRuntime(settings: Record<string, string>): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key] ?? null,
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
			log: () => {},
		},
	} as unknown as IAgentRuntime;
}

describe("LocalEoaBackend", () => {
	it("constructs with Solana key only", async () => {
		const kp = Keypair.generate();
		const rt = makeRuntime({
			SOLANA_PRIVATE_KEY: bs58.encode(kp.secretKey),
		});
		const w = await LocalEoaBackend.create(rt);
		const { evm, solana } = w.getAddresses();
		expect(evm).toBeNull();
		expect(solana?.toBase58()).toBe(kp.publicKey.toBase58());
		expect(w.canSign("solana")).toBe(true);
		expect(w.canSign("evm")).toBe(false);
	});

	it("constructs with EVM key only", async () => {
		const rt = makeRuntime({
			EVM_PRIVATE_KEY: HARDHAT_0_PRIVATE_KEY,
		});
		const w = await LocalEoaBackend.create(rt);
		const { evm, solana } = w.getAddresses();
		expect(evm).toMatch(/^0x[a-fA-F0-9]{40}$/);
		expect(solana).toBeNull();
		expect(w.canSign("evm")).toBe(true);
		expect(w.canSign("solana")).toBe(false);
	});

	it("throws when both chains are missing", async () => {
		const rt = makeRuntime({});
		await expect(LocalEoaBackend.create(rt)).rejects.toMatchObject({
			code: "NO_WALLET_CONFIGURED",
		});
	});

	it("constructs when both keys are present", async () => {
		const kp = Keypair.generate();
		const rt = makeRuntime({
			EVM_PRIVATE_KEY: HARDHAT_0_PRIVATE_KEY,
			SOLANA_PRIVATE_KEY: bs58.encode(kp.secretKey),
		});
		const w = await LocalEoaBackend.create(rt);
		const { evm, solana } = w.getAddresses();
		expect(evm).toMatch(/^0x[a-fA-F0-9]{40}$/);
		expect(solana?.toBase58()).toBe(kp.publicKey.toBase58());
	});
});
