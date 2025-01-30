import {
    type IVerifiableInferenceAdapter,
    type VerifiableInferenceOptions,
    type VerifiableInferenceResult,
    VerifiableInferenceProvider,
    ModelProviderName,
    models,
    elizaLogger,
} from "@elizaos/core";
import { verifyProof } from "./utils/api";
interface OpacityOptions {
    modelProvider?: ModelProviderName;
    token?: string;
    teamId?: string;
    teamName?: string;
    opacityProverUrl: string;
}

export class OpacityAdapter implements IVerifiableInferenceAdapter {
    public options: OpacityOptions;

    constructor(options: OpacityOptions) {
        this.options = options;
    }

    async generateText(
        context: string,
        modelClass: string,
        options?: VerifiableInferenceOptions
    ): Promise<VerifiableInferenceResult> {
        const provider = this.options.modelProvider || ModelProviderName.OPENAI;
        const baseEndpoint =
            options?.endpoint ||
            `https://gateway.ai.cloudflare.com/v1/${this.options.teamId}/${this.options.teamName}`;
        const model = models[provider].model[modelClass];
        const apiKey = this.options.token;

        elizaLogger.log("Generating text with options:", {
            modelProvider: provider,
            model: modelClass,
        });

        // Get provider-specific endpoint
        let endpoint: string;
        let authHeader: string;

        switch (provider) {
            case ModelProviderName.OPENAI:
                endpoint = `${baseEndpoint}/openai/chat/completions`;
                authHeader = `Bearer ${apiKey}`;
                break;
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }

        try {
            let body: Record<string, unknown>;
            // Handle different API formats
            switch (provider) {
                case ModelProviderName.OPENAI:
                    body = {
                        model: model.name,
                        messages: [
                            {
                                role: "system",
                                content: context,
                            },
                        ],
                        temperature: model.temperature || 0.7,
                        max_tokens: model.maxOutputTokens,
                        frequency_penalty: model.frequency_penalty,
                        presence_penalty: model.presence_penalty,
                    };
                    break;
                default:
                    throw new Error(`Unsupported model provider: ${provider}`);
            }

            elizaLogger.debug("Request body:", JSON.stringify(body, null, 2));
            const requestBody = JSON.stringify(body);
            const requestHeaders = {
                "Content-Type": "application/json",
                Authorization: authHeader,
                ...options?.headers,
            };

            elizaLogger.debug("Making request to Cloudflare with:", {
                endpoint,
                headers: {
                    ...requestHeaders,
                    Authorization: "[REDACTED]",
                },
                body: requestBody,
            });

            // Validate JSON before sending
            try {
                JSON.parse(requestBody); // Verify the JSON is valid
            } catch {
                elizaLogger.error("Invalid JSON body:", body);
                throw new Error("Failed to create valid JSON request body");
            }
            elizaLogger.debug("Request body:", requestBody);
            const cloudflareResponse = await fetch(endpoint, {
                method: "POST",
                headers: requestHeaders,
                body: requestBody,
            });

            if (!cloudflareResponse.ok) {
                const errorText = await cloudflareResponse.text();
                elizaLogger.error("Cloudflare error response:", {
                    status: cloudflareResponse.status,
                    statusText: cloudflareResponse.statusText,
                    error: errorText,
                });
                throw new Error(`Cloudflare request failed: ${errorText}`);
            }

            elizaLogger.debug("Cloudflare response:", {
                status: cloudflareResponse.status,
                statusText: cloudflareResponse.statusText,
                headers: cloudflareResponse.headers,
                type: cloudflareResponse.type,
                url: cloudflareResponse.url,
            });

            const cloudflareLogId =
                cloudflareResponse.headers.get("cf-aig-log-id");
            const cloudflareResponseJson = await cloudflareResponse.json();

            const proof = await this.generateProof(
                this.options.opacityProverUrl,
                cloudflareLogId
            );
            elizaLogger.debug(
                "Proof generated for text generation ID:",
                cloudflareLogId
            );

            // // Extract text based on provider format
            const text = cloudflareResponseJson.choices[0].message.content;
            const timestamp = Date.now();
            return {
                text: text,
                id: cloudflareLogId,
                provider: VerifiableInferenceProvider.OPACITY,
                timestamp: timestamp,
                proof: proof,
            };
        } catch (error) {
            console.error("Error in Opacity generateText:", error);
            throw error;
        }
    }

    async generateProof(baseUrl: string, logId: string) {
        const response = await fetch(`${baseUrl}/api/logs/${logId}`);
        elizaLogger.debug("Fetching proof for log ID:", logId);
        if (!response.ok) {
            throw new Error(`Failed to fetch proof: ${response.statusText}`);
        }
        return await response.json();
    }

    async verifyProof(result: VerifiableInferenceResult): Promise<boolean> {
        const isValid = await verifyProof(
            `${this.options.opacityProverUrl}`,
            result.id,
            result.proof
        );
        console.log("Proof is valid:", isValid.success);
        if (!isValid.success) {
            throw new Error("Proof is invalid");
        }
        return isValid.success;
    }
}

export default OpacityAdapter;
