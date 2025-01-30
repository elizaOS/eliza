import type {IAgentRuntime, Memory, Provider, State} from "@elizaos/core";
import {Squid} from "@0xsquid/sdk";
import {ethers} from "ethers";
import {type ChainData, ChainType, type RouteRequest, type RouteResponse, type Token} from "@0xsquid/squid-types";
import {validateSquidRouterConfig} from "../helpers/utils.ts";
import type {ExecuteRoute, TransactionResponses} from "@0xsquid/sdk/dist/types";
import {nativeTokenConstant, type SquidToken} from "../types";

const getSDK = (baseUrl: string, integratorId: string): Squid => {
    const squid = new Squid({
        baseUrl: baseUrl,
        integratorId: integratorId
    });
    return squid;
};

export class SquidRouterProvider {
    private squid: Squid;

    constructor(
        private squidSDKUrl: string,
        private squidIntegratorID: string
    ) {
        this.squid = getSDK(squidSDKUrl,squidIntegratorID);
    }

    async initialize(): Promise<void> {
        if(!this.squid.initialized) {
            await this.squid.init();
        }
    }

    getSquidObject(): Squid {
        return this.squid;
    }

    getChains(): ChainData[] {
        return this.squid.chains;
    }

    getTokens(): Token[] {
        return this.squid.tokens;
    }
    getChain(targetChainName: string): ChainData | undefined {
        const normalizedTarget = targetChainName.toLowerCase();
        const targetChain = this.getChains().find(chain => chain.networkName.toLowerCase() === normalizedTarget);
        //For now only support EVM. Will add Cosmos, Solana in later releases
        if(targetChain.chainType === ChainType.EVM) {
            return targetChain;
        }
    }

    getToken(targetChain: ChainData, targetTokenSymbol: string): SquidToken | undefined {
        const normalizedTargetToken = targetTokenSymbol.toLowerCase();
        if(normalizedTargetToken === targetChain.nativeCurrency.symbol) {
            return {
                address: nativeTokenConstant,
                isNative: true,
                symbol: targetTokenSymbol,
                decimals: targetChain.nativeCurrency.decimals,
                enabled: true
            }
        }
        const targetToken =  this.getTokens().find(token => token.symbol.toLowerCase() === normalizedTargetToken && token.chainId === targetChain.chainId);
        return {
            address: targetToken.address,
            isNative: false,
            symbol: targetTokenSymbol,
            decimals: targetToken.decimals,
            enabled: targetToken.disabled ?? true
        }
    }

    async getRoute(route: RouteRequest): Promise<RouteResponse>{
        return await this.squid.getRoute(route);
    }

    async executeRoute(route: ExecuteRoute): Promise<TransactionResponses>{
        return await this.squid.executeRoute(route);
    }

    async getEVMSignerForChain(chain: ChainData, runtime): Promise<ethers.Signer> {
        try {
            if(chain.chainType === ChainType.EVM) {
                const provider = new ethers.JsonRpcProvider(chain.rpc);
                return new ethers.Wallet(runtime.getSetting("SQUID_EVM_PRIVATE_KEY"), provider);
            }
            throw new Error('Cannot instantiate EVM signer for non-EVM chain'); // Fix: Use template literal and remove else
        } catch (error) {
            throw new Error(`Cannot instantiate EVM signer: ${error}`); // Fix: Use template literal
        }
    }

    // async getEVMSignerForChain(chain: ChainData, runtime): Promise<ethers.Signer> {
    //     try {
    //         if(chain.chainType === ChainType.EVM) {
    //             const provider = new ethers.JsonRpcProvider(chain.rpc);
    //             return new ethers.Wallet(runtime.getSetting("SQUID_EVM_PRIVATE_KEY"), provider);
    //         } else {
    //             throw Error("Cannot instantiate EVM signer for non-EVM chain");
    //         }
    //     } catch (error) {
    //         throw Error("Cannot instantiate EVM signer: "+error);
    //     }
    // }
}

export const initSquidRouterProvider = (runtime: IAgentRuntime) => {
    validateSquidRouterConfig(runtime);

    const sdkUrl = runtime.getSetting("SQUID_SDK_URL");
    const integratorId = runtime.getSetting("SQUID_INTEGRATOR_ID");

    return new SquidRouterProvider(sdkUrl, integratorId);
};

const squidRouterProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string | null> => {
        try {
            /*const provider = */ initSquidRouterProvider(runtime);
            return "Squid Router provider setup successful."
        } catch (error) {
            console.error("Error in Squid Router provider:", error);
            return null;
        }
    },
};

// Module exports
export { squidRouterProvider };
