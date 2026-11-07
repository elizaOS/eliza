import { WebSocketServer, WebSocket } from "ws";
import { PerplexityAgentBridge } from "../packages/valhalla-brain-api/src/perplexity-bridge";

const PORT = parseInt(process.env.BRIDGE_PORT || "3001", 10);
const wss = new WebSocketServer({ port: PORT });

interface SwarmClient {
  ws: WebSocket;
  wallet: string;
  hasPerpxApi: boolean;
  connectedAt: number;
}

const swarmNodes = new Map<WebSocket, SwarmClient>();
let latestTelemetry: unknown = null;

console.log("=================================================");
console.log(`  VALHALLA SOVEREIGN BRIDGE & SWARM SERVER ON :${PORT} `);
console.log("  Supports Edge Extension Swarm + Perplexity API  ");
console.log("=================================================");

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.action === "NODE_HANDSHAKE") {
        swarmNodes.set(ws, {
          ws,
          wallet: msg.wallet || "ANONYMOUS_OPERATOR",
          hasPerpxApi: !!msg.hasPerpxApi,
          connectedAt: Date.now(),
        });
        console.log(`[SWARM] Node connected: ${msg.wallet} (Total active: ${swarmNodes.size})`);
        ws.send(JSON.stringify({ action: "HANDSHAKE_ACK", status: "CONNECTED", activeSwarmSize: swarmNodes.size }));
      }

      if (msg.action === "BEACON_TELEMETRY") {
        latestTelemetry = msg.payload;
        for (const [clientWs] of swarmNodes) {
          if (clientWs.readyState === WebSocket.OPEN && clientWs !== ws) {
            clientWs.send(JSON.stringify({ action: "TELEMETRY_BROADCAST", payload: latestTelemetry }));
          }
        }
      }

      if (msg.action === "TASK_COMPLETE") {
        console.log(`[SWARM TASK COMPLETE] Task ID: ${msg.taskId} | Characters received: ${msg.content?.length || 0}`);
      }

      if (msg.action === "REQUEST_AGENT_SEARCH") {
        const perpxKey = process.env.PERPLEXITY_API_KEY || msg.perpxKey || "";
        if (!perpxKey) {
          ws.send(JSON.stringify({ action: "AGENT_SEARCH_RESULT", error: "No PERPLEXITY_API_KEY set" }));
          return;
        }
        const bridge = new PerplexityAgentBridge(perpxKey);
        const answer = await bridge.queryAgent(msg.prompt || "Solana market overview", { searchType: "fast" });
        ws.send(JSON.stringify({ action: "AGENT_SEARCH_RESULT", reply: answer, taskId: msg.taskId }));
      }
    } catch (err: any) {
      console.error("[BRIDGE MESSAGE ERROR]", err.message);
    }
  });

  ws.on("close", () => {
    swarmNodes.delete(ws);
  });
});
