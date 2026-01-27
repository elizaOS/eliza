/**
 * Agent Preference System - Persistent user preferences for AI coding agent selection
 *
 * WHY PERSISTENT PREFERENCES:
 * Users shouldn't have to specify "using claude-code" on every task.
 * We store their preference using elizaOS's entity/component system, which:
 * - Persists across sessions
 * - Is scoped per-user (each user can have their own preference)
 * - Survives restarts
 *
 * WHY ENTITY/COMPONENT STORAGE:
 * elizaOS provides a built-in way to store user-specific data via components.
 * Components are tied to entities (users), so each user gets isolated preferences.
 * No need for custom database tables or external storage.
 *
 * PREFERENCE VALUES:
 * - 'auto' - Let the system detect the best available agent (default)
 * - 'claude-code' - Always use Claude Code
 * - 'cursor' - Always use Cursor
 *
 * SELECTION PRIORITY (highest to lowest):
 * 1. Explicit request in message ("fix bug using cursor") - Parsed by registry
 * 2. User's saved preference - Retrieved from component
 * 3. Auto-detection - Uses registry.getRecommended()
 */

import { Action, HandlerCallback, IAgentRuntime, Memory, State, logger, type UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { AuthorizationService } from '../services/authorization.service';
import { AgentRegistry } from '../services/agent-registry.service';

const COMPONENT_TYPE = 'dev-orchestrator-preference';

export const setAgentPreferenceAction: Action = {
    name: 'SET_AGENT_PREFERENCE',
    similes: ['SET_CODING_AGENT', 'CONFIGURE_AGENT', 'CHOOSE_AGENT', 'PREFER_AGENT'],
    description: 'Set preferred AI coding agent backend (claude-code, cursor, or auto-detect)',

    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const text = message.content.text.toLowerCase();
        return (
            (text.includes('set') || text.includes('use') || text.includes('prefer') || text.includes('configure')) &&
            (text.includes('agent') || text.includes('backend') || text.includes('claude') || text.includes('cursor'))
        );
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        // Check authorization
        const authService = new AuthorizationService(runtime);
        if (!authService.isAuthorized(message)) {
            await callback({
                text: authService.getUnauthorizedMessage('SET_AGENT_PREFERENCE'),
            });
            return;
        }

        const text = message.content.text.toLowerCase();
        const registry = AgentRegistry.getInstance();

        // Parse preference from message
        let agentBackend: string = 'auto';

        // Check for auto-detect first
        if (text.includes('auto') || text.includes('auto-detect') || text.includes('detect')) {
            agentBackend = 'auto';
        } else {
            // Try to find a matching agent by checking names and aliases
            for (const [agentName, registration] of registry.getAll().entries()) {
                const namesToCheck = [agentName];
                if (registration.aliases) {
                    namesToCheck.push(...registration.aliases);
                }

                // Check if any name or alias appears in the text
                for (const name of namesToCheck) {
                    const normalizedName = name.toLowerCase().replace(/[-_]/g, '');
                    const normalizedText = text.replace(/[-_]/g, '');

                    if (normalizedText.includes(normalizedName)) {
                        agentBackend = agentName; // Use canonical agent name
                        break;
                    }
                }

                if (agentBackend !== 'auto') break;
            }
        }

        // Validate agent choice (if not auto)
        if (agentBackend !== 'auto') {

            // Check if agent is registered
            if (!registry.has(agentBackend)) {
                const availableNames = registry.getSortedNames();
                await callback({
                    text: `⚠️ Agent '${agentBackend}' is not registered.\n\nAvailable agents: ${availableNames.length > 0 ? availableNames.join(', ') : 'none'}\n\nPlease use one of the available agents or 'auto' to detect automatically.`,
                });
                return;
            }

            // Check if agent's CLI is available
            if (!registry.isAvailable(agentBackend)) {
                const registration = registry.get(agentBackend);
                const availableAgents = Array.from(registry.getAvailable().keys());

                await callback({
                    text: `⚠️ Agent '${agentBackend}' is registered but not available.\n\nCLI '${registration?.cliCommand}' not found in PATH.\n\nAvailable agents: ${availableAgents.length > 0 ? availableAgents.join(', ') : 'none'}\n\nPlease install the required CLI or use 'auto' to detect automatically.`,
                });
                return;
            }
        }

        try {
            // Get or create component for this user's preferences
            const entityId = message.entityId;
            const worldId = message.worldId;
            const sourceEntityId = runtime.agentId;

            let existingComponent = await runtime.getComponent(
                entityId,
                COMPONENT_TYPE,
                worldId,
                sourceEntityId
            );

            const componentData = {
                agentBackend,
                updatedAt: Date.now(),
            };

            if (existingComponent) {
                // Update existing preference
                await runtime.updateComponent({
                    ...existingComponent,
                    data: componentData,
                });
                logger.info(`[SetAgentPreference] Updated preference for entity ${entityId}: ${agentBackend}`);
            } else {
                // Create new preference component
                const newComponentId = uuidv4() as UUID;
                await runtime.createComponent({
                    id: newComponentId,
                    entityId,
                    agentId: runtime.agentId,
                    roomId: message.roomId,
                    worldId,
                    type: COMPONENT_TYPE,
                    data: componentData,
                    sourceEntityId,
                    createdAt: Date.now(),
                });
                logger.info(`[SetAgentPreference] Created preference for entity ${entityId}: ${agentBackend}`);
            }

            // Show confirmation with agent status
            let confirmationText = `✅ Agent preference set to: **${agentBackend}**\n\n`;

            if (agentBackend === 'auto') {
                const recommended = registry.getRecommended();
                const availableAgents = Array.from(registry.getAvailable().keys());

                if (recommended) {
                    confirmationText += `🔍 Auto-detected agent: **${recommended.name}**\n\n`;
                    confirmationText += `Available agents:\n${availableAgents.map(a => `• ${a}${a === recommended.name ? ' (recommended)' : ''}`).join('\n')}`;
                } else {
                    confirmationText += `⚠️ No coding agents detected on this system.\n\nPlease install Claude Code or Cursor CLI.`;
                }
            } else {
                confirmationText += `All coding tasks will use **${agentBackend}** by default.`;
            }

            await callback({
                text: confirmationText,
            });
        } catch (error) {
            logger.error('[SetAgentPreference] Failed to set preference:', error);
            await callback({
                text: `Failed to set agent preference: ${error}`,
            });
        }
    },

    examples: [
        [
            {
                name: '{{user1}}',
                content: { text: 'Use claude-code as my coding agent' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Agent preference set to claude-code', action: 'SET_AGENT_PREFERENCE' },
            },
        ],
        [
            {
                name: '{{user1}}',
                content: { text: 'Set agent to auto-detect' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Agent preference set to auto', action: 'SET_AGENT_PREFERENCE' },
            },
        ],
        [
            {
                name: '{{user1}}',
                content: { text: 'Prefer cursor for coding tasks' },
            },
            {
                name: '{{agentName}}',
                content: { text: 'Agent preference set to cursor', action: 'SET_AGENT_PREFERENCE' },
            },
        ],
    ],
};

/**
 * Get user's preferred agent backend with full fallback chain
 *
 * WHY THIS FALLBACK CHAIN:
 * We want tasks to ALWAYS succeed, even if preferences are misconfigured.
 *
 * FALLBACK ORDER:
 * 1. Return saved preference (if valid and agent is available)
 * 2. If preference is 'auto' → use registry.getRecommended()
 * 3. If saved preference agent is no longer available → use registry.getRecommended()
 * 4. Final fallback → 'claude-code' (even if not available, to provide clear error)
 *
 * WHY VALIDATE AVAILABILITY:
 * User might have saved preference for 'cursor', but later uninstalled it.
 * We detect this and gracefully fall back rather than failing the task.
 */
export async function getUserAgentPreference(
    runtime: IAgentRuntime,
    entityId: UUID,
    worldId: UUID
): Promise<string> {
    const registry = AgentRegistry.getInstance();

    try {
        const component = await runtime.getComponent(
            entityId,
            COMPONENT_TYPE,
            worldId,
            runtime.agentId
        );

        if (component && component.data?.agentBackend) {
            const preference = component.data.agentBackend as string;

            // If auto, use registry to detect available agents
            if (preference === 'auto') {
                const recommended = registry.getRecommended();
                return recommended?.name || 'claude-code'; // Fallback to claude-code
            }

            // Verify the preference is still available
            if (registry.isAvailable(preference)) {
                return preference;
            } else {
                logger.warn(`[GetUserAgentPreference] Preference '${preference}' no longer available, using auto-detect`);
                const recommended = registry.getRecommended();
                return recommended?.name || 'claude-code';
            }
        }
    } catch (error) {
        logger.debug('[GetUserAgentPreference] No preference found or error:', error);
    }

    // Default: auto-detect via registry
    const recommended = registry.getRecommended();
    return recommended?.name || 'claude-code'; // Fallback to claude-code
}
