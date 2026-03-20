import { Action, type ActionResult, HandlerCallback, IAgentRuntime, Memory, State, logger } from '@elizaos/core';
import { searchPluginsByContent, getPluginDetails } from '../services/pluginRegistryService';

export const searchPluginAction: Action = {
  name: 'SEARCH_PLUGINS',
  similes: [
    'search for plugins',
    'find plugins',
    'look for plugins',
    'discover plugins',
    'search registry',
  ],

  description:
    'Search for plugins in the official elizaOS registry using vectorized similarity search. Finds plugins by functionality, features, and natural language descriptions.',

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Search for plugins that can handle blockchain transactions',
          actions: ['SEARCH_PLUGINS'],
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: "I'll search for blockchain-related plugins that can handle transactions.",
          actions: ['SEARCH_PLUGINS'],
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: '🔍 Found 5 plugins related to blockchain transactions:\n\n1. **@elizaos/plugin-solana** (Score: 0.87)\n   💡 Solana blockchain integration with transaction handling\n   🏷️ Tags: blockchain, solana, transaction, defi\n   📦 Features: Send transactions, Query balances, Deploy contracts\n\n2. **@elizaos/plugin-ethereum** (Score: 0.82)\n   💡 Ethereum blockchain operations and smart contracts\n   🏷️ Tags: blockchain, ethereum, web3, smart-contracts\n   📦 Features: ERC-20 operations, Gas estimation, Contract deployment\n\n3. **@elizaos/plugin-wallet** (Score: 0.75)\n   💡 Multi-chain wallet operations and management\n   🏷️ Tags: wallet, multi-chain, transaction, security\n   📦 Features: Wallet creation, Transaction signing, Balance tracking\n\nWould you like me to show details for any of these plugins or help you install one?',
          actions: ['SEARCH_PLUGINS'],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';

    // Validation patterns
    const searchPatterns = [
      /search.*plugins?/i,
      /find.*plugins?/i,
      /look.*for.*plugins?/i,
      /discover.*plugins?/i,
      /plugins?.*(for|that|to)/i,
      /need.*plugins?/i,
      /show.*plugins?/i,
      /list.*plugins?/i,
    ];

    return searchPatterns.some((pattern) => pattern.test(text));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info('[searchPluginAction] Starting plugin search');

    // Extract search query from message
    const query = extractSearchQuery(message.content?.text || '');

    if (!query) {
      if (callback) {
        await callback({
          text: '🤔 Please specify what kind of functionality or features you\'re looking for in a plugin.\n\nFor example:\n• "Search for plugins that handle blockchain transactions"\n• "Find plugins for social media integration"\n• "Look for plugins that can process images"',
          actions: ['SEARCH_PLUGINS'],
        });
      }
return { success: false, error: 'Search query not specified.' };
    }

    logger.info(`[searchPluginAction] Searching for: "${query}"`);

    try {
      // Search using the API-based registry service
      const searchResult = await searchPluginsByContent(query);

      if (!searchResult.fromApi) {
        if (callback) {
          await callback({
            text: `Could not reach the plugin registry: ${searchResult.error}\n\nCheck that ELIZAOS_API_URL is configured correctly.`,
            actions: ['SEARCH_PLUGINS'],
          });
        }
return { success: false, error: searchResult.error ?? 'Registry unreachable.' };
      }

      const results = searchResult.data;

      if (results.length === 0) {
        if (callback) {
          await callback({
            text: `No plugins found matching "${query}".\n\nTry different keywords like: "database", "api", "blockchain", "twitter", "discord", "solana"`,
            actions: ['SEARCH_PLUGINS'],
          });
        }
return { success: true, text: 'No plugins found.' };
      }

      // Format results with rich information
      let responseText = `🔍 Found ${results.length} plugin${results.length > 1 ? 's' : ''} matching "${query}":\n\n`;

      results.forEach((plugin, index) => {
        const score = plugin.score ? (plugin.score * 100).toFixed(0) : '';

        responseText += `${index + 1}. **${plugin.name}**${score ? ` (Score: ${score}%)` : ''}\n`;

        if (plugin.description) {
          responseText += `   💡 ${plugin.description}\n`;
        }

        if (plugin.tags && plugin.tags.length > 0) {
          const displayTags = plugin.tags.slice(0, 5);
          responseText += `   🏷️ Tags: ${displayTags.join(', ')}\n`;
        }

        if (plugin.relevantSection) {
          responseText += `   📄 "${plugin.relevantSection}"\n`;
        }

        if (plugin.version) {
          responseText += `   📌 Version: ${plugin.version}\n`;
        }

        responseText += '\n';
      });

      // Add helpful suggestions
      responseText += '💡 **Next steps:**\n';
      responseText += '• Say "tell me more about [plugin-name]" for detailed info\n';
      responseText += '• Say "install [plugin-name]" to install a plugin\n';
      responseText += '• Say "clone [plugin-name]" to clone for development';

      if (callback) {
        await callback({
          text: responseText,
          actions: ['SEARCH_PLUGINS'],
        });
      }
      return { success: true, text: responseText };
    } catch (error) {
      logger.error('[searchPluginAction] Search failed:', error);
      if (callback) {
        await callback({
          text: '❌ Failed to search plugins. Please try again later.',
          actions: ['SEARCH_PLUGINS'],
        });
      }
return { success: false, error: error instanceof Error ? error.message : 'Search failed.' };
    }

    return { success: true };
  },
};

/**
 * Extract search query from user message using improved patterns
 */
