#!/usr/bin/env node

import { WebSocketService } from './server/socketio/WebSocketService';
import { SOCKET_MESSAGE_TYPE } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { io } from 'socket.io-client';

// Get the agent ID from the command line
const agentId = process.argv[2];
const roomId = process.argv[3] || agentId; // Default to agent's own room
const messageText =
  process.argv[4] || `Test message from direct script at ${new Date().toISOString()}`;

if (!agentId) {
  console.error('Please provide an agent ID as a command line argument');
  console.error('Usage: npx tsx src/trigger-agent-message.ts <agentId> [roomId] [messageText]');
  process.exit(1);
}

async function triggerAgentMessage() {
  console.log(`Triggering message for agent ${agentId} in room ${roomId}`);

  // Create WebSocketService directly
  const webSocketService = new WebSocketService(
    'http://localhost:3000', // Server URL
    agentId, // Use agent ID as entity ID
    roomId
  );

  // Connect to the server
  await webSocketService.connect();
  console.log('✅ Connected to WebSocket server');

  // Create a message directly
  const messageId = uuidv4();
  const message = {
    messageId,
    timestamp: new Date().toISOString(),
    text: messageText,
    entityId: agentId,
    roomId: roomId,
    userName: 'Agent Direct Test',
  };

  console.log('Sending message directly via WebSocketService:', JSON.stringify(message, null, 2));

  try {
    // Send the message to the room
    webSocketService.sendTextMessage({
      entityId: agentId,
      text: messageText,
      roomId: roomId,
      userName: 'Agent Direct Test',
    });

    console.log('✅ Message sent successfully');
  } catch (error) {
    console.error('❌ Error sending message:', error);
  }
}

// Run the function and exit
triggerAgentMessage()
  .then(() => {
    console.log('Done.');
    setTimeout(() => process.exit(0), 1000); // Give time for message to be sent
  })
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
