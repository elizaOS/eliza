/**
 * Local A2A Server - Standalone implementation for agent development
 *
 * This server provides a complete A2A protocol implementation that works
 * with local anvil and doesn't require the full Feed infrastructure.
 */

import { Database } from "bun:sqlite";
import { createServer } from "node:http";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import express, { type Request, type Response } from "express";
import { WebSocketServer } from "ws";
import { agentCard } from "./agent-card";
import { setupDatabase } from "./database/setup";
import { A2AHandler } from "./handlers/a2a-handler";
import { MarketHandler } from "./handlers/market-handler";
import { PortfolioHandler } from "./handlers/portfolio-handler";
import { SocialHandler } from "./handlers/social-handler";
import { AgentRegistry } from "./services/agent-registry";
import { LocalBlockchain } from "./services/local-blockchain";

dotenv.config();

const PORT = process.env.A2A_PORT || 3001;
const RPC_URL = process.env.RPC_URL || "http://localhost:8545";
const CHAIN_ID = process.env.CHAIN_ID || "31337";

// Initialize database using Bun's native SQLite
const db = new Database("./data/a2a.db", { create: true });
setupDatabase(db);

// Initialize services
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
  staticNetwork: true,
  batchMaxCount: 1,
});
const blockchain = new LocalBlockchain(provider);
const agentRegistry = new AgentRegistry(db, blockchain);

// Initialize handlers
const marketHandler = new MarketHandler(db);
const socialHandler = new SocialHandler(db);
const portfolioHandler = new PortfolioHandler(db, blockchain);
const a2aHandler = new A2AHandler(
  agentRegistry,
  marketHandler,
  socialHandler,
  portfolioHandler,
);

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Agent card endpoint
app.get("/.well-known/agent-card", (_req: Request, res: Response) => {
  res.json(agentCard);
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    agents: agentRegistry.getAgentCount(),
  });
});

// JSON-RPC 2.0 endpoint
app.post("/api/a2a", async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id } = req.body;

  if (jsonrpc !== "2.0") {
    return res.json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request" },
      id,
    });
  }

  // Extract agent info from headers
  const agentId = req.headers["x-agent-id"] as string;
  const agentAddress = req.headers["x-agent-address"] as string;
  const tokenId = req.headers["x-agent-token-id"] as string;

  // Handle method — catch handler errors and return JSON-RPC error instead of crashing
  try {
    const result = await a2aHandler.handleMethod(method, params, {
      agentId,
      address: agentAddress,
      tokenId: parseInt(tokenId || "0", 10),
    });
    res.json({ jsonrpc: "2.0", result, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id,
    });
  }
});

// Create HTTP server
const server = createServer(app);

// Create WebSocket server for real-time updates
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");

  ws.on("message", async (data) => {
    const message = JSON.parse(data.toString());
    const { method, params, id } = message;

    // Handle WebSocket A2A methods
    const result = await a2aHandler.handleMethod(method, params, {
      agentId: message.agentId,
      address: message.address,
      tokenId: message.tokenId,
    });

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        result,
        id,
      }),
    );
  });

  ws.on("close", () => {
    console.log("WebSocket connection closed");
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`
🚀 Local A2A Server Running
============================
HTTP:      http://localhost:${PORT}
WebSocket: ws://localhost:${PORT}/ws
Health:    http://localhost:${PORT}/health
Agent Card: http://localhost:${PORT}/.well-known/agent-card
Chain ID:  ${CHAIN_ID}
RPC URL:   ${RPC_URL}
============================
  `);
});
