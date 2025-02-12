import {
    composeContext,
    logger,
    generateMessageResponse,
    generateObject,
    messageCompletionFooter,
    ModelClass,
    stringToUuid,
    type Content,
    type Media,
    type Memory,
    type IAgentRuntime,
    type Character
} from "@elizaos/core";
import bodyParser from "body-parser";
import cors from "cors";
import express, { type Request as ExpressRequest } from "express";

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { createApiRouter } from "./api.ts";
import replyAction from "./reply.ts";
import { messageHandlerTemplate } from "./helper.ts";
import { upload } from "./helper.ts";




export class CharacterServer {
    public app: express.Application;
    private agents: Map<string, IAgentRuntime>; // container management
    private server: any; // Store server instance
    public startAgent: () => Promise<void>; // Store startAgent function
    public loadCharacterTryPath: (characterPath: string) => Promise<Character>; // Store loadCharacterTryPath function
    public jsonToCharacter: (filePath: string, character: string | never) => Promise<Character>; // Store jsonToCharacter function

    constructor() {
        logger.log("DirectClient constructor");
        this.app = express();
        this.app.use(cors());
        this.agents = new Map();

        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));

        // Serve both uploads and generated images
        this.app.use(
            "/media/uploads",
            express.static(path.join(process.cwd(), "/data/uploads"))
        );
        this.app.use(
            "/media/generated",
            express.static(path.join(process.cwd(), "/generatedImages"))
        );

        const apiRouter = createApiRouter(this.agents, this);
        this.app.use(apiRouter);

        // Define an interface that extends the Express Request interface
        interface CustomRequest extends ExpressRequest {
            file?: Express.Multer.File;
        }

        // Update the route handler to use CustomRequest instead of express.Request
        this.app.post(
            "/:agentId/whisper",
            upload.single("file"),
            async (req: CustomRequest, res: express.Response) => {
                const audioFile = req.file; // Access the uploaded file using req.file
                const agentId = req.params.agentId;

                if (!audioFile) {
                    res.status(400).send("No audio file provided");
                    return;
                }

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const transcription = await runtime.useModel(ModelClass.TRANSCRIPTION, fs.createReadStream(audioFile.path));

                res.json(transcription);
            }
        );

        this.app.post(
            "/:agentId/message",
            upload.single("file"),
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const roomId = stringToUuid(
                    req.body.roomId ?? `default-room-${agentId}`
                );
                const userId = stringToUuid(req.body.userId ?? "user");

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const text = req.body.text;
                // if empty text, directly return
                if (!text) {
                    res.json([]);
                    return;
                }

                const messageId = stringToUuid(Date.now().toString());

                const attachments: Media[] = [];
                if (req.file) {
                    const filePath = path.join(
                        process.cwd(),
                        "data",
                        "uploads",
                        req.file.filename
                    );
                    attachments.push({
                        id: Date.now().toString(),
                        url: filePath,
                        title: req.file.originalname,
                        source: "direct",
                        description: `Uploaded file: ${req.file.originalname}`,
                        text: "",
                        contentType: req.file.mimetype,
                    });
                }

                const content: Content = {
                    text,
                    attachments,
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const memory: Memory = {
                    id: stringToUuid(`${messageId}-${userId}`),
                    ...userMessage,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.addEmbeddingToMemory(memory);
                await runtime.messageManager.createMemory(memory);

                let state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.TEXT_LARGE,
                });

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                // save response to memory
                const responseMessage: Memory = {
                    id: stringToUuid(`${messageId}-${runtime.agentId}`),
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(responseMessage);

                state = await runtime.updateRecentMessageState(state);

                const replyHandler = async (message: Content) => {
                    res.json([message]);
                    return [memory];
                }

                await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    replyHandler
                );

                await runtime.evaluate(memory, state);
            }
        );

        this.app.post(
            "/agents/:agentIdOrName/hyperfi/v1",
            async (req: express.Request, res: express.Response) => {
                // get runtime
                const agentId = req.params.agentIdOrName;
                let runtime = this.agents.get(agentId);
                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }
                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                // can we be in more than one hyperfi world at once
                // but you may want the same context is multiple worlds
                // this is more like an instanceId
                const roomId = stringToUuid(req.body.roomId ?? "hyperfi");

                const body = req.body;

                // hyperfi specific parameters
                let nearby = [];
                let availableEmotes = [];

                if (body.nearby) {
                    nearby = body.nearby;
                }
                if (body.messages) {
                    // loop on the messages and record the memories
                    // might want to do this in parallel
                    for (const msg of body.messages) {
                        const parts = msg.split(/:\s*/);
                        const mUserId = stringToUuid(parts[0]);
                        await runtime.ensureConnection(
                            mUserId,
                            roomId, // where
                            parts[0], // username
                            parts[0], // userScreeName?
                            "hyperfi"
                        );
                        const content: Content = {
                            text: parts[1] || "",
                            attachments: [],
                            source: "hyperfi",
                            inReplyTo: undefined,
                        };
                        const memory: Memory = {
                            id: stringToUuid(msg),
                            agentId: runtime.agentId,
                            userId: mUserId,
                            roomId,
                            content,
                        };
                        await runtime.messageManager.createMemory(memory);
                    }
                }
                if (body.availableEmotes) {
                    availableEmotes = body.availableEmotes;
                }

                const content: Content = {
                    // we need to compose who's near and what emotes are available
                    text: JSON.stringify(req.body),
                    attachments: [],
                    source: "hyperfi",
                    inReplyTo: undefined,
                };

                const userId = stringToUuid("hyperfi");
                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                let template = hyperfiHandlerTemplate;
                template = template.replace(
                    "{{emotes}}",
                    availableEmotes.join("|")
                );
                template = template.replace("{{nearby}}", nearby.join("|"));
                const context = composeContext({
                    state,
                    template,
                });

                function createHyperfiOutSchema(
                    nearby: string[],
                    availableEmotes: string[]
                ) {
                    const lookAtSchema =
                        nearby.length > 1
                            ? z
                                  .union(
                                      nearby.map((item) => z.literal(item)) as [
                                          z.ZodLiteral<string>,
                                          z.ZodLiteral<string>,
                                          ...z.ZodLiteral<string>[],
                                      ]
                                  )
                                  .nullable()
                            : nearby.length === 1
                              ? z.literal(nearby[0]).nullable()
                              : z.null(); // Fallback for empty array

                    const emoteSchema =
                        availableEmotes.length > 1
                            ? z
                                  .union(
                                      availableEmotes.map((item) =>
                                          z.literal(item)
                                      ) as [
                                          z.ZodLiteral<string>,
                                          z.ZodLiteral<string>,
                                          ...z.ZodLiteral<string>[],
                                      ]
                                  )
                                  .nullable()
                            : availableEmotes.length === 1
                              ? z.literal(availableEmotes[0]).nullable()
                              : z.null(); // Fallback for empty array

                    return z.object({
                        lookAt: lookAtSchema,
                        emote: emoteSchema,
                        say: z.string().nullable(),
                        actions: z.array(z.string()).nullable(),
                    });
                }

                // Define the schema for the expected output
                const hyperfiOutSchema = createHyperfiOutSchema(
                    nearby,
                    availableEmotes
                );

                // Call LLM
                const response = await generateObject({
                    runtime,
                    context,
                    modelClass: ModelClass.TEXT_SMALL,
                    schema: hyperfiOutSchema,
                });

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                let hfOut;
                try {
                    hfOut = hyperfiOutSchema.parse(response.object);
                } catch {
                    logger.error(
                        "cant serialize response",
                        response.object
                    );
                    res.status(500).send("Error in LLM response, try again");
                    return;
                }

                // do this in the background
                new Promise((resolve) => {
                    const contentObj: Content = {
                        text: hfOut.say,
                    };

                    if (hfOut.lookAt !== null || hfOut.emote !== null) {
                        contentObj.text += ". Then I ";
                        if (hfOut.lookAt !== null) {
                            contentObj.text += `looked at ${hfOut.lookAt}`;
                            if (hfOut.emote !== null) {
                                contentObj.text += " and ";
                            }
                        }
                        if (hfOut.emote !== null) {
                            contentObj.text = "emoted " + hfOut.emote;
                        }
                    }

                    if (hfOut.actions !== null) {
                        // content can only do one action
                        contentObj.action = hfOut.actions[0];
                    }

                    // save response to memory
                    const responseMessage = {
                        ...userMessage,
                        userId: runtime.agentId,
                        content: contentObj,
                    };

                    runtime.messageManager
                        .createMemory(responseMessage)
                        .then(() => {
                            const messageId = stringToUuid(
                                Date.now().toString()
                            );
                            const memory: Memory = {
                                id: messageId,
                                agentId: runtime.agentId,
                                userId,
                                roomId,
                                content,
                                createdAt: Date.now(),
                            };

                            // run evaluators (generally can be done in parallel with processActions)
                            // can an evaluator modify memory? it could but currently doesn't
                            runtime.evaluate(memory, state).then(() => {
                                // only need to call if responseMessage.content.action is set
                                if (contentObj.action) {
                                    // pass memory (query) to any actions to call
                                    runtime.processActions(
                                        memory,
                                        [responseMessage],
                                        state,
                                        async (_newMessages) => {
                                            // FIXME: this is supposed override what the LLM said/decided
                                            // but the promise doesn't make this possible
                                            //message = newMessages;
                                            return [memory];
                                        }
                                    ); // 0.674s
                                }
                                resolve(true);
                            });
                        });
                });
                res.json({ response: hfOut });
            }
        );

        this.app.post(
            "/:agentId/image",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const agent = this.agents.get(agentId);
                if (!agent) {
                    res.status(404).send("Agent not found");
                    return;
                }
                const images = await agent.useModel(ModelClass.IMAGE, { ...req.body });
                const imagesRes: { image: string; caption: string }[] = [];
                if (images.data && images.data.length > 0) {
                    for (let i = 0; i < images.data.length; i++) {
                        const caption = await agent.useModel(ModelClass.IMAGE_DESCRIPTION, images.data[i]);
                        imagesRes.push({
                            image: images.data[i],
                            caption: caption.title,
                        });
                    }
                }
                res.json({ images: imagesRes });
            }
        );

        this.app.post(
            "/fine-tune",
            async (req: express.Request, res: express.Response) => {
                try {
                    const response = await fetch(
                        "https://api.bageldb.ai/api/v1/asset",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                            body: JSON.stringify(req.body),
                        }
                    );

                    const data = await response.json();
                    res.json(data);
                } catch (error) {
                    res.status(500).json({
                        error: "Please create an account at bakery.bagel.net and get an API key. Then set the BAGEL_API_KEY environment variable.",
                        details: error.message,
                    });
                }
            }
        );
        this.app.get(
            "/fine-tune/:assetId",
            async (req: express.Request, res: express.Response) => {
                const assetId = req.params.assetId;
                const downloadDir = path.join(
                    process.cwd(),
                    "downloads",
                    assetId
                );

                logger.log("Download directory:", downloadDir);

                try {
                    logger.log("Creating directory...");
                    await fs.promises.mkdir(downloadDir, { recursive: true });

                    logger.log("Fetching file...");
                    const fileResponse = await fetch(
                        `https://api.bageldb.ai/api/v1/asset/${assetId}/download`,
                        {
                            headers: {
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                        }
                    );

                    if (!fileResponse.ok) {
                        throw new Error(
                            `API responded with status ${fileResponse.status}: ${await fileResponse.text()}`
                        );
                    }

                    logger.log("Response headers:", fileResponse.headers);

                    const fileName =
                        fileResponse.headers
                            .get("content-disposition")
                            ?.split("filename=")[1]
                            ?.replace(/"/g, /* " */ "") || "default_name.txt";

                    logger.log("Saving as:", fileName);

                    const arrayBuffer = await fileResponse.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);

                    const filePath = path.join(downloadDir, fileName);
                    logger.log("Full file path:", filePath);

                    await fs.promises.writeFile(filePath, buffer);

                    // Verify file was written
                    const stats = await fs.promises.stat(filePath);
                    logger.log(
                        "File written successfully. Size:",
                        stats.size,
                        "bytes"
                    );

                    res.json({
                        success: true,
                        message: "Single file downloaded successfully",
                        downloadPath: downloadDir,
                        fileCount: 1,
                        fileName: fileName,
                        fileSize: stats.size,
                    });
                } catch (error) {
                    logger.error("Detailed error:", error);
                    res.status(500).json({
                        error: "Failed to download files from BagelDB",
                        details: error.message,
                        stack: error.stack,
                    });
                }
            }
        );

        this.app.post("/:agentId/speak", async (req, res) => {
            const agentId = req.params.agentId;
            const roomId = stringToUuid(
                req.body.roomId ?? "default-room-" + agentId
            );
            const userId = stringToUuid(req.body.userId ?? "user");
            const text = req.body.text;

            if (!text) {
                res.status(400).send("No text provided");
                return;
            }

            let runtime = this.agents.get(agentId);

            // if runtime is null, look for runtime with the same name
            if (!runtime) {
                runtime = Array.from(this.agents.values()).find(
                    (a) =>
                        a.character.name.toLowerCase() === agentId.toLowerCase()
                );
            }

            if (!runtime) {
                res.status(404).send("Agent not found");
                return;
            }

            try {
                // Process message through agent (same as /message endpoint)
                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const messageId = stringToUuid(Date.now().toString());

                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const memory: Memory = {
                    id: messageId,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(memory);

                const state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.TEXT_LARGE,
                });

                // save response to memory
                const responseMessage = {
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                };

                await runtime.messageManager.createMemory(responseMessage);

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                await runtime.evaluate(memory, state);

                const _result = await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    async () => {
                        return [memory];
                    }
                );

                // Get the text to convert to speech
                const textToSpeak = response.text;

                const speechResponse = await runtime.useModel(ModelClass.TEXT_TO_SPEECH, textToSpeak);

                if (!speechResponse.ok) {
                    throw new Error(
                        `ElevenLabs API error: ${speechResponse.statusText}`
                    );
                }

                const audioBuffer = await speechResponse.arrayBuffer();

                // Set appropriate headers for audio streaming
                res.set({
                    "Content-Type": "audio/mpeg",
                    "Transfer-Encoding": "chunked",
                });

                res.send(Buffer.from(audioBuffer));
            } catch (error) {
                logger.error(
                    "Error processing message or generating speech:",
                    error
                );
                res.status(500).json({
                    error: "Error processing message or generating speech",
                    details: error.message,
                });
            }
        });

        this.app.post("/:agentId/tts", async (req, res) => {
            const text = req.body.text;

            if (!text) {
                res.status(400).send("No text provided");
                return;
            }

            try {
                // Convert to speech using ElevenLabs
                const elevenLabsApiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
                const apiKey = process.env.ELEVENLABS_XI_API_KEY;

                if (!apiKey) {
                    throw new Error("ELEVENLABS_XI_API_KEY not configured");
                }

                // TODO: Replace the process.env with settings from the character read from the database
                    
                const speechResponse = await fetch(elevenLabsApiUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "xi-api-key": apiKey,
                    },
                    body: JSON.stringify({
                        text,
                        model_id:
                            process.env.ELEVENLABS_MODEL_ID ||
                            "eleven_multilingual_v2",
                        voice_settings: {
                            stability: Number.parseFloat(
                                process.env.ELEVENLABS_VOICE_STABILITY || "0.5"
                            ),
                            similarity_boost: Number.parseFloat(
                                process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST ||
                                    "0.9"
                            ),
                            style: Number.parseFloat(
                                process.env.ELEVENLABS_VOICE_STYLE || "0.66"
                            ),
                            use_speaker_boost:
                                process.env
                                    .ELEVENLABS_VOICE_USE_SPEAKER_BOOST ===
                                "true",
                        },
                    }),
                });

                if (!speechResponse.ok) {
                    throw new Error(
                        `ElevenLabs API error: ${speechResponse.statusText}`
                    );
                }

                const audioBuffer = await speechResponse.arrayBuffer();

                res.set({
                    "Content-Type": "audio/mpeg",
                    "Transfer-Encoding": "chunked",
                });

                res.send(Buffer.from(audioBuffer));
            } catch (error) {
                logger.error(
                    "Error processing message or generating speech:",
                    error
                );
                res.status(500).json({
                    error: "Error processing message or generating speech",
                    details: error.message,
                });
            }
        });
    }

    // agent/src/index.ts:startAgent calls this
    public registerAgent(runtime: IAgentRuntime) {
        // register any plugin endpoints?
        // but once and only once
        this.agents.set(runtime.agentId, runtime);
        runtime.registerAction(replyAction);
        // for each route on each plugin, add it to the router
        for (const route of runtime.routes) {
            // if the path hasn't been added yet, add it
            switch (route.type) {
                case "GET":
                    this.app.get(route.path, (req: any, res: any) => route.handler(req, res));
                    break;
                case "POST": 
                    this.app.post(route.path, (req: any, res: any) => route.handler(req, res));
                    break;
                case "PUT":
                    this.app.put(route.path, (req: any, res: any) => route.handler(req, res));
                    break;
                case "DELETE":
                    this.app.delete(route.path, (req: any, res: any) => route.handler(req, res));
                    break;
                default:
                    logger.error(`Unknown route type: ${route.type}`);
            }
        }
    }

    public unregisterAgent(runtime: IAgentRuntime) {
        this.agents.delete(runtime.agentId);
    }

    public start(port: number) {
        this.server = this.app.listen(port, () => {
            logger.success(
                `REST API bound to 0.0.0.0:${port}. If running locally, access it at http://localhost:${port}.`
            );
        });

        // Handle graceful shutdown
        const gracefulShutdown = () => {
            logger.log("Received shutdown signal, closing server...");
            this.server.close(() => {
                logger.success("Server closed successfully");
                process.exit(0);
            });

            // Force close after 5 seconds if server hasn't closed
            setTimeout(() => {
                logger.error(
                    "Could not close connections in time, forcefully shutting down"
                );
                process.exit(1);
            }, 5000);
        };

        // Handle different shutdown signals
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGINT", gracefulShutdown);
    }

    public async stop() {
        if (this.server) {
            this.server.close(() => {
                logger.success("Server stopped");
            });
        }
    }
}