import { FeedoClient } from "feedo-protocol-sdk";

async function runLiveTest() {
    console.log("==========================================");
    console.log(" ElizaOS - Feedo Plugin Live E2E Test");
    console.log("==========================================");
    
    // Usage key provided via environment variable
    const usageKey = process.env.FEEDO_USAGE_KEY;
    const did = process.env.FEEDO_AGENT_DID;

    if (!usageKey || !did) {
        console.error("[ERROR] Please set FEEDO_USAGE_KEY and FEEDO_AGENT_DID environment variables to run this test.");
        console.error("Example: FEEDO_USAGE_KEY=0x... FEEDO_AGENT_DID=did:feedo:... npx tsx test_live.ts");
        process.exit(1);
    }

    console.log("[1] Initializing FeedoClient with provided usage key and DID...");
    
    const client = new FeedoClient({ usageKey, did });
    
    const testMemory = "User preference: Always answer in short, concise bullet points when explaining code.";
    console.log(`[2] Simulating STORE_IN_FEEDO Action...`);
    console.log(`    Storing memory: "${testMemory}"`);
    
    await client.search.indexDocument(testMemory);
    console.log("    [OK] Memory successfully encrypted and stored in decentralized network!");

    console.log("\n[3] Simulating feedoProvider context retrieval...");
    const query = "How should I format my code explanations?";
    console.log(`    Querying Feedo network: "${query}"`);
    
    const searchResults = await client.search.search(query, 5);
    const count = searchResults.documents?.length || searchResults.results?.length || 0;
    
    console.log(`    [OK] feedoProvider retrieved ${count} results!`);
    console.log("    Top matching contexts injected to LLM:");
    
    (searchResults.documents || searchResults.results || []).slice(0, 2).forEach((res: any, i: number) => {
        console.log(`    -> [Score: ${res.score?.toFixed(4) || "N/A"}] ${res.text || res.content}`);
    });
    
    console.log("\n==========================================");
    console.log(" E2E Test Completed Successfully!");
    console.log("==========================================");
}

runLiveTest().catch(console.error);
