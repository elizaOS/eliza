import { Character, Content } from '@elizaos/core';
import { usePlugins } from '@/hooks/use-plugins';

const PROVIDER_PLUGIN_MAPPINGS: Record<string, string> = {
  google: '@elizaos/plugin-google-genai',
  llama_local: '@elizaos/plugin-ollama',
  // extend as needed
};

const CLIENT_PLUGIN_MAPPINGS: Record<string, string> = {
  // add as needed
};

const ESSENTIAL_PLUGINS = ['@elizaos/plugin-sql', '@elizaos/plugin-bootstrap'];

export interface V1Character extends Character {
  name: string;
  lore?: string[];
  clients?: string[];
  modelProvider?: string;
  bio?: string | string[];
  messageExamples?: any[][];
  username?: string;
  system?: string;
  settings?: {
    [key: string]: string | boolean | number | Record<string, any>;
  };
  topics?: string[];
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  adjectives?: string[];
  postExamples?: string[];
}

export function useConvertCharacter() {
  const { data: availablePlugins = [] } = usePlugins();

  const matchPlugins = (v1: V1Character): string[] => {
    const matched = new Set<string>();

    // Clients
    if (Array.isArray(v1.clients)) {
      for (const client of v1.clients) {
        const lower = client.toLowerCase();
        const mapped = CLIENT_PLUGIN_MAPPINGS[lower];
        if (mapped && availablePlugins.includes(mapped)) {
          matched.add(mapped);
        } else {
          const constructed = `@elizaos/plugin-${lower}`;
          if (availablePlugins.includes(constructed)) {
            matched.add(constructed);
          }
        }
      }
    }

    // Model provider
    let providerMatched = false;
    if (typeof v1.modelProvider === 'string') {
      const lower = v1.modelProvider.toLowerCase();
      const mapped = PROVIDER_PLUGIN_MAPPINGS[lower];
      if (mapped && availablePlugins.includes(mapped)) {
        matched.add(mapped);
        providerMatched = true;
      } else {
        const constructed = `@elizaos/plugin-${lower}`;
        if (availablePlugins.includes(constructed)) {
          matched.add(constructed);
          providerMatched = true;
        }
      }
      if (!providerMatched) {
        if (availablePlugins.includes('@elizaos/plugin-openai')) {
          matched.add('@elizaos/plugin-openai');
        }
      }
    } else {
      // If no modelProvider specified, default to OpenAI
      if (availablePlugins.includes('@elizaos/plugin-openai')) {
        matched.add('@elizaos/plugin-openai');
      }
    }

    // Add essential plugins only if they exist in availablePlugins
    for (const plugin of ESSENTIAL_PLUGINS) {
      if (availablePlugins.includes(plugin)) {
        matched.add(plugin);
      }
    }

    return Array.from(matched).sort();
  };

  function isV1MessageExampleFormat(example: any): example is { user: string; content: Content } {
    return typeof example === 'object' && example !== null && 'user' in example;
  }

  const convertCharacter = (v1: V1Character): Character => {
    const bio = [...(Array.isArray(v1.bio) ? v1.bio : v1.bio ? [v1.bio] : []), ...(v1.lore ?? [])];

    const messageExamples =
      (v1.messageExamples ?? []).map((thread: any[]) =>
        thread.map((msg: any) => {
          if (isV1MessageExampleFormat(msg)) {
            return {
              name: msg.user,
              content: msg.content,
            };
          }
          return msg;
        })
      ) ?? [];

    const plugins = matchPlugins(v1);
    const v2: Character = {
      name: v1.name,
      username: v1.username,
      system: v1.system,
      settings: v1.settings,
      plugins,
      bio,
      topics: v1.topics,
      style: v1.style,
      adjectives: v1.adjectives,
      messageExamples,
      postExamples: v1.postExamples,
    };

    return v2;
  };

  return { convertCharacter };
}
