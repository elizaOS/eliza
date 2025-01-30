import { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { TdxQuoteResponse, TappdClient } from "@phala/dstack-sdk";
import { RemoteAttestationQuote, TEEMode } from "./types";

class RemoteAttestationProvider {
    private client: TappdClient;

    constructor(teeMode?: string) {
        let endpoint: string | undefined;

        // Both LOCAL and DOCKER modes use the simulator, just with different endpoints
        switch (teeMode) {
            case TEEMode.LOCAL:
                endpoint = "http://localhost:8090";
                console.log(
                    "TEE: Connecting to local simulator at localhost:8090"
                );
                break;
            case TEEMode.DOCKER:
                endpoint = "http://host.docker.internal:8090";
                console.log(
                    "TEE: Connecting to simulator via Docker at host.docker.internal:8090"
                );
                break;
            case TEEMode.PRODUCTION:
                endpoint = undefined;
                console.log(
                    "TEE: Running in production mode without simulator"
                );
                break;
            default:
                throw new Error(
                    `Invalid TEE_MODE: ${teeMode}. Must be one of: LOCAL, DOCKER, PRODUCTION`
                );
        }

        this.client = endpoint ? new TappdClient(endpoint) : new TappdClient();
    }

    async generateAttestation(
        reportData: string
    ): Promise<RemoteAttestationQuote> {
        try {
            console.log("Generating attestation for: ", reportData);
            const tdxQuote: TdxQuoteResponse =
                await this.client.tdxQuote(reportData);
            const rtmrs = tdxQuote.replayRtmrs();
            console.log(
                `rtmr0: ${rtmrs[0]}\nrtmr1: ${rtmrs[1]}\nrtmr2: ${rtmrs[2]}\nrtmr3: ${rtmrs[3]}f`
            );
            const quote: RemoteAttestationQuote = {
                quote: tdxQuote.quote,
                timestamp: Date.now(),
            };
            console.log("Remote attestation quote: ", quote);
            return quote;
        } catch (error) {
            console.error("Error generating remote attestation:", error);
            throw new Error(
                `Failed to generate TDX Quote: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    }
}

// Keep the original provider for backwards compatibility
const remoteAttestationProvider: Provider = {
    get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
        const teeMode = runtime.getSetting("TEE_MODE");
        const provider = new RemoteAttestationProvider(teeMode);
        const agentId = runtime.agentId;

        try {
            console.log("Generating attestation for: ", agentId);
            const attestation = await provider.generateAttestation(agentId);
            return `Your Agent's remote attestation is: ${JSON.stringify(attestation)}`;
        } catch (error) {
            console.error("Error in remote attestation provider:", error);
            throw new Error(
                `Failed to generate TDX Quote: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    },
};

export { remoteAttestationProvider, RemoteAttestationProvider };
