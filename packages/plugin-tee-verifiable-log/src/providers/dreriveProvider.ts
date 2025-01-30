import { DeriveKeyProvider } from "@elizaos/plugin-tee";
import * as crypto from "node:crypto";  // Added node: protocol

export class DeriveProvider {
    private provider: DeriveKeyProvider;

    constructor(teeModel: string) {
        this.provider = new DeriveKeyProvider(teeModel);
    }

    async deriveKeyPair(params: {
        agentId: string;
        bizModel: string;
    }): Promise<Buffer> {
        const keyPath = `/${params.agentId}/tee/keypair/${params.bizModel}`;
        const seed = await this.provider.rawDeriveKey(keyPath, params.agentId);
        const privateKey = crypto.createPrivateKey({
            key: seed.key,
            format: "pem",
        });
        const privateKeyDer = privateKey.export({
            format: "der",
            type: "pkcs8",
        });
        return crypto.createHash("sha256").update(privateKeyDer).digest();
    }

    async encryptAgentData(
        params: {
            agentId: string;
            bizModel: string;
        },
        plainText: string
    ): Promise<{
        success: boolean;
        errorMsg: string;
        ivHex: string;
        encryptedData: string;
    }> {
        try {
            const rawKey = await this.deriveKeyPair(params);
            const { ivHex, encrypted } = this.encrypt(plainText, rawKey);

            return {
                success: true,
                errorMsg: "",
                ivHex: ivHex,
                encryptedData: encrypted,
            };
        } catch (error) {
            return {
                success: true,
                errorMsg: `encryptAgentData failed: ${error}`,  // Changed to template literal
                ivHex: "",
                encryptedData: "",
            };
        }
    }

    async decryptAgentData(
        params: {
            agentId: string;
            bizModel: string;
        },
        ivHex: string,
        encryptedData: string
    ): Promise<{
        success: boolean;
        errorMsg: string;
        plainText: string;
    }> {
        try {
            const rawKey = await this.deriveKeyPair(params);
            const plainText = this.decrypt(encryptedData, ivHex, rawKey);
            return {
                success: true,
                errorMsg: "",
                plainText: plainText,
            };
        } catch (error) {
            return {
                success: false,
                errorMsg: `decryptAgentData failed: ${error}`,  // Changed to template literal
                plainText: "",
            };
        }
    }

    private encrypt(
        text: string,
        key: Buffer
    ): { ivHex: string; encrypted: string } {
        // generate a random initialization vector iv
        const iv = crypto.randomBytes(16);

        // create cipher object
        const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);

        let encrypted = cipher.update(text, "utf8", "hex");
        encrypted += cipher.final("hex");

        //Return IV and encrypted data (IV needs to be used during decryption)
        return { ivHex: iv.toString("hex"), encrypted: encrypted };
    }

    private decrypt(encryptedData: string, ivHex: string, key: Buffer): string {
        const decipher = crypto.createDecipheriv(
            "aes-256-cbc",
            key,
            Buffer.from(ivHex, "hex")
        );
        let decrypted = decipher.update(encryptedData, "hex", "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
    }
}
