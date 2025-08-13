// Environment configuration with defaults
export const config = {
  // Eliza server API URL
  elizaApiUrl: process.env.NEXT_PUBLIC_ELIZA_API_URL || 'http://localhost:3000/v1/chat/completions',
  
  // Optional API key for authentication
  elizaApiKey: process.env.ELIZA_API_KEY || '',
  
  // Default agent ID
  defaultAgentId: process.env.NEXT_PUBLIC_DEFAULT_AGENT_ID || 'default',
  
  // Default model to use
  defaultModel: process.env.NEXT_PUBLIC_DEFAULT_MODEL || 'gpt-5-mini',
} as const;
