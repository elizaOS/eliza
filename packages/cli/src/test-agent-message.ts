#!/usr/bin/env node

import { logger } from '@elizaos/core';
import fetch from 'node-fetch';

// Get the agent ID from the command line
const agentId = process.argv[2];

if (!agentId) {
  console.error('Please provide an agent ID as a command line argument');
  console.error('Usage: npx tsx src/test-agent-message.ts <agentId>');
  process.exit(1);
}

// Get optional room ID and message text
const roomId = process.argv[3] || agentId; // Default to agent's own room
const messageText = process.argv[4] || `Test message sent at ${new Date().toISOString()}`;

async function sendTestMessage() {
  const port = process.env.PORT || 3000;
  const url = `http://localhost:${port}/agents/${agentId}/test-message`;

  console.log(`Sending test message to agent ${agentId} in room ${roomId}`);
  console.log(`Message: "${messageText}"`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        roomId,
        text: messageText,
      }),
    });

    const data = await response.json();

    if (data.success) {
      console.log('✅ Test message sent successfully!');
      console.log(data.data);
    } else {
      console.error('❌ Failed to send test message:');
      console.error(data.error);
    }
  } catch (error) {
    console.error('❌ Error sending test message:', error.message);
  }
}

// Send the test message
sendTestMessage().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
