import type { Agent, Character, Content, IAgentRuntime, Media, Memory, UUID } from '@elizaos/core';
import { ChannelType, composePrompt, createUniqueUuid, logger, messageHandlerTemplate, ModelTypes, parseJSONObjectFromText, validateUuid } from '@elizaos/core';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentServer } from '..';
import { upload } from '../loader';

interface ApiError {
    code: string;
    message: string;
    details?: unknown;
}

interface CustomRequest extends express.Request {
    file?: Express.Multer.File;
    params: {
        agentId: string;
    };
}

export function agentRouter(
    agents: Map<UUID, IAgentRuntime>,
    server?: AgentServer
): express.Router {
    const router = express.Router();
    const db = server?.database;

    // List all agents
    router.get('/', async (_, res) => {
        logger.debug("[AGENTS LIST] Retrieving list of all agents");
        try {
            const allAgents = await db.getAgents();

            // find running agents
            const runtimes = Array.from(agents.keys());

            // returns minimal agent data
            const response = allAgents.map((agent : Agent) => ({
                id: agent.id,
                name: agent.name,
                status: runtimes.includes(agent.id) ? "active" : "inactive",
                bio: agent.bio[0],
                createdAt: agent.createdAt,
                updatedAt: agent.updatedAt,
            })).sort((a: Agent, b: Agent) => {
                if (a.status === b.status) {
                    return a.name.localeCompare(b.name);
                }
                return a.status === "active" ? -1 : 1;
            });

            res.json({
                success: true,
                data: { agents: response }
            });
        } catch (error) {
            logger.error("[AGENTS LIST] Error retrieving agents:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'FETCH_ERROR',
                    message: 'Error retrieving agents',
                    details: error.message
                }
            });
        }
    });



    // Get specific agent details
    router.get('/:agentId', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        try {
            const agent = await db.getAgent(agentId);
            if (!agent) {
                logger.warn("[AGENT GET] Agent not found");
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Agent not found'
                    }
                });
                return;
            }

            const runtime = agents.get(agentId);

            // check if agent is running
            const status = runtime ? "active" : "inactive";

            res.json({
                success: true,
                data: {...agent, status}
            });
        } catch (error) {
            logger.error("[AGENT GET] Error getting agent:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'FETCH_ERROR',
                    message: 'Error getting agent',
                    details: error.message
                }
            });
        }
    });

    // Create new agent
    router.post('/', async (req, res) => {
        logger.info("[AGENT CREATE] Creating new agent");
        const { characterPath, characterJson } = req.body;
        
        try {
            let character: Character;
            
            if (characterJson) {
                logger.debug("[AGENT CREATE] Parsing character from JSON");
                character = await server?.jsonToCharacter(characterJson);
            } else if (characterPath) {
                logger.debug(`[AGENT CREATE] Loading character from path: ${characterPath}`);
                character = await server?.loadCharacterTryPath(characterPath);
            } else {
                throw new Error("No character configuration provided");
            }

            if (!character) {
                throw new Error("Failed to create character configuration");
            }

            const agent = await server?.startAgent(character);
            
            res.status(201).json({
                success: true,
                data: {
                    id: agent.agentId,
                    character: agent.character,
                }
            });
            logger.success(`[AGENT CREATE] Successfully created agent: ${character.name}`);
        } catch (error) {
            logger.error('[AGENT CREATE] Error creating agent:', error);
            res.status(400).json({
                success: false,
                error: {
                    code: 'CREATE_ERROR',
                    message: 'Error creating agent',
                    details: error.message
                }
            });
        }
    });

    // Update agent
    router.patch('/:agentId', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const updates = req.body;

        try {
            // Handle other updates if any
            if (Object.keys(updates).length > 0) {
                await db.updateAgent(agentId, updates);
            }

            const updatedAgent = await db.getAgent(agentId);
                

            const isActive = !!agents.get(agentId);
            if (isActive) {
                // stop existing runtime
                server?.unregisterAgent(agentId);
                // start new runtime
                await server?.startAgent(updatedAgent);
            }
        
            // check if agent got started successfully
            const runtime = agents.get(agentId);
            const status = runtime ? "active" : "inactive";

            res.json({
                success: true,
                data: {...updatedAgent, status}
            });
        } catch (error) {
            logger.error("[AGENT UPDATE] Error updating agent:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'UPDATE_ERROR',
                    message: 'Error updating agent',
                    details: error.message
                }
            });
        }
    });

    // Stop an existing agent
    router.put('/:agentId', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            logger.warn("[AGENT STOP] Invalid agent ID format");
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        // get agent runtime
        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        // stop existing runtime
        server?.unregisterAgent(agentId);

        // return success
        res.json({
            success: true,
            data: {
                message: 'Agent stopped'
            }
        });
    });

    // Start an existing agent
    router.post('/:agentId', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        try {
            // Check if agent exists
            const agent = await db.getAgent(agentId);
            
            if (!agent) {
                logger.warn("[AGENT START] Agent not found");
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Agent not found'
                    }
                });
                return;
            }

            const isActive = !!agents.get(agentId);

            // Check if agent is already running
            if (isActive) {
                logger.info(`[AGENT START] Agent ${agentId} is already running`);
                res.json({
                    success: true,
                    data: {
                        id: agentId,
                        name: agent.name,
                        status: "active"
                    }
                });
                return;
            }

            // Start the agent
            await server?.startAgent(agent);
            
            // Verify agent started successfully
            const runtime = agents.get(agentId);
            if (!runtime) {
                throw new Error("Failed to start agent");
            }

            logger.success(`[AGENT START] Successfully started agent: ${agent.name}`);
            res.json({
                success: true,
                data: {
                    id: agentId,
                    name: agent.name,
                    status: "active"
                }
            });
        } catch (error) {
            logger.error("[AGENT START] Error starting agent:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'START_ERROR',
                    message: 'Error starting agent',
                    details: error instanceof Error ? error.message : String(error)
                }
            });
        }
    });

    // Delete agent
    router.delete('/:agentId', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        try {
            await db.deleteAgent(agentId);

            const runtime = agents.get(agentId);

            // if agent is running, stop it
            if (runtime) {
                server?.unregisterAgent(agentId);
            }
            res.status(204).send();
        } catch (error) {
            logger.error("[AGENT DELETE] Error deleting agent:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'DELETE_ERROR',
                    message: 'Error deleting agent',
                    details: error.message
                }
            });
        }
    });

    // Messages endpoints
    router.post('/:agentId/messages', async (req: CustomRequest, res) => {
        logger.info("[MESSAGES CREATE] Creating new message");
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        // get runtime
        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        const text = req.body?.text?.trim();
        if (!text) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'Text message is required'
                }
            });
            return;
        }

        const roomId = createUniqueUuid(runtime, req.body.roomId ?? `default-room-${agentId}`);
        const userId = createUniqueUuid(runtime, req.body.userId ?? "user");
        const worldId = req.body.worldId;

        try {
            await runtime.ensureConnection({
                userId,
                roomId,
                userName: req.body.userName,
                userScreenName: req.body.name,
                source: "direct",
                type: ChannelType.API,
                worldId,
            });

            const existingRelationship = await runtime.databaseAdapter.getRelationship({
                sourceEntityId: userId,
                targetEntityId: runtime.agentId,
            });
            
            if (!existingRelationship && userId !== runtime.agentId) {
                await runtime.databaseAdapter.createRelationship({
                    sourceEntityId: userId,
                    targetEntityId: runtime.agentId,
                    tags: ["message_interaction"],
                    metadata: {
                    lastInteraction: Date.now(),
                    channel: "direct"
                    }
                });
            }

            const messageId = createUniqueUuid(runtime, Date.now().toString());
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
                id: createUniqueUuid(runtime, messageId),
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

            const prompt = composePrompt({
                state,
                template: messageHandlerTemplate,
            });

            const responseText = await runtime.useModel(ModelTypes.TEXT_LARGE, {
                prompt,
            });
          
            const response = parseJSONObjectFromText(responseText) as Content;

            if (!response) {
                res.status(500).json({
                    success: false,
                    error: {
                        code: 'MODEL_ERROR',
                        message: 'No response from model'
                    }
                });
                return;
            }

            const responseMessage: Memory = {
                id: createUniqueUuid(runtime, messageId),
                ...userMessage,
                userId: runtime.agentId,
                content: response,
                createdAt: Date.now(),
            };

            await runtime.messageManager.createMemory(responseMessage);
            state = await runtime.updateRecentMessageState(state);

            const replyHandler = async (message: Content) => {
                res.status(201).json({
                    success: true,
                    data: {
                        message,
                        messageId
                    }
                });
                return [memory];
            }

            await runtime.processActions(
                memory,
                [responseMessage],
                state,
                replyHandler
            );

            await runtime.evaluate(memory, state);
            
            res.status(202).json();

        } catch (error) {
            logger.error("Error processing message:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'PROCESSING_ERROR',
                    message: 'Error processing message',
                    details: error.message
                }
            });
        }
    });

    // Audio messages endpoints
    router.post('/:agentId/audio-messages', upload.single('file'), async (req: CustomRequest, res) => {
        logger.info("[AUDIO MESSAGE] Processing audio message");
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const audioFile = req.file;
        if (!audioFile) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'No audio file provided'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        try {
            const audioBuffer = fs.readFileSync(audioFile.path);
            const transcription = await runtime.useModel(ModelTypes.TRANSCRIPTION, audioBuffer);
            
            // Process the transcribed text as a message
            const messageRequest = {
                ...req,
                body: {
                    ...req.body,
                    text: transcription
                }
            };

            // Reuse the message endpoint logic
            await this.post('/:agentId/messages')(messageRequest, res);
        } catch (error) {
            logger.error("[AUDIO MESSAGE] Error processing audio:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'PROCESSING_ERROR',
                    message: 'Error processing audio message',
                    details: error.message
                }
            });
        }
    });

    // Text-to-Speech endpoint
    router.post('/:agentId/audio-messages/synthesize', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const { text } = req.body;
        if (!text) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'Text is required for speech synthesis'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        try {
            const speechResponse = await runtime.useModel(ModelTypes.TEXT_TO_SPEECH, text);
            const audioBuffer = await speechResponse.arrayBuffer();

            res.set({
                'Content-Type': 'audio/mpeg',
                'Transfer-Encoding': 'chunked'
            });

            res.send(Buffer.from(audioBuffer));
        } catch (error) {
            logger.error("[TTS] Error generating speech:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'PROCESSING_ERROR',
                    message: 'Error generating speech',
                    details: error.message
                }
            });
        }
    });


    // Speech-related endpoints
    router.post('/:agentId/speech/generate', async (req, res) => {
        logger.info("[SPEECH GENERATE] Request to generate speech from text");
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const { text } = req.body;
        if (!text) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'Text is required for speech synthesis'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        try {
            logger.info("[SPEECH GENERATE] Using text-to-speech model");
            const speechResponse = await runtime.useModel(ModelTypes.TEXT_TO_SPEECH, text);
            const audioBuffer = await speechResponse.arrayBuffer();

            logger.debug("[SPEECH GENERATE] Setting response headers");
            res.set({
                'Content-Type': 'audio/mpeg',
                'Transfer-Encoding': 'chunked'
            });

            res.send(Buffer.from(audioBuffer));
            logger.success(`[SPEECH GENERATE] Successfully generated speech for: ${runtime.character.name}`);
        } catch (error) {
            logger.error("[SPEECH GENERATE] Error generating speech:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'PROCESSING_ERROR',
                    message: 'Error generating speech',
                    details: error.message
                }
            });
        }
    });

    router.post('/:agentId/speech/conversation', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const { text, roomId: rawRoomId, userId: rawUserId } = req.body;
        if (!text) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'Text is required for conversation'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        try {
            const roomId = createUniqueUuid(runtime, rawRoomId ?? `default-room-${agentId}`);
            const userId = createUniqueUuid(runtime, rawUserId ?? "user");

            logger.debug("[SPEECH CONVERSATION] Ensuring connection");
            await runtime.ensureConnection({
                userId,
                roomId,
                userName: req.body.userName,
                userScreenName: req.body.name,
                source: "direct",
                type: ChannelType.API,
            });

            const messageId = createUniqueUuid(runtime, Date.now().toString());
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

            logger.debug("[SPEECH CONVERSATION] Creating memory");
            await runtime.messageManager.createMemory(memory);

            logger.debug("[SPEECH CONVERSATION] Composing state");
            const state = await runtime.composeState(userMessage, {
                agentName: runtime.character.name,
            });

            logger.debug("[SPEECH CONVERSATION] Creating context");
            const prompt = composePrompt({
                state,
                template: messageHandlerTemplate,
            });

            logger.info("[SPEECH CONVERSATION] Using LLM for response");
            const response = await runtime.useModel(ModelTypes.TEXT_LARGE, {
                messages: [{
                    role: 'system',
                    content: messageHandlerTemplate
                }, {
                    role: 'user',
                    content: prompt
                }]
            });

            if (!response) {
                res.status(500).json({
                    success: false,
                    error: {
                        code: 'MODEL_ERROR',
                        message: 'No response from model'
                    }
                });
                return;
            }

            logger.debug("[SPEECH CONVERSATION] Creating response memory");
            const responseMessage = {
                ...userMessage,
                userId: runtime.agentId,
                content: response,
            };

            await runtime.messageManager.createMemory(responseMessage);
            await runtime.evaluate(memory, state);

            await runtime.processActions(
                memory,
                [responseMessage],
                state,
                async () => [memory]
            );

            logger.info("[SPEECH CONVERSATION] Generating speech response");
            const speechResponse = await runtime.useModel(ModelTypes.TEXT_TO_SPEECH, response.text);
            const audioBuffer = await speechResponse.arrayBuffer();

            logger.debug("[SPEECH CONVERSATION] Setting response headers");
            res.set({
                'Content-Type': 'audio/mpeg',
                'Transfer-Encoding': 'chunked'
            });

            res.send(Buffer.from(audioBuffer));
            logger.success(`[SPEECH CONVERSATION] Successfully processed conversation for: ${runtime.character.name}`);
        } catch (error) {
            logger.error("[SPEECH CONVERSATION] Error processing conversation:", error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'PROCESSING_ERROR',
                    message: 'Error processing conversation',
                    details: error.message
                }
            });
        }
    });

    router.post('/:agentId/transcriptions', upload.single('file'), async (req: CustomRequest, res) => {
        logger.info("[TRANSCRIPTION] Request to transcribe audio");
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const audioFile = req.file;
        if (!audioFile) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_REQUEST',
                    message: 'No audio file provided'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);
        
        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        try {
            logger.debug("[TRANSCRIPTION] Reading audio file");
            const audioBuffer = fs.readFileSync(audioFile.path);
            
            logger.info("[TRANSCRIPTION] Transcribing audio");
            const transcription = await runtime.useModel(ModelTypes.TRANSCRIPTION, audioBuffer);
            
            // Clean up the temporary file
            fs.unlinkSync(audioFile.path);
            
            if (!transcription) {
                res.status(500).json({
                    success: false,
                    error: {
                        code: 'PROCESSING_ERROR',
                        message: 'Failed to transcribe audio'
                    }
                });
                return;
            }

            logger.success("[TRANSCRIPTION] Successfully transcribed audio");
            res.json({
                success: true,
                data: {
                    text: transcription
                }
            });
        } catch (error) {
            logger.error("[TRANSCRIPTION] Error transcribing audio:", error);
            // Clean up the temporary file in case of error
            if (audioFile.path && fs.existsSync(audioFile.path)) {
                fs.unlinkSync(audioFile.path);
            }
            
            res.status(500).json({
                success: false,
                error: {
                    code: 'PROCESSING_ERROR',
                    message: 'Error transcribing audio',
                    details: error.message
                }
            });
        }
    });

    // Rooms endpoints
    router.get('/:agentId/rooms', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        try {
            const worldId = req.query.worldId as string;
            const rooms = await runtime.databaseAdapter.getRoomsForParticipant(agentId);
            
            const roomDetails = await Promise.all(
                rooms.map(async (roomId) => {
                    try {
                        const roomData = await runtime.databaseAdapter.getRoom(roomId);
                        if (!roomData) return null;
                        
                        if (worldId && roomData.worldId !== worldId) {
                            return null;
                        }
                        
                        const entities = await runtime.databaseAdapter.getEntitiesForRoom(roomId, true);
                        
                        return {
                            id: roomId,
                            name: roomData.name || new Date().toLocaleString(),
                            source: roomData.source,
                            worldId: roomData.worldId,
                            entities: entities
                        };
                    } catch (error) {
                        logger.error(`[ROOMS GET] Error getting details for room ${roomId}:`, error);
                        return null;
                    }
                })
            );
            
            const validRooms = roomDetails.filter(room => room !== null);
            
            res.json({
                success: true,
                data: validRooms
            });
        } catch (error) {
            logger.error(`[ROOMS GET] Error retrieving rooms for agent ${agentId}:`, error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'FETCH_ERROR',
                    message: 'Failed to retrieve rooms',
                    details: error.message
                }
            });
        }
    });

    router.post('/:agentId/rooms', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);
        
        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        try {
            const { name, worldId, roomId, userId } = req.body;
            const roomName = name || `Chat ${new Date().toLocaleString()}`;
            
            await runtime.ensureRoomExists({
                id: roomId,
                name: roomName,
                source: "client",
                type: ChannelType.API,
                worldId,
            });
            
            await runtime.databaseAdapter.addParticipant(runtime.agentId, roomName);
            await runtime.ensureParticipantInRoom(userId, roomId);
            await runtime.databaseAdapter.setParticipantUserState(roomId, userId, "FOLLOWED");
            
            res.status(201).json({
                success: true,
                data: {
                    id: roomId,
                    name: roomName,
                    createdAt: Date.now(),
                    source: "client",
                    worldId
                }
            });
        } catch (error) {
            logger.error(`[ROOM CREATE] Error creating room for agent ${agentId}:`, error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'CREATE_ERROR',
                    message: 'Failed to create room',
                    details: error.message
                }
            });
        }
    });

    router.get('/:agentId/rooms/:roomId', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);
        
        const roomId = validateUuid(req.params.roomId);

        if (!agentId || !roomId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID or room ID format'
                }
            });
            return;
        }

        try {
            const room = await runtime.databaseAdapter.getRoom(roomId);
            if (!room) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Room not found'
                    }
                });
                return;
            }

            const entities = await runtime.databaseAdapter.getEntitiesForRoom(roomId, true);
            
            res.json({
                success: true,
                data: {
                    id: roomId,
                    name: room.name,
                    source: room.source,
                    worldId: room.worldId,
                    entities: entities
                }
            });
        } catch (error) {
            logger.error(`[ROOM GET] Error retrieving room ${roomId}:`, error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'FETCH_ERROR',
                    message: 'Failed to retrieve room',
                    details: error.message
                }
            });
        }
    });

    router.patch('/:agentId/rooms/:roomId', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);
        
        const roomId = validateUuid(req.params.roomId);

        if (!agentId || !roomId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID or room ID format'
                }
            });
            return;
        }

        try {
            const room = await runtime.databaseAdapter.getRoom(roomId);
            if (!room) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Room not found'
                    }
                });
                return;
            }

            const updates = req.body;
            await runtime.databaseAdapter.updateRoom({...updates, roomId});

            const updatedRoom = await runtime.databaseAdapter.getRoom(roomId);
            res.json({
                success: true,
                data: updatedRoom
            });
        } catch (error) {
            logger.error(`[ROOM UPDATE] Error updating room ${roomId}:`, error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'UPDATE_ERROR',
                    message: 'Failed to update room',
                    details: error.message
                }
            });
        }
    });

    router.delete('/:agentId/rooms/:roomId', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID format'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);
        
        const roomId = validateUuid(req.params.roomId);

        if (!agentId || !roomId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID or room ID format'
                }
            });
            return;
        }

        try {
            await runtime.databaseAdapter.deleteRoom(roomId);
            res.status(204).send();
        } catch (error) {
            logger.error(`[ROOM DELETE] Error deleting room ${roomId}:`, error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'DELETE_ERROR',
                    message: 'Failed to delete room',
                    details: error.message
                }
            });
        }
    });

    // Get memories for a specific room
    router.get('/:agentId/rooms/:roomId/memories', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        const roomId = validateUuid(req.params.roomId);

        if (!agentId || !roomId) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_ID',
                    message: 'Invalid agent ID or room ID format'
                }
            });
            return;
        }

        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Agent not found'
                }
            });
            return;
        }

        try {
            const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 20;
            const before = req.query.before ? Number.parseInt(req.query.before as string, 10) : Date.now();
            const _worldId = req.query.worldId as string;

            const memories = await runtime.messageManager.getMemories({
                roomId,
                count: limit,
                end: before
            });

            res.json({
                success: true,
                data: {
                    memories
                }
            });
        } catch (error) {
            logger.error('[MEMORIES GET] Error retrieving memories for room:', error);
            res.status(500).json({
                success: false,
                error: {
                    code: 'FETCH_ERROR',
                    message: 'Failed to retrieve memories',
                    details: error.message
                }
            });
        }
    });

    return router;
} 

