import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import {
    StorageProvider,
    StorageProviderEnum,
    UploadResponse,
} from "./StorageProvider";
import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet";

export class ArweaveProvider implements StorageProvider {
    provider = StorageProviderEnum.ARWEAVE;
    private arweave: Arweave;
    private jwk: JWKInterface;

    constructor(runtime: IAgentRuntime) {
        // Initialize Arweave client
        this.arweave = Arweave.init({
            host: "arweave.net",
            port: 443,
            protocol: "https",
        });

        const jwk = runtime.getSetting("ARWEAVE_JWK");
        if (!jwk) {
            elizaLogger.warn(
                "To use Arweave storage service you need to set ARWEAVE_JWK in environment variables."
            );
        }

        try {
            this.jwk = JSON.parse(jwk || "{}") as JWKInterface;
        } catch (error) {
            elizaLogger.error("Failed to parse Arweave JWK:", error);
            throw new Error("Invalid Arweave JWK format");
        }
    }

    async uploadFile(file: {
        buffer: Buffer;
        originalname: string;
        mimetype: string;
    }): Promise<UploadResponse> {
        // Create transaction
        const transaction = await this.arweave.createTransaction(
            {
                data: file.buffer,
            },
            this.jwk
        );

        // Add tags
        transaction.addTag("Content-Type", file.mimetype);
        transaction.addTag("File-Name", file.originalname);

        // Sign the transaction
        await this.arweave.transactions.sign(transaction, this.jwk);

        // Submit the transaction
        const response = await this.arweave.transactions.post(transaction);

        if (response.status !== 200) {
            throw new Error(`Upload failed with status ${response.status}`);
        }

        return {
            cid: transaction.id,
            url: `https://arweave.net/${transaction.id}`,
        };
    }

    async uploadJson(
        json: Record<string, any> | string
    ): Promise<UploadResponse> {
        // Convert to string if object
        const stringifiedData =
            typeof json === "string" ? json : JSON.stringify(json);

        // Create transaction
        const transaction = await this.arweave.createTransaction(
            {
                data: stringifiedData,
            },
            this.jwk
        );

        // Add tags
        transaction.addTag("Content-Type", "application/json");

        // Sign the transaction
        await this.arweave.transactions.sign(transaction, this.jwk);

        // Submit the transaction
        const response = await this.arweave.transactions.post(transaction);

        if (response.status !== 200) {
            throw new Error(`Upload failed with status ${response.status}`);
        }

        return {
            cid: transaction.id,
            url: `https://arweave.net/${transaction.id}`,
        };
    }
}
