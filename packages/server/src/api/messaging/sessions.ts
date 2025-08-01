import { logger, validateUuid, type UUID, type IAgentRuntime } from '@elizaos/core';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import internalMessageBus from '../../bus';
import type { AgentServer } from '../../index';

// Session management for simplified messaging
interface Session {
    id: string;
    agentId: UUID;
    channelId: UUID;
    userId: UUID;
    metadata: Record<string, any>;
    createdAt: Date;
    lastActivity: Date;
}

// In-memory session store (consider Redis for production)
const sessions = new Map<string, Session>();
const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

/**
 * Creates a unified sessions router for simplified messaging
 * This abstracts away the complexity of servers/channels for simple use cases
 */
export function createSessionsRouter(
    agents: Map<UUID, IAgentRuntime>,
    serverInstance: AgentServer
): express.Router {
    const router = express.Router();

    /**
     * Create a new messaging session
     * POST /api/messaging/sessions
     */
    router.post('/sessions', async (req, res) => {
        const { agentId, userId, metadata = {} } = req.body;

        if (!validateUuid(agentId) || !validateUuid(userId)) {
            return res.status(400).json({ 
                error: 'Invalid agentId or userId format' 
            });
        }

        const agent = agents.get(agentId as UUID);
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        try {
            // Create a unique session ID
            const sessionId = uuidv4();
            const channelId = uuidv4() as UUID;

            // Create channel in the database
            await serverInstance.createChannel({
                id: channelId,
                name: `session-${sessionId}`,
                type: 'direct',
                messageServerId: DEFAULT_SERVER_ID,
                metadata: {
                    sessionId,
                    agentId,
                    userId,
                    ...metadata
                }
            });

            // Add agent as participant
            await serverInstance.addChannelParticipants(channelId, [agentId as UUID]);

            // Create session
            const session: Session = {
                id: sessionId,
                agentId: agentId as UUID,
                channelId,
                userId: userId as UUID,
                metadata,
                createdAt: new Date(),
                lastActivity: new Date()
            };

            sessions.set(sessionId, session);

            res.json({
                sessionId,
                agentId,
                userId,
                createdAt: session.createdAt,
                metadata
            });

        } catch (error) {
            logger.error('[Sessions API] Error creating session:', error);
            res.status(500).json({ error: 'Failed to create session' });
        }
    });

    /**
     * Get session details
     * GET /api/messaging/sessions/:sessionId
     */
    router.get('/sessions/:sessionId', async (req, res) => {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json({
            sessionId: session.id,
            agentId: session.agentId,
            userId: session.userId,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
            metadata: session.metadata
        });
    });

    /**
     * Send a message in a session
     * POST /api/messaging/sessions/:sessionId/messages
     */
    router.post('/sessions/:sessionId/messages', async (req, res) => {
        const { sessionId } = req.params;
        const { content, attachments, metadata = {} } = req.body;

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: 'Content is required' });
        }

        try {
            // Update session activity
            session.lastActivity = new Date();

            // Create message in database
            const message = await serverInstance.createMessage({
                channelId: session.channelId,
                authorId: session.userId,
                content,
                rawMessage: { content, attachments },
                sourceType: 'user',
                metadata: {
                    sessionId,
                    ...metadata
                }
            });

            // Broadcast to agents via internal bus
            const messageForBus = {
                id: message.id,
                channel_id: session.channelId,
                server_id: DEFAULT_SERVER_ID,
                author_id: session.userId,
                content,
                created_at: message.createdAt.getTime(),
                source_type: 'user',
                raw_message: { content, attachments },
                metadata: {
                    sessionId,
                    ...metadata
                }
            };

            internalMessageBus.emit('central_new_message', messageForBus);

            res.json({
                id: message.id,
                content: message.content,
                authorId: message.authorId,
                createdAt: message.createdAt,
                metadata: message.metadata
            });

        } catch (error) {
            logger.error('[Sessions API] Error sending message:', error);
            res.status(500).json({ error: 'Failed to send message' });
        }
    });

    /**
     * Get messages from a session
     * GET /api/messaging/sessions/:sessionId/messages
     */
    router.get('/sessions/:sessionId/messages', async (req, res) => {
        const { sessionId } = req.params;
        const { limit = 50, before, after } = req.query;

        const session = sessions.get(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        try {
            // Parse query parameters
            const messageLimit = Math.min(parseInt(limit as string) || 50, 100);
            const beforeDate = before ? new Date(parseInt(before as string)) : undefined;
            const afterDate = after ? new Date(parseInt(after as string)) : undefined;

            // Get messages from the channel
            const messages = await serverInstance.getMessagesForChannel(
                session.channelId,
                messageLimit,
                beforeDate || afterDate
            );

            // Filter messages based on after parameter if provided
            const filteredMessages = afterDate 
                ? messages.filter(msg => msg.createdAt > afterDate)
                : messages;

            // Transform to simplified format
            const simplifiedMessages = filteredMessages.map((msg) => {
                const rawMessage = typeof msg.rawMessage === 'string' 
                    ? JSON.parse(msg.rawMessage) 
                    : msg.rawMessage;

                return {
                    id: msg.id,
                    content: msg.content,
                    authorId: msg.authorId,
                    isAgent: msg.sourceType === 'agent_response',
                    createdAt: msg.createdAt,
                    metadata: {
                        ...msg.metadata,
                        thought: rawMessage?.thought,
                        actions: rawMessage?.actions
                    }
                };
            });

            res.json({
                messages: simplifiedMessages,
                hasMore: simplifiedMessages.length === messageLimit
            });

        } catch (error) {
            logger.error('[Sessions API] Error fetching messages:', error);
            res.status(500).json({ error: 'Failed to fetch messages' });
        }
    });

    /**
     * Delete a session
     * DELETE /api/messaging/sessions/:sessionId
     */
    router.delete('/sessions/:sessionId', async (req, res) => {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        try {
            // Remove session from memory
            sessions.delete(sessionId);

            // Optionally, you could also delete the channel and messages
            // await serverInstance.deleteChannel(session.channelId);

            res.json({ success: true });

        } catch (error) {
            logger.error('[Sessions API] Error deleting session:', error);
            res.status(500).json({ error: 'Failed to delete session' });
        }
    });

    /**
     * List active sessions (admin endpoint)
     * GET /api/messaging/sessions
     */
    router.get('/sessions', async (_req, res) => {
        const activeSessions = Array.from(sessions.values()).map(session => ({
            sessionId: session.id,
            agentId: session.agentId,
            userId: session.userId,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
            metadata: session.metadata
        }));

        res.json({
            sessions: activeSessions,
            total: activeSessions.length
        });
    });

    /**
     * Health check
     * GET /api/messaging/sessions/health
     */
    router.get('/sessions/health', (_req, res) => {
        res.json({
            status: 'healthy',
            activeSessions: sessions.size,
            timestamp: new Date().toISOString()
        });
    });

    // Cleanup old sessions periodically (every 5 minutes)
    setInterval(() => {
        const now = new Date();
        const sessionTimeout = 30 * 60 * 1000; // 30 minutes

        for (const [sessionId, session] of sessions.entries()) {
            if (now.getTime() - session.lastActivity.getTime() > sessionTimeout) {
                sessions.delete(sessionId);
                logger.info(`[Sessions API] Cleaned up inactive session: ${sessionId}`);
            }
        }
    }, 5 * 60 * 1000);

    return router;
}