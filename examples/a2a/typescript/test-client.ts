/**
 * Test client for elizaOS A2A Server
 */

const BASE_URL = process.env.A2A_URL ?? "http://localhost:3000";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runA2ATestClient(baseUrl: string): Promise<void> {
  console.log("🧪 Testing elizaOS A2A Server\n");
  console.log(`   URL: ${baseUrl}\n`);

  // Test 1: Get agent info
  console.log("ℹ️  Getting agent info...");
  const infoResponse = await fetch(`${baseUrl}/`);
  assert(infoResponse.ok, `GET / failed: ${infoResponse.status}`);
  const info = (await infoResponse.json()) as JsonValue;
  assert(isJsonObject(info), "GET / did not return an object");
  const name = info.name;
  const bio = info.bio;
  const agentId = info.agentId;
  const capabilities = info.capabilities;
  assert(typeof name === "string", "GET /: name must be a string");
  assert(typeof bio === "string" || bio === null, "GET /: bio must be string|null");
  assert(typeof agentId === "string", "GET /: agentId must be a string");
  assert(Array.isArray(capabilities), "GET /: capabilities must be an array");

  console.log(`   Name: ${name}`);
  console.log(`   Bio: ${bio ?? ""}`);
  console.log(`   Agent ID: ${agentId}`);
  console.log(
    `   Capabilities: ${capabilities.filter((c) => typeof c === "string").join(", ")}`,
  );
  console.log();

  // Test 2: Health check
  console.log("🏥 Health check...");
  const healthResponse = await fetch(`${baseUrl}/health`);
  assert(healthResponse.ok, `GET /health failed: ${healthResponse.status}`);
  const health = (await healthResponse.json()) as JsonValue;
  assert(isJsonObject(health), "GET /health did not return an object");
  assert(typeof health.status === "string", "GET /health: status must be a string");
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

    const chatResponse = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": "test-agent-001",
      },
      body: JSON.stringify({ message, sessionId }),
    });

    assert(chatResponse.ok, `POST /chat failed: ${chatResponse.status}`);
    const chat = (await chatResponse.json()) as JsonValue;
    assert(isJsonObject(chat), "POST /chat did not return an object");
    assert(typeof chat.response === "string", "POST /chat: response must be a string");
    assert(typeof chat.sessionId === "string", "POST /chat: sessionId must be a string");

    console.log(`   Agent: ${chat.response}`);
    console.log(`   Session: ${chat.sessionId}`);
    console.log();
  }

  // Test 4: Streaming (optional)
  console.log("📡 Testing streaming...");
  console.log("   User: Count from 1 to 5");
  console.log("   Agent: ", { end: "" });

  const streamResponse = await fetch(`${baseUrl}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Count from 1 to 5, one number per line",
      sessionId,
    }),
  });

  assert(streamResponse.ok, `POST /chat/stream failed: ${streamResponse.status}`);
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
          const value = JSON.parse(line.slice(6)) as JsonValue;
          if (isJsonObject(value) && typeof value.text === "string") {
            process.stdout.write(value.text);
          }
        }
      }
    }
  }

  console.log("\n");
  console.log("✅ All tests passed!");
}

if (import.meta.main) {
  runA2ATestClient(BASE_URL).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
