#!/usr/bin/env node

import { io } from 'socket.io-client';
import { SOCKET_MESSAGE_TYPE } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import readline from 'node:readline';

// Get the agent ID from the command line
const agentId = process.argv[2];
const roomId = process.argv[3] || agentId; // Default to agent's own room

if (!agentId) {
  console.error('Please provide an agent ID as a command line argument');
  console.error('Usage: npx tsx src/diagnose-websocket.ts <agentId> [roomId]');
  process.exit(1);
}

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log(`🔍 Starting WebSocket diagnostic for agent ${agentId} in room ${roomId}`);
console.log('===========================================================');

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
      entityId: 'diagnostic-script',
      roomId: roomId,
    },
  };

  console.log('Joining room with payload:', JSON.stringify(joinPayload, null, 2));
  socket.emit('message', joinPayload);
  console.log(`✅ Joined room ${roomId}`);

  // Start the diagnostic menu
  showMenu();
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection error:', error.message);
});

socket.on('disconnect', (reason) => {
  console.log(`❌ Disconnected: ${reason}`);
});

// Handle incoming messages
socket.on('message', (data) => {
  console.log('\n🔔 Received message:');
  console.log(JSON.stringify(data, null, 2));

  if (data.type === SOCKET_MESSAGE_TYPE.SEND_MESSAGE) {
    console.log('\n📝 Text message received:');
    console.log(`- From: ${data.payload.entityId} (${data.payload.userName || 'Unknown'})`);
    console.log(`- Content: "${data.payload.text}"`);
  }

  // Show menu again after receiving a message
  setTimeout(showMenu, 500);
});

// Function to send a message from the diagnostic script
function sendMessage(text) {
  const messagePayload = {
    type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
    payload: {
      messageId: uuidv4(),
      timestamp: new Date().toISOString(),
      text: text,
      entityId: 'diagnostic-script',
      roomId: roomId,
      userName: 'Diagnostic Script',
    },
  };

  console.log('\nSending message:', JSON.stringify(messagePayload, null, 2));
  socket.emit('message', messagePayload);
  console.log('✅ Message sent');
}

// Function to trigger the agent to send a message via API
async function triggerAgentMessage(text) {
  const url = `http://localhost:3000/agents/${agentId}/messages`;
  const message = text || `Test message from API at ${new Date().toISOString()}`;

  console.log(`\nTriggering agent message via API: ${message}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        roomId: roomId,
        text: message,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Error: ${response.status} ${response.statusText}`);
      console.error(errorText);
      return;
    }

    const data = await response.json();
    console.log('✅ API request successful!');
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('❌ Error triggering agent message:', error.message);
  }
}

// Function to show the diagnostic menu
function showMenu() {
  console.log('\n===========================================================');
  console.log('🔧 WebSocket Diagnostic Menu');
  console.log('===========================================================');
  console.log('1. Send a message from the diagnostic script');
  console.log('2. Trigger the agent to send a message via API');
  console.log('3. Check WebSocket connection status');
  console.log('4. Rejoin the room');
  console.log('5. Exit');
  console.log('===========================================================');

  rl.question('Select an option (1-5): ', (answer) => {
    switch (answer) {
      case '1':
        rl.question('Enter message text: ', (text) => {
          sendMessage(text);
          setTimeout(showMenu, 500);
        });
        break;
      case '2':
        rl.question('Enter message text (or press Enter for default): ', (text) => {
          triggerAgentMessage(text || null);
          setTimeout(showMenu, 1000);
        });
        break;
      case '3':
        console.log(
          `\nWebSocket connection status: ${socket.connected ? 'Connected ✅' : 'Disconnected ❌'}`
        );
        console.log(`Socket ID: ${socket.id || 'None'}`);
        console.log(`Room ID: ${roomId}`);
        setTimeout(showMenu, 500);
        break;
      case '4':
        const joinPayload = {
          type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
          payload: {
            entityId: 'diagnostic-script',
            roomId: roomId,
          },
        };
        console.log('\nRejoining room with payload:', JSON.stringify(joinPayload, null, 2));
        socket.emit('message', joinPayload);
        console.log(`✅ Rejoined room ${roomId}`);
        setTimeout(showMenu, 500);
        break;
      case '5':
        console.log('\nDisconnecting from WebSocket server...');
        socket.disconnect();
        rl.close();
        process.exit(0);
        break;
      default:
        console.log('\nInvalid option. Please try again.');
        setTimeout(showMenu, 500);
        break;
    }
  });
}

// Listen for ctrl+c
process.on('SIGINT', () => {
  console.log('\nDisconnecting from WebSocket server...');
  socket.disconnect();
  rl.close();
  process.exit(0);
});
