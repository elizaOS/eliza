import { type IAgentRuntime, type Memory, type Provider, type State, logger } from '@elizaos/core';
import { type TdxQuoteResponse, TappdClient, type TdxQuoteHashAlgorithms } from '@phala/dstack-sdk';
import { type RemoteAttestationQuote, TEEMode, type RemoteAttestationMessage } from '@elizaos/core';

class RemoteAttestationProvider {
    private client: TappdClient;

    constructor(teeMode?: string) {
        let endpoint: string | undefined;

        // Both LOCAL and DOCKER modes use the simulator, just with different endpoints
        switch (teeMode) {
            case TEEMode.LOCAL:
                endpoint = 'http://localhost:8090';
                logger.log('TEE: Connecting to local simulator at localhost:8090');
                break;
            case TEEMode.DOCKER:
                endpoint = 'http://host.docker.internal:8090';
                logger.log('TEE: Connecting to simulator via Docker at host.docker.internal:8090');
                break;
            case TEEMode.PRODUCTION:
                endpoint = undefined;
                logger.log('TEE: Running in production mode without simulator');
                break;
            default:
                throw new Error(
                    `Invalid TEE_MODE: ${teeMode}. Must be one of: LOCAL, DOCKER, PRODUCTION`,
                );
        }

        this.client = endpoint ? new TappdClient(endpoint) : new TappdClient();
    }

    async generateAttestation(
        reportData: string,
        hashAlgorithm?: TdxQuoteHashAlgorithms,
    ): Promise<RemoteAttestationQuote> {
        try {
            logger.log('Generating attestation for: ', reportData);
            const tdxQuote: TdxQuoteResponse = await this.client.tdxQuote(
                reportData,
                hashAlgorithm,
            );
            const rtmrs = tdxQuote.replayRtmrs();
            logger.log(
                `rtmr0: ${rtmrs[0]}\nrtmr1: ${rtmrs[1]}\nrtmr2: ${rtmrs[2]}\nrtmr3: ${rtmrs[3]}f`,
            );
            const quote: RemoteAttestationQuote = {
                quote: tdxQuote.quote,
                timestamp: Date.now(),
            };
            logger.log('Remote attestation quote: ', quote);
            return quote;
        } catch (error) {
            console.error('Error generating remote attestation:', error);
            throw new Error(
                `Failed to generate TDX Quote: ${
                    error instanceof Error ? error.message : 'Unknown error'
                }`,
            );
        }
    }
}

// Keep the original provider for backwards compatibility
const remoteAttestationProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
        const teeMode = runtime.getSetting('TEE_MODE');
        const provider = new RemoteAttestationProvider(teeMode);
        const agentId = runtime.agentId;

        try {
            const attestationMessage: RemoteAttestationMessage = {
                agentId: agentId,
                timestamp: Date.now(),
                message: {
                    userId: message.userId,
                    roomId: message.roomId,
                    content: message.content.text,
                },
            };
            logger.log('Generating attestation for: ', JSON.stringify(attestationMessage));
            const attestation = await provider.generateAttestation(
                JSON.stringify(attestationMessage),
            );
            return `Your Agent's remote attestation is: ${JSON.stringify(attestation)}`;
        } catch (error) {
            console.error('Error in remote attestation provider:', error);
            throw new Error(
                `Failed to generate TDX Quote: ${
                    error instanceof Error ? error.message : 'Unknown error'
                }`,
            );
        }
    },
};

export { remoteAttestationProvider, RemoteAttestationProvider };
