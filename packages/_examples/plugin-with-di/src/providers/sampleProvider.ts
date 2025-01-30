import { inject, injectable } from "inversify";
import {
    type Provider,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { globalContainer, type InjectableProvider } from "@elizaos/plugin-di";

// Dynamic Data Provider

globalContainer
    .bind<Record<string, string>>("DYNAMIC_DATA")
    .toDynamicValue(async () => {
        return Promise.resolve({ key: "value" });
    });

/**
 * Sample Provider
 */
@injectable()
export class SampleProvider
    implements InjectableProvider<Record<string, string>>, Provider
{
    private _sharedInstance: Record<string, string>;

    private dynamicData: Record<string, string>;

    constructor(dynamicData: Record<string, string>) {
        this.dynamicData = dynamicData;
    }

    // ---- Implementing the InjectableProvider interface ----

    async getInstance(
        _runtime: IAgentRuntime
    ): Promise<Record<string, string>> {
        if (!this._sharedInstance) {
            this._sharedInstance = {};
        }
        return this._sharedInstance;
    }

    // ---- Implementing the Provider interface ----

    async get(
        _runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string> {
        elizaLogger.log("Retrieving data in sampleProvider...");
        return `Shared instance data: ${JSON.stringify(this._sharedInstance)}
Dynamic data: ${JSON.stringify(this.dynamicData)}
`;
    }
}

// Register the provider with the global container
globalContainer.bind(SampleProvider).toSelf().inSingletonScope();