function extractSearchQuery(text: string): string | null {
  // Patterns for query extraction
  const patterns = [
    // Direct search patterns
    /search\s+for\s+plugins?\s+(?:that\s+)?(?:can\s+)?(.+)/i,
    /find\s+plugins?\s+(?:for|that|to)\s+(.+)/i,
    /look\s+for\s+plugins?\s+(?:that\s+)?(.+)/i,
    /discover\s+plugins?\s+(?:for|that)\s+(.+)/i,
    /show\s+me\s+plugins?\s+(?:for|that)\s+(.+)/i,

    // Need-based patterns
    /need\s+(?:a\s+)?plugins?\s+(?:for|that|to)\s+(.+)/i,
    /want\s+(?:a\s+)?plugins?\s+(?:for|that|to)\s+(.+)/i,

    // Capability-based patterns
    /plugins?\s+(?:for|that\s+can|to)\s+(.+)/i,
    /what\s+plugins?\s+(?:can|do|handle)\s+(.+)/i,

    // Simple patterns
    /plugins?\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let query = match[1].trim();

      // Clean up common artifacts
      query = query.replace(/\?+$/, ''); // Remove trailing question marks
      query = query.replace(/^(do|handle|manage|work\s+with)\s+/i, ''); // Remove action words
      query = query.replace(/\s+/g, ' '); // Normalize whitespace

      if (query.length > 2) {
        return query;
      }
    }
  }

  // If no pattern matches, try to extract technology/domain keywords
  const techKeywords = text.match(
    /\b(blockchain|ai|database|api|social|twitter|discord|telegram|solana|ethereum|trading|defi|nft|authentication|security|monitoring|analytics|file|image|video|audio|email|sms|payment)\b/gi
  );

  if (techKeywords && techKeywords.length > 0) {
    return techKeywords.join(' ');
  }

  return null;
}

/**
 * Helper action to get plugin details
 */
export const getPluginDetailsAction: Action = {
  name: 'GET_PLUGIN_DETAILS',
  similes: ['tell me more about', 'show details for', 'plugin info', 'plugin details'],
  description:
    'Get detailed information about a specific plugin including features, dependencies, and usage.',

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Tell me more about @elizaos/plugin-solana',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: '📋 **@elizaos/plugin-solana** Details:\n\n💡 **Description:** Comprehensive Solana blockchain integration\n\n🏷️ **Tags:** blockchain, solana, defi, transaction\n\n📦 **Features:**\n• Send and receive SOL transactions\n• Query wallet balances and transaction history\n• Deploy and interact with programs\n• Handle SPL token operations\n\n🔗 **Dependencies:** None\n\n📌 **Version:** 1.2.0\n📍 **Repository:** https://github.com/elizaos-plugins/plugin-solana\n📦 **NPM:** @elizaos/plugin-solana\n\n💡 **Related Plugins:**\n• @elizaos/plugin-wallet (complementary)\n• @elizaos/plugin-defi (similar)\n\nTo install: "install @elizaos/plugin-solana"',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() || '';
    return (
      /tell\s+me\s+more|show\s+details|plugin\s+info|more\s+about/.test(text) &&
      /@?[\w-]+\/plugin-[\w-]+|plugin-[\w-]+/.test(text)
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const text = message.content?.text || '';
    const pluginMatch = text.match(/@?([\w-]+\/plugin-[\w-]+|plugin-[\w-]+)/i);

    if (!pluginMatch) {
      if (callback) {
        await callback({
          text: '🤔 Please specify which plugin you\'d like to know more about.\n\nExample: "Tell me more about @elizaos/plugin-solana"',
        });
      }
return { success: false, error: 'Plugin name not specified.' };
    }

    let pluginName = pluginMatch[1];
    if (!pluginName.startsWith('@') && !pluginName.includes('/')) {
      pluginName = `@elizaos/${pluginName}`;
    }

    try {
      const detailsResult = await getPluginDetails(pluginName);

      if (!detailsResult.fromApi) {
        if (callback) {
          await callback({
            text: `Could not reach the plugin registry: ${detailsResult.error}\n\nCheck that ELIZAOS_API_URL is configured correctly.`,
          });
        }
return { success: false, error: detailsResult.error ?? 'Registry unreachable.' };
      }

      const details = detailsResult.data;

      if (!details) {
        if (callback) {
          await callback({
            text: `Plugin "${pluginName}" not found in the registry.\n\nTry searching for plugins first: "search for [functionality]"`,
          });
        }
return { success: false, error: 'Plugin not found.' };
      }

      let responseText = `📋 **${details.name}** Details:\n\n`;

      if (details.description) {
        responseText += `💡 **Description:** ${details.description}\n\n`;
      }

      if (details.tags && details.tags.length > 0) {
        responseText += `🏷️ **Tags:** ${details.tags.join(', ')}\n\n`;
      }

      // Remove features and requiredConfig - these properties don't exist on PluginMetadata

      if (details.latestVersion) {
        responseText += `📌 **Version:** ${details.latestVersion}\n`;
      }
      if (details.repository) {
        responseText += `📍 **Repository:** ${details.repository}\n`;
      }
      // Remove npmPackage - this property doesn't exist on PluginMetadata

      // Add related plugins if available
      // This functionality will be re-enabled once the API supports it
      // if (details.relatedPlugins && details.relatedPlugins.length > 0) {
      //   responseText += `\n💡 **Related Plugins:**\n${details.relatedPlugins.map((p) => `• ${p.name} (${p.reason})`).join('\n')}`;
      // }

      responseText += `\n\nTo install: "install ${details.name}"`;

      if (callback) {
        await callback({
          text: responseText,
        });
      }
      return { success: true, text: responseText };
    } catch (error) {
      logger.error('[getPluginDetailsAction] Failed to get plugin details:', error);
      if (callback) {
        await callback({
          text: '❌ Failed to get plugin details. Please try again later.',
        });
      }
return { success: false, error: error instanceof Error ? error.message : 'Get details failed.' };
    }
    return { success: true };
  },
};
