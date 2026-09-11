import { executeMicroSwapAction, IAgentRuntime, Memory } from "../src/index";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

async function runRealTest() {
    console.log("🔥 Starting STRICT ElizaOS Plugin Execution Test...");

    // Read the local funded wallet
    const keyPath = path.join(os.homedir(), ".config", "solana", "id.json");
    const secretKeyString = fs.readFileSync(keyPath, "utf-8");

    const mockRuntime: IAgentRuntime = {
        getSetting: (key: string) => {
            if (key === "SOLANA_PRIVATE_KEY") return secretKeyString;
            if (key === "SOLANA_RPC_URL") return "https://api.devnet.solana.com";
            return undefined;
        }
    };

    const mockMemory: Memory = {
        userId: "test-user",
        content: { text: "Execute a swap on Agent OS" }
    };

    const callback = (response: any) => {
        console.log("\n💬 ElizaOS Agent Response:");
        console.log(`   Text: ${response.text}`);
        if (response.content?.txSignature) {
            console.log(`   🔗 Explorer: https://explorer.solana.com/tx/${response.content.txSignature}?cluster=devnet`);
            
            // Save the signature to a file so we can read it easily
            fs.writeFileSync("devnet_signature.txt", response.content.txSignature);
        }
    };

    console.log("⏳ Firing execution handler (Connecting to Devnet)...");
    await executeMicroSwapAction.handler(mockRuntime, mockMemory, {}, {}, callback);
}

runRealTest().catch(console.error);
