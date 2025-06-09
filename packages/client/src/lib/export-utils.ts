import type { Agent } from '@elizaos/core';

export interface ExportResult {
  success: boolean;
  filename?: string;
  error?: string;
}

export interface ToastFunction {
  (options: { title: string; description: string; variant?: 'default' | 'destructive' }): void;
}

/**
 * Sanitizes a filename by replacing non-alphanumeric characters with dashes
 * and cleaning up multiple consecutive dashes
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, '-') // Replace non-alphanumeric with dash
    .replace(/-+/g, '-') // Replace multiple consecutive dashes with single dash
    .replace(/^-|-$/g, '') // Remove leading/trailing dashes
    .toLowerCase();
}

/**
 * Converts an agent to character JSON data, excluding sensitive information
 */
export function agentToCharacterData(agent: Agent): Record<string, any> {
  const characterData = {
    id: agent.id,
    name: agent.name,
    username: agent.username,
    system: agent.system,
    templates: agent.templates,
    bio: agent.bio,
    messageExamples: agent.messageExamples,
    postExamples: agent.postExamples,
    topics: agent.topics,
    adjectives: agent.adjectives,
    knowledge: agent.knowledge,
    plugins: agent.plugins,
    settings: agent.settings ? { ...agent.settings } : undefined,
    style: agent.style,
  };

  // Remove secrets from settings if they exist
  if (characterData.settings && 'secrets' in characterData.settings) {
    const { secrets, ...settingsWithoutSecrets } = characterData.settings;
    characterData.settings = settingsWithoutSecrets;
  }

  // Remove undefined/null fields to keep JSON clean
  return Object.fromEntries(
    Object.entries(characterData).filter(([_, value]) => value !== undefined && value !== null)
  );
}

/**
 * Generates a filename for the exported character
 */
export function generateExportFilename(agentName: string): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  const sanitizedName = sanitizeFilename(agentName || 'agent');
  return `${sanitizedName}-${date}.json`;
}

/**
 * Creates and triggers a download of a JSON file
 */
export function downloadJsonFile(data: any, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Exports an agent's character data as a JSON file download
 * @param agent - The agent containing the character data to export
 * @param toast - Optional toast function for notifications
 * @returns Export result with success status and filename or error
 */
export function exportCharacterAsJson(agent: Agent, toast?: ToastFunction): ExportResult {
  try {
    const characterData = agentToCharacterData(agent);
    const filename = generateExportFilename(agent.name);

    downloadJsonFile(characterData, filename);

    // Success notification
    if (toast) {
      toast({
        title: 'Character Exported',
        description: `${agent.name}'s character data has been downloaded as ${filename}`,
      });
    }

    return { success: true, filename };
  } catch (error) {
    console.error('Failed to export character:', error);

    // Error notification
    if (toast) {
      toast({
        title: 'Export Failed',
        description: 'Failed to export character data. Please try again.',
        variant: 'destructive',
      });
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
