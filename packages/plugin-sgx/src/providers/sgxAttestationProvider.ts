import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { SgxAttestation } from "../types/attestation";
import { promises as fs } from 'node:fs'; // Fix: Use node: protocol
import { createHash } from 'node:crypto'; // Fix: Use node: protocol

// Function to calculate SHA-256 and return a Buffer (32 bytes)
function calculateSHA256(input: string): Buffer {
    const hash = createHash('sha256');
    hash.update(input);
    return hash.digest();
}

class SgxAttestationProvider {
    private readonly SGX_QUOTE_MAX_SIZE: number = 8192 * 4;
    private readonly SGX_TARGET_INFO_SIZE: number = 512;

    private readonly MY_TARGET_INFO_PATH: string = "/dev/attestation/my_target_info";
    private readonly TARGET_INFO_PATH: string = "/dev/attestation/target_info";
    private readonly USER_REPORT_DATA_PATH: string = "/dev/attestation/user_report_data";
    private readonly QUOTE_PATH: string = "/dev/attestation/quote";

    // Remove unnecessary constructor
    // constructor() {}

    async generateAttestation(
        reportData: string
    ): Promise<SgxAttestation> {
        // Hash the report data to generate the raw user report.
        // The resulting hash value is 32 bytes long.
        // Ensure that the length of the raw user report does not exceed 64 bytes.
        const rawUserReport = calculateSHA256(reportData);

        try {
            // Check if the gramine attestation device file exists
            await fs.access(this.MY_TARGET_INFO_PATH);

            const quote = await this.generateQuoteByGramine(rawUserReport);
            const attestation: SgxAttestation = {
                quote: quote,
                timestamp: Date.now(),
            };
            // console.log("SGX remote attestation: ", attestation);
            return attestation;
        } catch (error) {
            console.error("Error generating SGX remote attestation:", error);
            throw new Error(
                `Failed to generate SGX Quote: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    }

    async generateQuoteByGramine(
        rawUserReport: Buffer
    ): Promise<string> {
        if (rawUserReport.length > 64) {
            throw new Error("the length of rawUserReport exceeds 64 bytes");
        }

        const myTargetInfo = await fs.readFile(this.MY_TARGET_INFO_PATH);
        if (myTargetInfo.length !== this.SGX_TARGET_INFO_SIZE) {
            throw new Error("Invalid my_target_info length");
        }

        await fs.writeFile(this.TARGET_INFO_PATH, myTargetInfo);
        await fs.writeFile(this.USER_REPORT_DATA_PATH, rawUserReport);

        // Read quote
        const quoteData = await fs.readFile(this.QUOTE_PATH);
        if (quoteData.length > this.SGX_QUOTE_MAX_SIZE) {
            throw new Error("Invalid quote length");
        }

        const realLen = quoteData.lastIndexOf(0);
        if (realLen === -1) {
            throw new Error("quote without EOF");
        }

        //return '0x' + quoteData.subarray(0, realLen + 1).toString('hex');
        return `0x${quoteData.subarray(0, realLen + 1).toString('hex')}`; // Fix: Use template literal
    }
}

const sgxAttestationProvider: Provider = {
    get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
        const provider = new SgxAttestationProvider();
        const agentId = runtime.agentId;

        try {
            // console.log("Generating attestation for agent: ", agentId);
            const attestation = await provider.generateAttestation(agentId);
            return `Your Agent's remote attestation is: ${JSON.stringify(attestation)}`;
        } catch (error) {
            console.error("Error in remote attestation provider:", error);
            throw new Error(
                `Failed to generate SGX Quote: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    },
};

export { sgxAttestationProvider, SgxAttestationProvider };
