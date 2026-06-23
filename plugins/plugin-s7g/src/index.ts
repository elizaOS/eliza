import { Plugin, Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";

const fetch = globalThis.fetch;
const S7G_API = (typeof process !== 'undefined' && process.env?.S7G_API_URL) || "http://localhost:8080";

class S7GClient {
  private base: string;
  constructor(base: string) { this.base = base; }
  async get(path: string) {
    const r = await fetch(`${this.base}${path}`);
    return r.json();
  }
  async post(path: string, body: any) {
    const r = await fetch(`${this.base}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return r.json();
  }
  async discover() { return this.get("/.well-known/agent.json"); }
  async execute(task: string, params: any = {}, agent: string = "auto") {
    return this.post("/api/agent/execute", { task, parameters: params, agent });
  }
}

const client = new S7GClient(S7G_API);

function makeAction(name: string, desc: string, task: string): Action {
  return {
    name: `S7G_${name}`,
    similes: [name, `${name}_TASK`, `S7G_${name}_NOW`],
    description: desc,
    validate: async () => true,
    handler: async (runtime: IAgentRuntime, message: Memory, state: any, options: any, cb?: HandlerCallback): Promise<any> => {
      try {
        const result = await client.execute(task, (message.content as any)?.parameters || {});
        cb?.({ text: `Result: ${JSON.stringify(result)}`, action: `S7G_${name}`, source: "s7g" });
        return result;
      } catch (e: any) {
        cb?.({ text: `Error: ${e.message}`, action: `S7G_${name}`, source: "s7g" });
        return null;
      }
    },
    examples: [[{ name: "user", content: { text: desc } } as any]],
  };
}

export const s7gPlugin: Plugin = {
  name: "s7g",
  description: "Sovereign 7G Network — 29 agents, DeFi, DePIN, cross-chain, Hyperliquid, Polymarket",
  actions: [
    makeAction("GET_LIQUIDITY", "Get S7G/LUSD pool liquidity status", "get_liquidity_status"),
    makeAction("GET_YIELD", "Find best yield opportunities across protocols", "get_yield_opportunities"),
    makeAction("ARBITRAGE", "Find and execute arbitrage opportunities", "execute_arbitrage"),
    makeAction("RISK", "Assess stablecoin de-peg risk", "get_risk_assessment"),
    makeAction("EXECUTE", "Execute a task on a specific S7G agent", "execute_task"),
    makeAction("HL_ARBITRAGE", "Execute Hyperliquid funding rate arbitrage", "hl_arbitrage"),
    makeAction("HL_LIQUIDITY", "Manage Hyperliquid LP positions", "hl_liquidity"),
    makeAction("HL_YIELD", "Compare Hyperliquid yields across venues", "yield_optimizer"),
    makeAction("PM_ARBITRAGE", "Execute Polymarket prediction market arbitrage", "pm_arbitrage"),
  ],
  evaluators: [], providers: [], services: [],
};

export default s7gPlugin;
