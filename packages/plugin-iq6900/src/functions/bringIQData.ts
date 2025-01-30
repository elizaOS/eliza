import { elizaLogger } from "@elizaos/core";
import { Connection, PublicKey } from "@solana/web3.js";

// Types
interface TransactionInfo {
    argData?: {
        type_field?: string;
        offset?: string;
        tail_tx?: string;
    };
}

interface TransactionData {
    method: string;
    code: string;
    decode_break: number;
    before_tx: string;
}

interface TransactionDataResponse {
    code: string;
    method: string;
    decode_break: number;
}

interface CodeResult {
    json_data: string;
    commit_message: string;
}

// Constants
const NETWORK = process.env.IQSOlRPC || "https://api.mainnet-beta.solana.com";
const WALLET_ADDRESS = process.env.IQ_WALLET_ADDRESS;
const IQ_HOST = "https://solanacontractapi.uc.r.appspot.com";
const GENESIS_TX = "Genesis";
const ERROR_RESULT: CodeResult = {
    json_data: "false",
    commit_message: "false",
};

// Initialize connection
const connection = new Connection(NETWORK, "confirmed");

async function convertTextToEmoji(text: string): Promise<string> {
    return text.replace(/\/u([0-9A-Fa-f]{4,6})/g, (_, code) =>
        String.fromCodePoint(Number.parseInt(code, 16))
    );
}

async function fetchTransactionInfo(
    txId: string
): Promise<TransactionInfo["argData"] | null> {
    try {
        const response = await fetch(`${IQ_HOST}/get_transaction_info/${txId}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.argData || null;
    } catch (error) {
        elizaLogger.error("Error fetching transaction info:", error);
        return null;
    }
}

async function fetchDBPDA(): Promise<string | null> {
    if (!WALLET_ADDRESS) {
        elizaLogger.error("Wallet address not provided");
        return null;
    }

    try {
        elizaLogger.info("Connecting to Solana...(IQ6900)");
        elizaLogger.info(`Your Address: ${WALLET_ADDRESS}`);

        const response = await fetch(`${IQ_HOST}/getDBPDA/${WALLET_ADDRESS}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.DBPDA || null;
    } catch (error) {
        elizaLogger.error("Error fetching PDA:", error);
        return null;
    }
}

async function getTransactionData(transactionData: TransactionData): Promise<{
    data: TransactionDataResponse | "fail";
    before_tx: string;
}> {
    if (!transactionData || !("code" in transactionData)) {
        return {
            data: "fail",
            before_tx: "fail",
        };
    }

    return {
        data: {
            code: transactionData.code,
            method: transactionData.method,
            decode_break: transactionData.decode_break,
        },
        before_tx: transactionData.before_tx,
    };
}

async function extractCommitMessage(dataTxid: string): Promise<string | null> {
    const txInfo = await fetchTransactionInfo(dataTxid);
    if (!txInfo) return null;

    const type_field = txInfo.type_field || null;
    if (type_field === "json" && txInfo.offset) {
        const [, commitMessage] = txInfo.offset.split("commit: ");
        return commitMessage || null;
    }

    return null;
}

function isTransactionDataResponse(data: TransactionDataResponse | "fail"): data is TransactionDataResponse {
    return data !== "fail" && typeof data === "object" && "code" in data;
}

async function bringCode(dataTxid: string): Promise<CodeResult> {
    const txInfo = await fetchTransactionInfo(dataTxid);
    if (!txInfo || !txInfo.tail_tx) return ERROR_RESULT;

    const chunks: string[] = [];
    let before_tx = txInfo.tail_tx;

    if (before_tx === null) return ERROR_RESULT;

    try {
        while (before_tx !== GENESIS_TX) {
            if (!before_tx) {
                elizaLogger.error("Before transaction undefined");
                return ERROR_RESULT;
            }

            elizaLogger.info(`Chunks: ${before_tx}`);
            const chunk = await fetchTransactionInfo(before_tx);

            if (!chunk) {
                elizaLogger.error("No chunk found");
                return ERROR_RESULT;
            }

            const chunkData = await getTransactionData(
                chunk as TransactionData
            );
            if (!chunkData.data || !isTransactionDataResponse(chunkData.data)) {
                elizaLogger.error("Chunk data undefined or invalid");
                return ERROR_RESULT;
            }

            chunks.push(chunkData.data.code);
            before_tx = chunkData.before_tx;
        }

        const textData = chunks.reverse().join("");
        return {
            json_data: await convertTextToEmoji(textData),
            commit_message: txInfo.offset || "false",
        };
    } catch (error) {
        elizaLogger.error("Error in bringCode:", error);
        return ERROR_RESULT;
    }
}

async function fetchSignaturesForAddress(
    dbAddress: PublicKey
): Promise<string[]> {
    try {
        elizaLogger.info("Find Your Signature...(IQ6900)");
        const signatures = await connection.getSignaturesForAddress(dbAddress, {
            limit: 20,
        });
        return signatures.map((sig) => sig.signature);
    } catch (error) {
        elizaLogger.error("Error fetching signatures:", error);
        return [];
    }
}

async function findRecentJsonSignature(): Promise<string | null> {
    const dbAddress = await fetchDBPDA();
    if (!dbAddress) {
        elizaLogger.error("Failed to fetch DBPDA");
        return null;
    }

    const signatures = await fetchSignaturesForAddress(
        new PublicKey(dbAddress)
    );
    if (signatures.length === 0) {
        elizaLogger.error("No signatures found");
        return null;
    }

    for (const signature of signatures) {
        const commit = await extractCommitMessage(signature);
        if (commit) return signature;
    }

    return null;
}

export async function bringAgentWithWalletAddress(): Promise<string | null> {
    const recent = await findRecentJsonSignature();
    if (!recent) {
        elizaLogger.error("Cannot found onchain data in this wallet.");
        return null;
    }

    const result = await bringCode(recent);
    return result.json_data === "false" ? null : result.json_data;
}
