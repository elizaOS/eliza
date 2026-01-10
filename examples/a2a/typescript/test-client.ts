/**
 * Test client for elizaOS A2A Server
 */

const BASE_URL = process.env.A2A_URL ?? "http://localhost:3000";

async function main(): Promise<void> {
  console.log("🧪 Testing elizaOS A2A Server\n");
  console.log(`   URL: ${BASE_URL}\n`);

  // Test 1: Get agent info
  console.log("ℹ️  Getting agent info...");
  const infoResponse = await fetch(`${BASE_URL}/`);
  const info = await infoResponse.json();
  console.log(`   Name: ${info.name}`);
  console.log(`   Bio: ${info.bio}`);
  console.log(`   Agent ID: ${info.agentId}`);
  console.log(`   Capabilities: ${info.capabilities.join(", ")}`);
  console.log();

  // Test 2: Health check
  console.log("🏥 Health check...");
  const healthResponse = await fetch(`${BASE_URL}/health`);
  const health = await healthResponse.json();
  console.log(`   Status: ${health.status}`);
  console.log();

  // Test 3: Chat with agent
  console.log("💬 Testing chat...");
  const sessionId = `test-session-${Date.now()}`;

  const testMessages = [
    "Hello! I'm another AI agent. What's your name?",
    "Can you help me understand how to integrate with other systems?",
    "Thank you for your help!",
  ];

  for (const message of testMessages) {
    console.log(`   User: ${message}`);

    const chatResponse = await fetch(`${BASE_URL}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": "test-agent-001",
      },
      body: JSON.stringify({ message, sessionId }),
    });

    const chat = await chatResponse.json();
    console.log(`   Agent: ${chat.response}`);
    console.log(`   Session: ${chat.sessionId}`);
    console.log();
  }

  // Test 4: Streaming (optional)
  console.log("📡 Testing streaming...");
  console.log("   User: Count from 1 to 5");
  console.log("   Agent: ", { end: "" });

  const streamResponse = await fetch(`${BASE_URL}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Count from 1 to 5, one number per line",
      sessionId,
    }),
  });

  const reader = streamResponse.body?.getReader();
  const decoder = new TextDecoder();

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.text) {
              process.stdout.write(data.text);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  }

  console.log("\n");
  console.log("✅ All tests passed!");
}

main().catch(console.error);

