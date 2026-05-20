/**
 * LLM Integrations
 *
 * Direct integrations with various LLM providers:
 *
 * FOR AGENTS (autonomous services):
 * - callAgentLLM() - Routes to configured provider
 * - Providers: HuggingFace, Phala, Ollama, Groq
 * - Set AGENT_LLM_PROVIDER env var
 *
 * FOR CORE GAME (MarketDecisionEngine, etc.):
 * - Uses FeedLLMClient (in @feed/engine)
 * - Always uses Groq/Claude/OpenAI
 * - Do NOT use agent LLM for core game
 *
 * RL Training Loop:
 * - Agents use trained models via callAgentLLM()
 * - Generate trajectory data
 * - Training pipeline trains new model
 * - Deploy to HuggingFace/Phala/Ollama
 * - Agents use new model
 */

// Agent LLM (for autonomous agents - routes to HF/Phala/Ollama/Groq)
export * from "./agent-llm";
// Direct providers (for specific use cases)
export * from "./direct-groq";

// Ollama provider (used by agent-llm, also exported for direct use)
export * from "./ollama-provider";
