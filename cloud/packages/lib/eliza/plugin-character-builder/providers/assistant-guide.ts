import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

/**
 * Assistant Guide Provider
 *
 * Documentation for building AI assistants with:
 * - RAG Knowledge (vector search)
 * - MCP Tools (plugin capabilities)
 * - Web Search (coming soon)
 *
 * This provider is included when building assistants or hybrid agents.
 */

const ASSISTANT_CAPABILITIES_REFERENCE = `# Assistant Capabilities Reference

## Knowledge Base (RAG)

Your assistant can analyze and reference large amounts of information through the knowledge base.

### How It Works
1. **Upload Documents**: PDFs, transcripts, text files, markdown
2. **Automatic Processing**: Content is chunked and embedded for vector search
3. **Smart Retrieval**: When users ask questions, relevant chunks are retrieved using BM25 + vector similarity
4. **Context Injection**: Top 3-5 most relevant chunks are added to the assistant's context

### Best Practices
- **Structured Content**: Well-organized documents with clear headers improve retrieval
- **Focused Topics**: Multiple smaller, focused documents often work better than one massive file
- **Update Regularly**: Keep knowledge base current for accurate responses

### User Instructions
Tell users: "Go to the **Files** tab to upload PDFs, transcripts, or text files. Your assistant will be able to search and reference this content when answering questions."

---

## MCP Tools (Plugin Capabilities)

MCP (Model Context Protocol) tools extend your assistant's capabilities beyond conversation.

### How It Works
1. **Enable Plugins**: User goes to Settings → Plugins
2. **Select Tools**: Choose which MCP tools to enable for the agent
3. **Auto-Integration**: Enabled tools become available actions for the assistant
4. **Task Execution**: Assistant can call tools to perform real actions

### Available Tool Categories
- **Data Tools**: Database queries, API calls, data processing
- **Productivity Tools**: Calendar, email, task management
- **Development Tools**: Code execution, file operations
- **Integration Tools**: Third-party service connections

### Best Practices
- **Minimal Permissions**: Only enable tools the assistant actually needs
- **Clear Instructions**: Add guidance in the system prompt about when to use specific tools
- **Test Thoroughly**: Verify tool behavior before deploying

### User Instructions
Tell users: "Go to **Settings → Plugins** to enable MCP tools for your assistant. Each tool gives your agent new capabilities like searching, calculating, or connecting to external services."

---

## Web Search (Coming Soon)

Real-time web search capability for up-to-date information.

### Planned Features
- Search the web for current events and information
- Cite sources in responses
- Configurable search providers

### Status
This feature is planned but not yet available. When implemented, assistants will be able to search for real-time information beyond their training data.

---

## Assistant vs Companion Prompting

**Assistants** use different prompting than **Companions**:

### Companion (personality-focused)
- Strong character identity and voice
- Emotional engagement
- Message examples for style
- Adjectives and topics for variety

### Assistant (capability-focused)
- Task-oriented system prompt
- Clear capability boundaries
- Tool usage instructions
- Knowledge base integration

### Hybrid (both)
- Character personality + tool capabilities
- Engaging voice while being helpful
- Best of both worlds

---

## System Prompt for Assistants

For capability-focused assistants, structure your system prompt like this:

\`\`\`
You are [Name], a [role/purpose] assistant.

**Core Capabilities:**
- [Capability 1]
- [Capability 2]
- [Knowledge areas]

**How to Help:**
- [Workflow/approach]
- [When to use tools]
- [Response style]

**Boundaries:**
- [What you don't do]
- [When to escalate]
\`\`\`

This structure helps the assistant understand its role and capabilities clearly.
`;

export const assistantGuideProvider: Provider = {
  name: "ASSISTANT_GUIDE",
  description:
    "Documentation for building AI assistants with RAG knowledge, MCP tools, and web search",
  contexts: ["general", "agent_internal"],
  contextGate: { anyOf: ["general", "agent_internal"] },
  cacheStable: true,
  cacheScope: "agent",
  roleGate: { minRole: "USER" },

  get: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
    return {
      values: {
        assistantGuide: ASSISTANT_CAPABILITIES_REFERENCE,
      },
      data: {
        capabilitiesReference: ASSISTANT_CAPABILITIES_REFERENCE,
      },
      text: ASSISTANT_CAPABILITIES_REFERENCE,
    };
  },
};
