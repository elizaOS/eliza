#!/usr/bin/env node

import { io } from 'socket.io-client';
import { SOCKET_MESSAGE_TYPE } from '@elizaos/core';

// Get the agent ID and room ID from the command line
const agentId = process.argv[2];
const roomId = process.argv[3] || agentId; // Default to agent's own room

if (!agentId) {
  console.error('Please provide an agent ID as a command line argument');
  console.error('Usage: npx tsx src/test-websocket.ts <agentId> [roomId]');
  process.exit(1);
}

console.log(`Testing WebSocket connection for agent ${agentId} in room ${roomId}`);

// Connect to the WebSocket server
const socket = io('http://localhost:3000', {
  path: '/socket.io',
  transports: ['websocket'],
  reconnection: true,
});

// Track connect/disconnect events
socket.on('connect', () => {
  console.log(`✅ Connected to WebSocket server with ID: ${socket.id}`);

  // Join the room
  const joinPayload = {
    type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
    payload: {
      entityId: 'test-script-user',
      roomId: roomId,
    },
  };

  console.log('Joining room with payload:', joinPayload);
  socket.emit('message', joinPayload);
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection error:', error.message);
});

socket.on('disconnect', (reason) => {
  console.log(`❌ Disconnected: ${reason}`);
});

// Handle incoming messages
socket.on('message', (data) => {
  console.log('🔔 Received message:');
  console.log(JSON.stringify(data, null, 2));

  if (data.type === SOCKET_MESSAGE_TYPE.SEND_MESSAGE) {
    console.log('📝 Text message received:');
    console.log(`- From: ${data.payload.entityId} (${data.payload.userName || 'Unknown'})`);
    console.log(`- Content: "${data.payload.text}"`);
  }
});

// Listen for ctrl+c
process.on('SIGINT', () => {
  console.log('Disconnecting from WebSocket server...');
  socket.disconnect();
  process.exit(0);
});

console.log('WebSocket listener started. Press Ctrl+C to exit.');
