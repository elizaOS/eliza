/**
 * AI Configuration Utilities
 * Handles environment variables and AI feature detection
 * Following Docusaurus best practices for accessing configuration
 */

import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

export interface AIConfig {
  enabled: boolean;
  provider?: 'openai' | 'anthropic' | 'groq' | 'ollama';
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Hook to get AI configuration from Docusaurus context
 * This is the recommended way to access configuration in Docusaurus
 */
export function useAIConfig(): AIConfig {
  const { siteConfig } = useDocusaurusContext();
  const customFields = siteConfig.customFields as any;

  // Get API key from custom fields (passed through webpack config)
  let apiKey: string | undefined;
  const provider = customFields?.aiProvider;
  
  // The API key would be injected during build time based on environment
  if (provider && typeof window !== 'undefined') {
    // Check if API key was provided through custom fields
    apiKey = customFields?.aiApiKey;
  }

  return {
    enabled: customFields?.aiEnabled || false,
    provider: customFields?.aiProvider || undefined,
    apiKey,
    baseUrl: provider === 'ollama' ? customFields?.ollamaBaseUrl : undefined,
  };
}

/**
 * Get AI provider name for display
 */
export function getAIProviderName(provider?: string): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'groq':
      return 'Groq';
    case 'ollama':
      return 'Ollama';
    default:
      return 'AI';
  }
}
