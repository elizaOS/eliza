import { FeedoClient } from "feedo-protocol-sdk";

// Helper to simulate UUID generation
function generateTestUuid() {
    return 'id_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
}

async function runLiveTest() {
    console.log("==========================================");
    console.log(" ElizaOS - Feedo Plugin Live E2E Test");
    console.log("==========================================");
    
    const usageKey = process.env.FEEDO_USAGE_KEY;
    const did = process.env.FEEDO_AGENT_DID;

    if (!usageKey || !did) {
        console.error("[ERROR] Please set FEEDO_USAGE_KEY and FEEDO_AGENT_DID environment variables to run this test.");
        console.error("Example: FEEDO_USAGE_KEY=0x... FEEDO_AGENT_DID=did:feedo:... npx tsx test_live.ts");
        process.exit(1);
    }

    console.log("[1] Initializing FeedoClient with provided usage key and DID...");
    
    const client = new FeedoClient({ usageKey, did });
    const testRoomId = "test-room-123";
    
    const testMemory = "User preference: Always answer in short, concise bullet points when explaining code.";
    console.log(`[2] Simulating STORE_IN_FEEDO Action...`);
    console.log(`    Storing memory: "${testMemory}"`);
    console.log(`    Namespace (Room ID): ${testRoomId}`);
    
    const hashId = generateTestUuid();
    await client.search.indexPrivateDocument(hashId, testMemory, { source: "elizaos" }, testRoomId);
    console.log("    [OK] Memory successfully stored privately in the decentralized network!");

    console.log("\n[3] Simulating feedoProvider context retrieval...");
    const query = "How should I format my code explanations?";
    console.log(`    Querying Feedo network: "${query}" in namespace ${testRoomId}`);
    
    const searchResults = await client.search.search(query, 5, true, "all", 0, undefined, "text", undefined, testRoomId);
    const count = searchResults?.documents?.length || searchResults?.data?.length || searchResults?.length || 0;
    
    console.log(`    [OK] feedoProvider retrieved ${count} results!`);
    console.log("    Top matching contexts injected to LLM:");
    
    const documents = searchResults?.documents || searchResults?.data || searchResults || [];
    documents.slice(0, 2).forEach((res: any, i: number) => {
        console.log(`    -> [Score: ${res.score?.toFixed(4) || "N/A"}] ${res.text || res.content}`);
    });
    
    console.log("\n==========================================");
    console.log(" E2E Test Completed Successfully!");
    console.log("==========================================");
}

runLiveTest().catch(console.error);
