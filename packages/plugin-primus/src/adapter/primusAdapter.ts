import {
    type IVerifiableInferenceAdapter,
    type VerifiableInferenceOptions,
    type VerifiableInferenceResult,
    VerifiableInferenceProvider,
    ModelProviderName,
    models,
    elizaLogger,
} from "@elizaos/core";
import {generateProof, verifyProof} from "../util/primusUtil.ts";

interface PrimusOptions {
    appId: string;
    appSecret: string;
    attMode: string;
    modelProvider?: ModelProviderName;
    token?: string;
}

export class PrimusAdapter implements IVerifiableInferenceAdapter {
    public options: PrimusOptions;

    constructor(options: PrimusOptions) {
        this.options = options;
    }

    async generateText(
        context: string,
        modelClass: string,
        options?: VerifiableInferenceOptions
    ): Promise<VerifiableInferenceResult> {
        const provider = this.options.modelProvider || ModelProviderName.OPENAI;
        const baseEndpoint = options?.endpoint || models[provider].endpoint;
        const model = models[provider].model[modelClass];
        const apiKey = this.options.token;

        if (!apiKey) {
            throw new Error(
                `API key (token) is required for provider: ${provider}`
            );
        }

        // Get provider-specific endpoint, auth header and response json path
        let endpoint: string;
        let authHeader: string;
        let responseParsePath: string;

        switch (provider) {
            case ModelProviderName.OPENAI:
                endpoint = `${baseEndpoint}/chat/completions`;
                authHeader = `Bearer ${apiKey}`;
                responseParsePath = "$.choices[0].message.content";
                break;
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }


        const headers = {
            "Content-Type": "application/json",
            "Authorization": authHeader,
        };

        try {
            const body = {
                model: model.name,
                messages: [{ role: "user", content: context }],
                temperature:
                    options?.providerOptions?.temperature ||
                    models[provider].model[modelClass].temperature,
            };
            const attestation = await generateProof(endpoint,"POST",headers,JSON.stringify(body),responseParsePath);
            elizaLogger.log("model attestation:", attestation);

            const responseData = JSON.parse(attestation.data);
            const text = JSON.parse(responseData.content);
            return {
                text,
                proof: attestation,
                provider: VerifiableInferenceProvider.PRIMUS,
                timestamp: Date.now(),
            };
        } catch (error) {
            console.error("Error in Primus generateText:", error);
            throw error;
        }
    }

    async verifyProof(result: VerifiableInferenceResult): Promise<boolean> {
        const isValid = verifyProof(result.proof)
        elizaLogger.log("Proof is valid:", isValid);
        return isValid;
    }
}

export default PrimusAdapter;
