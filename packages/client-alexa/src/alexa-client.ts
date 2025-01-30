import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import { DefaultApiClient } from "ask-sdk-core";
import { services } from "ask-sdk-model";
import axios from "axios";
import { v4 } from "uuid";

export class AlexaClient {
    // private bot: services.proactiveEvents.ProactiveEventsServiceClient; Use for conversations
    private LwaServiceClient: services.LwaServiceClient;
    private apiConfiguration: any;
    private runtime: IAgentRuntime;
    private skillId: string;
    private clientId: string;
    private clientSecret: string;

    constructor(runtime: IAgentRuntime) {
        elizaLogger.log("📱 Constructing new AlexaClient...");
        this.runtime = runtime;
        this.apiConfiguration = {
            apiClient: new DefaultApiClient(),
            apiEndpoint: "https://api.amazonalexa.com",
        };
        this.skillId = runtime.getSetting("ALEXA_SKILL_ID");
        this.clientId = runtime.getSetting("ALEXA_CLIENT_ID");
        this.clientSecret = runtime.getSetting("ALEXA_CLIENT_SECRET");
    }

    public async start(): Promise<void> {
        elizaLogger.log("🚀 Starting Alexa bot...");
        try {
            await this.initializeBot();
        } catch (error) {
            elizaLogger.error("❌ Failed to launch Alexa bot:", error);
            throw error;
        }
    }

    private async initializeBot(): Promise<void> {
        const authenticationConfiguration = {
            clientId: this.clientId,
            clientSecret: this.clientSecret,
        };
        this.LwaServiceClient = new services.LwaServiceClient({
            apiConfiguration: this.apiConfiguration,
            authenticationConfiguration,
        });

        elizaLogger.log("✨ Alexa bot successfully launched and is running!");
        const access_token = await this.LwaServiceClient.getAccessTokenForScope(
            "alexa::proactive_events"
        );

        await this.sendProactiveEvent(access_token);
    }

    async sendProactiveEvent(access_token: string): Promise<void> {
        const event = {
            timestamp: new Date().toISOString(),
            referenceId: v4(),
            expiryTime: new Date(Date.now() + 10 * 60000).toISOString(),
            event: {
                name: "AMAZON.MessageAlert.Activated",
                payload: {
                    state: {
                        status: "UNREAD",
                        freshness: "NEW",
                    },
                    messageGroup: {
                        creator: {
                            name: "Eliza",
                        },
                        count: 1,
                    },
                },
            },
            localizedAttributes: [
                {
                    locale: "en-US",
                    source: "localizedattribute:source",
                },
            ],
            relevantAudience: {
                type: "Multicast",
                payload: {},
            },
        };

        try {
            const response = await axios.post(
                "https://api.amazonalexa.com/v1/proactiveEvents/stages/development",
                event,
                {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${access_token}`,
                    },
                }
            );
            switch (response.status) {
                case 202:
                    elizaLogger.log("✅ Proactive event sent successfully.");
                    break;
                case 400:
                    elizaLogger.error(
                        `${response.data.code} - ${response.data.message}}`
                    );
                    break;
                case 401:
                    elizaLogger.error("Unauthorized");
                    break;
            }
        } catch (error) {
            elizaLogger.error("Error", error);
        }
    }
}
