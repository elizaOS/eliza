import { Hono } from "hono";
import twilio from "twilio";
import ngrok from "@ngrok/ngrok";
import { Client, elizaLogger, IAgentRuntime, type Plugin, Service, ServiceType, generateText, composeContext, ModelClass } from "@elizaos/core";
import { createAdaptorServer } from "@hono/node-server";
import { validateTwilioConfig } from "./environment";

function getEnvSetting(runtime: IAgentRuntime, key: string) {
    return runtime.getSetting(key) || process.env[key];
}

async function generateResponse(runtime: IAgentRuntime, message: string, roomId: string) {
    // Generate a response to the incoming message using the runtime context
    const template = `Generate a response to the following message: {{message}}.
    The response will either be relayed via SMS or phone call.
    Make sure the response will be concise and relevant to maintain good conversation flow.`;

    const context = composeContext({
        state: await runtime.composeState({
            userId: runtime.agentId,
            // @ts-ignore
            roomId: roomId,
            agentId: runtime.agentId,
            content: {
                text: message
            }
        }, {
            message: message
        }),
        template: template
    });

    return await generateText({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    });
}

function startServer(runtime: IAgentRuntime, listener: ngrok.Listener) {
    const server = new Hono();

    server.post("/message", async (context) => {
        const fromNumber = context.req.param("From");
        const message = context.req.param("Body");

        elizaLogger.log(`Received SMS from ${fromNumber} -> '${message}'`);

        const twiml = new twilio.twiml.MessagingResponse();

        const response = await generateResponse(runtime, message, fromNumber);
        twiml.message(response);

        context.header("Content-Type", "text/xml");
        return context.body(twiml.toString());
    });

    server.get("/generate_speech", async (context) => {
        const speechResponse = context.req.query("text");

        elizaLogger.log(`Responding with '${speechResponse}'`);

        const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${getEnvSetting(runtime, "ELEVENLABS_VOICE_ID")}`);
        url.searchParams.set("optimize_streaming_latency", "4");
        url.searchParams.set("output_format", "ulaw_8000");

        const response = await fetch(url.toString(), {
            headers: {
                "xi-api-key": getEnvSetting(runtime, "ELEVENLABS_XI_API_KEY"),
                "Content-Type": "application/json"
            },
            method: "POST",
            body: JSON.stringify({
                text: speechResponse,
                model_id: getEnvSetting(runtime, "ELEVENLABS_MODEL_ID")
            })
        })

        return new Response(response.body, {
            headers: {
                "Content-Type": "audio/ulaw"
            }
        });
    });

    server.post("/process_speech", async (context) => {
        const fromNumber = context.req.param("From");

        const response = new twilio.twiml.VoiceResponse();
        const transcription = new URLSearchParams(await context.req.text()).get("SpeechResult");

        elizaLogger.log(`User said: '${transcription}'`);

        if (transcription) {
            // const url = new URL(listener.url()!);
            // url.pathname = "/generate_speech";

            const speechResponse = await generateResponse(runtime, transcription, fromNumber);
            // url.searchParams.set("text", speechResponse);

            const url = "/generate_speech?" + new URLSearchParams({
                text: speechResponse
            }).toString();

            console.log(url);

            response.play(url);

            response.redirect("/call")
        } else {
            elizaLogger.error("Failed to process speech");
            response.redirect("/call");
        }

        context.header("Content-Type", "text/xml");
        return context.body(response.toString());
    })

      // Create a route that will handle Twilio webhook requests, sent as an
      // HTTP POST to /voice in our application
    server.post("/call", (context) => {
        elizaLogger.log("Received phone call from ", context.req.param("From"));
        const response = new twilio.twiml.VoiceResponse();

        response.gather({
            input: ["speech"],
            action: "/process_speech",
            speechTimeout: "0",
            // @ts-ignore
            speechModel: "googlev2_telephony"
        })

        context.header("Content-Type", "text/xml");
        return context.body(response.toString());
    })

    ngrok.listen(createAdaptorServer(server), listener);
}

const twilioClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        elizaLogger.log("ATTEMPTING TO START TWILIO CLIENT");

        await validateTwilioConfig(runtime);

        const session = await new ngrok.SessionBuilder().authtoken(getEnvSetting(runtime, "NGROK_AUTHTOKEN")).connect();
        const listener = await session.httpEndpoint().domain(getEnvSetting(runtime, "NGROK_DOMAIN")).listen();

        startServer(runtime, listener);

        elizaLogger.success("Twilio webhook server listening at ", listener.url());
    },
    stop: async (runtime: IAgentRuntime) => {
        elizaLogger.log("Stopping Twilio webhook server");
        await ngrok.disconnect();
        await ngrok.kill();
    },
};


class TwilioService extends Service {
    static serviceType: ServiceType = ServiceType.TEXT_GENERATION;
    async initialize(runtime: IAgentRuntime): Promise<void> {
        twilioClientInterface.start(runtime);
        // If you need the device parameter, you can get it from runtime settings
        // const device = runtime.getSetting("DEVICE_ID");
    }
}

export const twilioPlugin: Plugin = {
    name: "twilio",
    description: "Twilio integration plugin for sending SMS messages",
    actions: [],
    evaluators: [],
    providers: [],
    services: [new TwilioService()]
};

export default twilioPlugin;
