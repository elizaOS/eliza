import { IAgentRuntime, Route, UUID, ChannelType, SOCKET_MESSAGE_TYPE } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { io } from 'socket.io-client';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000';

interface TestRequest {
  testType: string;
  clientId: string;
  message: string;
  baseUrl: string;
}

export const testRoute: Route = {
  type: 'POST',
  name: 'Action Bench Test Runner',
  path: '/action-bench/test',
  
  handler: async (req: any, res: any, runtime: IAgentRuntime) => {
    console.log('='.repeat(50));
    console.log('🚀 ACTION BENCH TEST ROUTE CALLED');
    console.log('='.repeat(50));
    
    try {
      // Parse request body
      const { testType, clientId, message, baseUrl }: TestRequest = req.body || {};
      
      console.log('📦 Test Request:', { testType, clientId, message, baseUrl });
      
      if (!testType) {
        throw new Error('testType is required');
      }
      
      // Generate client ID if not provided
      const userId = (clientId || uuidv4()) as UUID;
      const agentId = runtime.agentId;
      
      console.log('👤 User ID:', userId);
      console.log('🤖 Agent ID:', agentId);
      
      // Step 1: Create a new DM channel for this test
      console.log('🔗 Step 1: Creating new DM channel...');
      const channelId = await createTestChannel(userId, agentId, testType, baseUrl);
      
      // Step 2: Determine message based on test type
      const testMessage = message || getTestMessage(testType);
      console.log('📝 Test message:', testMessage);
      
      // Step 3: Send message via Socket.IO (like original frontend implementation)
      console.log('📨 Step 3: Sending message via Socket.IO...');
      const messageResult = await sendSocketMessage(runtime, testMessage, testType, userId, channelId, baseUrl);
      
      console.log('✅ Test completed successfully');
      
      // Send success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: messageResult.agentResponse 
          ? 'Test executed successfully - Agent responded!' 
          : 'Test executed successfully - Message sent!',
        data: {
          testType,
          channelId,
          userId,
          messageId: messageResult.messageId,
          agentResponse: messageResult.agentResponse,
          timestamp: new Date().toISOString()
        }
      }));
      
    } catch (error) {
      console.error('❌ Test execution failed:', error);
      
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      }));
    }
  }
};

/**
 * Create a test channel for the benchmark
 */
async function createTestChannel(userId: UUID, agentId: UUID, testType: string, baseUrl?: string): Promise<UUID> {
  try {
    const channelPayload = {
      name: `Action Bench Test - ${testType}`.trim(),
      server_id: DEFAULT_SERVER_ID,
      participantCentralUserIds: [userId, agentId],
      type: ChannelType.DM,
      metadata: {
        isDm: true,
        user1: userId,
        user2: agentId,
        forAgent: agentId,
        createdAt: new Date().toISOString(),
        createdByPlugin: 'action-bench',
        testType: testType,
      }
    };

    // Use the base URL passed from frontend (from window.location.origin)
    // This is much cleaner and more reliable than trying to detect from headers
    const serverUrl = baseUrl || 'http://localhost:3000'; // Fallback if not provided
    
    console.log('🌐 Using base URL for channel creation:', serverUrl, 
               baseUrl ? '(from frontend)' : '(fallback)');
    const response = await fetch(`${serverUrl}/api/messaging/central-channels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(channelPayload)
    });

    if (!response.ok) {
      throw new Error(`Failed to create channel: ${response.statusText}`);
    }

    const channel = await response.json();
    console.log('✅ Created new channel:', JSON.stringify(channel, null, 2));
    return (channel as any).data.id as UUID;
    
  } catch (error) {
    console.error('❌ Failed to create channel:', error);
    throw error;
  }
}

  // TODO: Replace hardcoded messages with LLM-generated test messages
function getTestMessage(testType: string): string {
  switch (testType) {
    case 'typing-test':
      return 'Hello! Please type "hello dog" to start the typing benchmark test.';
    case 'conversation-test':
      return 'Hello! How are you today? This is a conversation benchmark test.';
    default:
      return `Hello! This is a ${testType} benchmark test.`;
  }
}

/**
 * Send message via Socket.IO (replicating the original frontend logic)
 */
async function sendSocketMessage(
  runtime: IAgentRuntime,
  message: string, 
  testType: string, 
  clientId: UUID, 
  channelId: UUID,
  baseUrl: string,
): Promise<{ messageId: UUID; agentResponse?: string }> {
  return new Promise<{ messageId: UUID; agentResponse?: string }>((resolve, reject) => {
    try {
      const serverUrl = baseUrl;
      console.log('🔌 Connecting to Socket.IO server:', serverUrl);
      
      const socket = io(serverUrl, {
        autoConnect: true,
        reconnection: true,
      });

      socket.on('connect', async () => {
        console.log('✅ Socket connected:', socket.id);
        
        try {
          const messageId = uuidv4();
          console.log('🔗 Joining channel room:', channelId);

          socket.emit('message', {
            type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
            payload: {
              channelId: channelId,
              roomId: channelId,
              entityId: clientId,
            },
          });

          // Listen for messageBroadcast events (both user and agent messages)
          socket.on('messageBroadcast', (data) => {
            const { senderId, senderName, text, channelId: messageChannelId } = data;
            if (
              senderId === runtime.agentId &&
              messageChannelId === channelId
            ) {
              console.log('🤖 Agent response detected!', data);

                if (Array.isArray(data.actions) && data.actions.length > 0) {
                 if (data.actions[0] === 'REPLY') {
                   // Validate if the agent executed the correct action and provided final response
 
                   // TODO: Parse response to check completion status
                   // if (parseXML response.isTestCompleted) {
                   //   socket.disconnect();
                   //   resolve({ messageId: messageId as UUID, agentResponse: data.text });
                   // } 
                 } else {
                   // Collect intermediate actions for step-by-step analysis
                   console.log('📋 Action recorded:', data.actions[0]);
                 }
               }
            }
            
            
          });
        
          setTimeout(() => {
            socket.emit('message', {
              type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
              payload: {
                entityId: clientId,
                senderId: clientId,
                senderName: 'QA',
                message: message,
                channelId: channelId,
                roomId: channelId, // Use channelId as roomId 
                serverId: DEFAULT_SERVER_ID,
                messageId: messageId,
                source: 'action-bench-plugin',
                attachments: [],
                metadata: {
                  testType: testType,
                  timestamp: Date.now()
                },
              },
            });
          }, 500);

          
        } catch (error) {
          console.error('❌ Failed to send message:', error);
          socket.disconnect();
          reject(error);
        }
      });

      socket.on('connect_error', (error) => {
        console.error('❌ Socket connection error:', error);
        reject(new Error(`Socket connection failed: ${error.message}`));
      });

      socket.on('disconnect', (reason) => {
        console.log('🔌 Socket disconnected:', reason);
      });

    } catch (error) {
      console.error('❌ Socket setup error:', error);
      reject(error);
    }
  });
}
