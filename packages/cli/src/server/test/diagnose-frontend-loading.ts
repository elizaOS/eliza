#!/usr/bin/env node

console.log('🔍 Frontend Loading Diagnostic Tool');
console.log('=====================================\n');

const serverUrl = 'http://localhost:3000';
const agentId = 'b850bc30-45f8-0041-a00a-83df46d8555d'; // Your existing agent

async function testServerConnection() {
  console.log('📡 Testing server connection...');
  try {
    const response = await fetch(`${serverUrl}/api/ping`);
    const data = await response.json();
    console.log(`  ✅ Server responding: ${data.pong ? 'OK' : 'ERROR'}`);
    return true;
  } catch (error) {
    console.log(`  ❌ Server not responding: ${error.message}`);
    return false;
  }
}

async function testAgent() {
  console.log('\n👤 Testing agent availability...');
  try {
    const response = await fetch(`${serverUrl}/api/agents/${agentId}`);
    const data = await response.json();
    if (data.success) {
      console.log(`  ✅ Agent found: ${data.data.name} (Status: ${data.data.status})`);
      return data.data;
    } else {
      console.log(`  ❌ Agent not found: ${data.error}`);
      return null;
    }
  } catch (error) {
    console.log(`  ❌ Error fetching agent: ${error.message}`);
    return null;
  }
}

async function testServers() {
  console.log('\n🌐 Testing central servers...');
  try {
    const response = await fetch(`${serverUrl}/api/messages/central-servers`);
    const data = await response.json();
    if (data.success && data.data.servers.length > 0) {
      console.log(`  ✅ Found ${data.data.servers.length} server(s)`);
      return data.data.servers[0]; // Return first server
    } else {
      console.log(`  ❌ No servers found, creating one...`);
      return await createServer();
    }
  } catch (error) {
    console.log(`  ❌ Error fetching servers: ${error.message}`);
    return null;
  }
}

async function createServer() {
  try {
    const response = await fetch(`${serverUrl}/api/messages/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Diagnostic Test Server',
        sourceType: 'diagnostic',
      }),
    });
    const data = await response.json();
    if (data.success) {
      console.log(`  ✅ Created server: ${data.data.server.id}`);
      return data.data.server;
    } else {
      console.log(`  ❌ Failed to create server: ${data.error}`);
      return null;
    }
  } catch (error) {
    console.log(`  ❌ Error creating server: ${error.message}`);
    return null;
  }
}

async function createDMChannel(serverId) {
  console.log('\n💬 Creating DM channel...');
  const currentUserId = '00000000-0000-0000-0000-000000000001';
  try {
    const response = await fetch(
      `${serverUrl}/api/messages/dm-channel?targetUserId=${agentId}&currentUserId=${currentUserId}&dmServerId=${serverId}`
    );
    const data = await response.json();
    if (data.success) {
      console.log(`  ✅ DM channel created: ${data.data.id}`);
      return data.data;
    } else {
      console.log(`  ❌ Failed to create DM channel: ${data.error}`);
      return null;
    }
  } catch (error) {
    console.log(`  ❌ Error creating DM channel: ${error.message}`);
    return null;
  }
}

function analyzeFrontendProblem(agent, server, channel) {
  console.log('\n🚨 FRONTEND LOADING ISSUE ANALYSIS');
  console.log('===================================\n');

  console.log('📋 Current Route Structure:');
  console.log(`  URL Pattern: /chat/:agentId`);
  console.log(`  Your URL: ${serverUrl}/chat/${agentId}`);
  console.log(`  This provides:`);
  console.log(`    • Path param 'agentId': "${agentId}" ✅`);
  console.log(`    • Search param 'agentId': undefined ❌`);
  console.log(`    • Search param 'serverId': undefined ❌`);
  console.log(`    • Path param 'channelId': undefined ❌\n`);

  console.log('🔍 Component Logic Analysis:');
  console.log('  The Chat component (DMPage) has this check:');
  console.log('  ```typescript');
  console.log('  if (!channelId || !serverId || !targetAgentData) {');
  console.log('    return <p>Loading chat context...</p>;');
  console.log('  }');
  console.log('  ```\n');

  console.log('❌ Why "Loading chat context..." appears:');
  console.log(`  • channelId: undefined (from path params) ❌`);
  console.log(`  • serverId: undefined (from search params) ❌`);
  console.log(`  • targetAgentData: ${agent ? 'loaded' : 'undefined'} ${agent ? '✅' : '❌'}`);
  console.log('  → Result: Condition fails, shows loading forever!\n');

  if (channel) {
    console.log('✅ SOLUTION - Use This Working URL:');
    console.log(`  ${serverUrl}/chat/${channel.id}?agentId=${agentId}&serverId=${server.id}`);
    console.log('  This provides:');
    console.log(`    • channelId: "${channel.id}" ✅`);
    console.log(`    • agentId: "${agentId}" ✅`);
    console.log(`    • serverId: "${server.id}" ✅`);
    console.log('  → All required values present, chat will work!\n');
  }

  console.log('🔧 Alternative Fix - Update Route:');
  console.log('  Change in packages/client/src/App.tsx:');
  console.log('  ```typescript');
  console.log('  // From:');
  console.log('  <Route path="chat/:agentId" element={<Chat />} />');
  console.log('  ');
  console.log('  // To:');
  console.log('  <Route path="chat/:channelId" element={<Chat />} />');
  console.log('  ```');
  console.log('  Then modify Chat component to get agentId differently.');
}

async function runDiagnostic() {
  console.log('Starting diagnostic...\n');

  const serverOk = await testServerConnection();
  if (!serverOk) {
    console.log('\n❌ Cannot proceed - server not responding');
    return;
  }

  const agent = await testAgent();
  if (!agent) {
    console.log('\n❌ Cannot proceed - agent not found');
    return;
  }

  const server = await testServers();
  if (!server) {
    console.log('\n❌ Cannot proceed - no servers available');
    return;
  }

  const channel = await createDMChannel(server.id);

  analyzeFrontendProblem(agent, server, channel);
}

runDiagnostic().catch(console.error);
