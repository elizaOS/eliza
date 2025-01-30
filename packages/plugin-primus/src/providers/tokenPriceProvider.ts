import {elizaLogger, type IAgentRuntime, type Memory, type Provider, type State} from "@elizaos/core";
import {generateProof, verifyProof} from "../util/primusUtil.ts";

interface PrimusAttestation {
    data: string;
    [key: string]: unknown;
}

const tokenPriceProvider: Provider = {
    // eslint-disable-next-line
    get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
        //get btc price
        const url = `${process.env.BINANCE_API_URL||'https://api.binance.com'}/api/v3/ticker/price?symbol=${process.env.BINANCE_SYMBOL || 'BTCUSDT'}`;
        const method = 'GET';
        const headers = {
            'Accept	': '*/*',
        };
        const attestation = await generateProof(url, method, headers, "", "$.price");
        const valid = await verifyProof(attestation);
        if(!valid){
            throw new Error("Invalid price attestation");
        }
        elizaLogger.info('price attestation:',attestation);
        try{
            const responseData = JSON.parse((attestation as PrimusAttestation).data);
            // const responseData = JSON.parse((attestation as any).data);
            const price = responseData.content;
            return  `
            Get BTC price from Binance:
            BTC: ${price} USDT
            Time: ${new Date().toUTCString()}
            POST by eliza #eliza
            Attested by Primus #primus #zktls
            `
        }catch (error){
            elizaLogger.error('Failed to parse price data:', error);
            throw new Error('Failed to parse price data');
        }
    },
};

export { tokenPriceProvider };
