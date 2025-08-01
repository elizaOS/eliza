import { logger, validateUuid, type UUID, type IAgentRuntime } from '@elizaos/core';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import internalMessageBus from '../../bus';
import type { AgentServer } from '../../index';

// Map session IDs to channel IDs for easy lookup
const sessionToChannelMap = new Map<string, UUID>();
const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

/**
 * Creates the simple messaging router for Discord Activity integration
 * This uses the existing channel-based polling mechanism
 */
export function createSimpleMessagingRouter(
    agents: Map<UUID, IAgentRuntime>,
    serverInstance: AgentServer
): express.Router {
    const router = express.Router();

    // Get available agents
    router.get('/simple/agents', async (_req, res) => {
        try {
            const agentList = Array.from(agents.entries()).map(([id, runtime]) => ({
                id,
                name: runtime.character.name,
                description: Array.isArray(runtime.character.bio) 
                    ? runtime.character.bio.join(' ') 
                    : runtime.character.bio || '',
                avatar: runtime.character.settings?.avatar || '',
                status: 'online'
            }));

            res.json(agentList);
        } catch (error) {
            logger.error('[Simple API] Error getting agents:', error);
            res.status(500).json({ error: 'Failed to get agents' });
        }
    });

    // Send message to agent (creates a channel if needed)
    router.post('/simple/:agentId/message', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        if (!agentId) {
            return res.status(400).json({ error: 'Invalid agent ID' });
        }

        const { message, sessionId, channelId: providedChannelId, serverId, userId } = req.body;
        
        if (!message || !sessionId || !userId) {
            return res.status(400).json({ 
                error: 'Missing required fields: message, sessionId, userId' 
            });
        }

        const agent = agents.get(agentId);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        try {
            // Use provided channelId or get/create one for this session
            let channelId: UUID;
            
            if (providedChannelId && validateUuid(providedChannelId)) {
                channelId = providedChannelId as UUID;
            } else {
                // Check if we have a channel for this session
                const existingChannelId = sessionToChannelMap.get(sessionId);
                
                if (!existingChannelId) {
                    // Create a new channel ID for this session
                    channelId = uuidv4() as UUID;
                    
                    // Create the channel in the database
                    try {
                        await serverInstance.createChannel({
                            id: channelId,
                            name: `discord-activity-${sessionId}`,
                            serverId: validateUuid(serverId) || DEFAULT_SERVER_ID,
                            type: 'text',
                            metadata: {
                                platform: 'discord_activity',
                                sessionId,
                                agentId,
                                exclusiveAgent: agentId // Mark this channel as exclusive to this agent
                            }
                        }, [agentId]); // Only add this agent as participant
                        
                        sessionToChannelMap.set(sessionId, channelId);
                    } catch (error) {
                        logger.error('[Simple API] Failed to create channel:', error);
                        throw error;
                    }
                } else {
                    channelId = existingChannelId;
                }
            }

            // Create message using the existing channel system
            const messageData = {
                channelId,
                authorId: validateUuid(userId) || userId as UUID,
                content: message,
                sourceType: 'discord_activity',
                metadata: {
                    sessionId,
                    platform: 'discord_activity'
                }
            };

            const createdMessage = await serverInstance.createMessage(messageData);

            // Emit to internal message bus for agent processing
            const messageForBus = {
                id: createdMessage.id!,
                channel_id: channelId,
                server_id: (validateUuid(serverId) || serverId || DEFAULT_SERVER_ID) as UUID,
                author_id: messageData.authorId,
                content: message,
                source_type: 'discord_activity',
                created_at: new Date(createdMessage.createdAt).getTime(),
                metadata: messageData.metadata
            };

            internalMessageBus.emit('new_message', messageForBus);

            res.json({
                success: true,
                messageId: createdMessage.id,
                channelId,
                timestamp: createdMessage.createdAt
            });

        } catch (error) {
            logger.error('[Simple API] Error processing message:', error);
            res.status(500).json({ error: 'Failed to process message' });
        }
    });

    // Get messages for polling - wraps the existing channel messages endpoint
    router.get('/simple/:agentId/messages', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        const { sessionId, channelId: providedChannelId, after } = req.query;

        if (!agentId || !sessionId) {
            return res.status(400).json({ 
                error: 'Missing required parameters: agentId and sessionId' 
            });
        }

        try {
            // Get channel ID for this session
            const channelId = providedChannelId as string || sessionToChannelMap.get(sessionId as string);
            
            if (!channelId || !validateUuid(channelId)) {
                return res.json({ 
                    success: true, 
                    messages: [],
                    channelId: null 
                });
            }

            // Get messages from the channel
            const limit = 50;
            const afterDate = after ? new Date(parseInt(after as string)) : undefined;
            
            const messages = await serverInstance.getMessagesForChannel(
                channelId as UUID, 
                limit, 
                afterDate
            );

            // Transform messages to simple format
            const simpleMessages = messages.map((msg) => {
                const rawMessage = typeof msg.rawMessage === 'string' 
                    ? JSON.parse(msg.rawMessage) 
                    : msg.rawMessage;

                return {
                    id: msg.id,
                    content: msg.content,
                    authorId: msg.authorId,
                    timestamp: new Date(msg.createdAt).getTime(),
                    thought: rawMessage?.thought,
                    actions: rawMessage?.actions,
                    metadata: {
                        ...msg.metadata,
                        isAgentResponse: msg.sourceType === 'agent_response'
                    }
                };
            });

            res.json({
                success: true,
                messages: simpleMessages,
                channelId
            });

        } catch (error) {
            logger.error('[Simple API] Error fetching messages:', error);
            res.status(500).json({ error: 'Failed to fetch messages' });
        }
    });

    // SSE-style stream endpoint that returns a polling instruction instead
    router.get('/simple/:agentId/stream', async (req, res) => {
        const agentId = validateUuid(req.params.agentId);
        const sessionId = req.query.sessionId as string;

        if (!agentId || !sessionId) {
            return res.status(400).json({ 
                error: 'Missing required parameters: agentId and sessionId' 
            });
        }

        // Instead of SSE, return a polling configuration
        res.json({
            type: 'polling',
            pollEndpoint: `/api/messaging/simple/${agentId}/messages?sessionId=${sessionId}`,
            pollInterval: 500,
            message: 'This server uses polling instead of SSE. Please poll the messages endpoint.'
        });
    });

    // Health check endpoint
    router.get('/simple/health', (_req, res) => {
        res.json({
            status: 'ok',
            activeSessions: sessionToChannelMap.size,
            timestamp: new Date().toISOString()
        });
    });

    return router;
}