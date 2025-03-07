import {
	VersionedTransaction,
	PublicKey,
	TransactionMessage,
	type Keypair,
	SystemProgram,
} from "@solana/web3.js";
import bs58 from "bs58";

// Constants
const JITO_TIP_LAMPORTS = 40_000;
const MAX_BUNDLE_STATUS_ATTEMPTS = 10;
const BUNDLE_STATUS_CHECK_DELAY = 5000; // 5 seconds
const JSON_RPC_VERSION = "2.0";
const DEFAULT_HEADERS = { "Content-Type": "application/json" };

export enum JitoRegion {
	Mainnet = "mainnet",
	Amsterdam = "amsterdam",
	Frankfurt = "frankfurt",
	NY = "ny",
	Tokyo = "tokyo",
}

export const JitoEndpoints: Record<JitoRegion, string> = {
	[JitoRegion.Mainnet]: "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
	[JitoRegion.Amsterdam]:
		"https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
	[JitoRegion.Frankfurt]:
		"https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
	[JitoRegion.NY]: "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles",
	[JitoRegion.Tokyo]:
		"https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
};

interface BundleResponse {
	signature: string;
	bundleStatus: string;
	transactions: string[];
}

interface JitoApiResponse {
	result: any;
	error?: { message: string };
}

// Helper Functions
export function getJitoEndpoint(region: JitoRegion): string {
	return JitoEndpoints[region];
}

export async function getRandomValidator(
	rpcEndpoint: string,
): Promise<PublicKey> {
	const payload = {
		jsonrpc: JSON_RPC_VERSION,
		id: 1,
		method: "getTipAccounts",
		params: [],
	};

	try {
		const res = await fetch(rpcEndpoint, {
			method: "POST",
			body: JSON.stringify(payload),
			headers: DEFAULT_HEADERS,
		});
		const json: JitoApiResponse = await res.json();

		if (json.error) {
			throw new Error(`Jito API Error: ${json.error.message}`);
		}

		const validators = json.result as string[];
		const randomIndex = Math.floor(Math.random() * validators.length);
		return new PublicKey(validators[randomIndex]);
	} catch (error) {
		console.error("Error fetching random validator:", error);
		throw error;
	}
}

async function fetchJitoApi(
	endpoint: string,
	payload: any,
): Promise<JitoApiResponse> {
	try {
		const res = await fetch(endpoint, {
			method: "POST",
			body: JSON.stringify(payload),
			headers: DEFAULT_HEADERS,
		});
		const json: JitoApiResponse = await res.json();

		if (json.error) {
			throw new Error(`Jito API Error: ${json.error.message}`);
		}

		return json;
	} catch (error) {
		console.error("Error in Jito API request:", error);
		throw error;
	}
}

// Main Function
export async function sendTxUsingJito({
	versionedTxs,
	region = JitoRegion.Mainnet,
	authority,
	lastestBlockhash,
}: {
	versionedTxs: VersionedTransaction[];
	region: JitoRegion;
	authority: Keypair;
	lastestBlockhash: { blockhash: string };
}): Promise<BundleResponse | null> {
	const rpcEndpoint = getJitoEndpoint(region);
	const tipAccount = await getRandomValidator(rpcEndpoint);

	// Create Jito fee transaction
	const jitoFeeMessage = new TransactionMessage({
		payerKey: authority.publicKey,
		recentBlockhash: lastestBlockhash.blockhash,
		instructions: [
			SystemProgram.transfer({
				fromPubkey: authority.publicKey,
				toPubkey: tipAccount,
				lamports: JITO_TIP_LAMPORTS,
			}),
		],
	}).compileToV0Message();

	const jitoFeeTransaction = new VersionedTransaction(jitoFeeMessage);
	jitoFeeTransaction.sign([authority]);

	// Serialize transactions
	const serializedJitoFeeTransaction = bs58.encode(
		jitoFeeTransaction.serialize(),
	);
	const encodedVersionedTxs = versionedTxs.map((tx) =>
		bs58.encode(tx.serialize()),
	);
	const finalTransaction = [
		...encodedVersionedTxs,
		serializedJitoFeeTransaction,
	];

	// Send bundle
	const payload = {
		jsonrpc: JSON_RPC_VERSION,
		id: 1,
		method: "sendBundle",
		params: [finalTransaction],
	};

	try {
		const json = await fetchJitoApi(`${rpcEndpoint}?bundleOnly=true`, payload);
		const bundleTxn = json.result;

		// Check bundle status
		let bundleStatus;
		let attempts = 0;

		while (
			bundleStatus !== "Landed" &&
			bundleStatus !== "Failed" &&
			attempts < MAX_BUNDLE_STATUS_ATTEMPTS
		) {
			const statusResponse = await fetchJitoApi(rpcEndpoint, {
				jsonrpc: JSON_RPC_VERSION,
				id: 1,
				method: "getInflightBundleStatuses",
				params: [[bundleTxn]],
			});

			bundleStatus = statusResponse?.result?.value[0]?.status;
			attempts++;

			if (bundleStatus === "Failed") {
				console.error("Bundle failed to land");
				break;
			}

			await new Promise((resolve) =>
				setTimeout(resolve, BUNDLE_STATUS_CHECK_DELAY),
			);
		}

		let transactions;
		if (bundleStatus === "Landed") {
			const bundleStatuses = await fetchJitoApi(rpcEndpoint, {
				jsonrpc: JSON_RPC_VERSION,
				id: 1,
				method: "getBundleStatuses",
				params: [[bundleTxn]],
			});

			transactions = bundleStatuses?.result?.value[0]?.transactions;
		}

		return {
			signature: bundleTxn,
			bundleStatus: bundleStatus || "Unknown",
			transactions: transactions || [],
		};
	} catch (error) {
		console.error("Error in sendTxUsingJito:", error);
		throw error;
	}
}
