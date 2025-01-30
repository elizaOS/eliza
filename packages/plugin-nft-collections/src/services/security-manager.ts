import * as crypto from "node:crypto";

interface SecurityConfig {
    algorithm: string;
}
type SensitiveData = string | number | boolean | object;

export class SecurityManager {
    private config: SecurityConfig;
    private key: Buffer;
    private iv: Buffer;

    constructor(config: SecurityConfig) {
        this.config = config;
        // Generate a secure key and IV
        this.key = crypto.randomBytes(32); // 256 bits for AES-256
        this.iv = crypto.randomBytes(16); // 128 bits for AES
    }

    encryptSensitiveData(data: SensitiveData): string {
        const cipher = crypto.createCipheriv(
            this.config.algorithm,
            this.key,
            this.iv
        );

        let encrypted = cipher.update(JSON.stringify(data), "utf8", "hex");
        encrypted += cipher.final("hex");

        // Return IV + encrypted data
        return `${this.iv.toString("hex")}:${encrypted}`;
    }

    decryptSensitiveData<T>(encryptedData: string): T {
        const [ivHex, data] = encryptedData.split(":");
        const iv = Buffer.from(ivHex, "hex");

        const decipher = crypto.createDecipheriv(
            this.config.algorithm,
            this.key,
            iv
        );

        let decrypted = decipher.update(data, "hex", "utf8");
        decrypted += decipher.final("utf8");

        try {
            return JSON.parse(decrypted);
        } catch {
            throw new Error('Failed to decrypt or parse data');
        }
    }

    hashData(data: string): string {
        return crypto.createHash("sha256").update(data).digest("hex");
    }

    generateSignature(data: SensitiveData, timestamp: number): string {
        const message = JSON.stringify(data) + timestamp;
        return crypto
            .createHmac("sha256", this.key)
            .update(message)
            .digest("hex");
    }

    verifySignature(data: SensitiveData, timestamp: number, signature: string): boolean {
        const expectedSignature = this.generateSignature(data, timestamp);
        const signatureBuffer = Buffer.from(signature);
        const expectedBuffer = Buffer.from(expectedSignature);

        if (signatureBuffer.length !== expectedBuffer.length) {
            return false;
        }

        return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
    }
}
