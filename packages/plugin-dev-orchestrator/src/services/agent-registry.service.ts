/**
 * AgentRegistry - Central registry for AI coding agent backends
 *
 * WHY THIS EXISTS:
 * The orchestrator supports multiple AI coding agents (Claude Code, Cursor, etc.).
 * Rather than hardcoding agent detection and selection logic throughout the codebase,
 * we use a centralized registry pattern. This provides:
 *
 * 1. SINGLE SOURCE OF TRUTH - All agent availability info in one place
 * 2. DYNAMIC DETECTION - Agents self-register during plugin init if their CLI exists
 * 3. EXTENSIBILITY - Adding new agents only requires calling registerAgentWithDetection()
 * 4. CONSISTENT API - Actions query registry instead of duplicating detection logic
 *
 * WHY SINGLETON:
 * Agent CLI detection should happen once at startup, not on every task.
 * The singleton ensures consistent state across all consumers (actions, services).
 *
 * WHY PRIORITY SYSTEM (recommended > stable > available):
 * - "recommended" = verified, tested, production-ready (e.g., Claude Code)
 * - "stable" = works but may have limitations
 * - "available" = CLI detected but may be experimental
 * This fallback chain ensures users always get the best available agent.
 *
 * @see AGENT SELECTION FLOW:
 * 1. User input parsed for explicit agent ("using cursor")
 * 2. If none, check user's saved preference (entity/component)
 * 3. If preference is 'auto' or invalid, use registry.getRecommended()
 */

import { logger } from '@elizaos/core';
import type { ICodingAgent } from '../interfaces/ICodingAgent';

export interface AgentRegistration {
    /** Agent instance */
    agent: ICodingAgent;
    /** Display name for users */
    displayName: string;
    /** CLI command name */
    cliCommand: string;
    /** Whether this agent is production-ready */
    isStable: boolean;
    /** Whether this agent is recommended */
    isRecommended: boolean;
    /** Optional description */
    description?: string;
    /** Whether the CLI was detected and is available */
    isAvailable: boolean;
    /** Alternative names/aliases for detection in user input */
    aliases?: string[];
}

export class AgentRegistry {
    private static instance: AgentRegistry;
    private agents: Map<string, AgentRegistration> = new Map();

    private constructor() {}

    /**
     * Get singleton instance
     */
    static getInstance(): AgentRegistry {
        if (!AgentRegistry.instance) {
            AgentRegistry.instance = new AgentRegistry();
        }
        return AgentRegistry.instance;
    }

    /**
     * Register an agent backend
     */
    register(agentName: string, registration: AgentRegistration): void {
        if (this.agents.has(agentName)) {
            logger.warn(`[AgentRegistry] Agent '${agentName}' is already registered. Overwriting.`);
        }

        this.agents.set(agentName, registration);

        const status = registration.isAvailable ? '✅' : '⚠️';
        const recommended = registration.isRecommended ? ' (recommended)' : '';
        const stable = registration.isStable ? '' : ' [experimental]';

        logger.info(
            `[AgentRegistry] ${status} Registered agent: ${agentName}${recommended}${stable} - CLI: ${registration.cliCommand}`
        );
    }

    /**
     * Unregister an agent backend
     */
    unregister(agentName: string): boolean {
        const existed = this.agents.delete(agentName);
        if (existed) {
            logger.info(`[AgentRegistry] Unregistered agent: ${agentName}`);
        }
        return existed;
    }

    /**
     * Get a specific agent registration
     */
    get(agentName: string): AgentRegistration | undefined {
        return this.agents.get(agentName);
    }

    /**
     * Get agent instance by name
     */
    getAgent(agentName: string): ICodingAgent | undefined {
        return this.agents.get(agentName)?.agent;
    }

    /**
     * Check if an agent is registered
     */
    has(agentName: string): boolean {
        return this.agents.has(agentName);
    }

    /**
     * Check if an agent is available (CLI detected)
     */
    isAvailable(agentName: string): boolean {
        const registration = this.agents.get(agentName);
        return registration?.isAvailable ?? false;
    }

    /**
     * Get all registered agents
     */
    getAll(): Map<string, AgentRegistration> {
        return new Map(this.agents);
    }

    /**
     * Get all available agents (CLI detected)
     */
    getAvailable(): Map<string, AgentRegistration> {
        const available = new Map<string, AgentRegistration>();
        for (const [name, registration] of this.agents.entries()) {
            if (registration.isAvailable) {
                available.set(name, registration);
            }
        }
        return available;
    }

    /**
     * Get all stable agents
     */
    getStable(): Map<string, AgentRegistration> {
        const stable = new Map<string, AgentRegistration>();
        for (const [name, registration] of this.agents.entries()) {
            if (registration.isStable) {
                stable.set(name, registration);
            }
        }
        return stable;
    }

    /**
     * Get recommended agent (if available)
     */
    getRecommended(): { name: string; registration: AgentRegistration } | null {
        // First, find available recommended agents
        for (const [name, registration] of this.agents.entries()) {
            if (registration.isRecommended && registration.isAvailable) {
                return { name, registration };
            }
        }

        // Fallback: first available stable agent
        for (const [name, registration] of this.agents.entries()) {
            if (registration.isStable && registration.isAvailable) {
                return { name, registration };
            }
        }

        // Last resort: any available agent
        for (const [name, registration] of this.agents.entries()) {
            if (registration.isAvailable) {
                return { name, registration };
            }
        }

        return null;
    }

    /**
     * Get agent names sorted by priority (recommended, stable, available)
     */
    getSortedNames(): string[] {
        const agents = Array.from(this.agents.entries());

        return agents
            .sort((a, b) => {
                const [nameA, regA] = a;
                const [nameB, regB] = b;

                // Sort by: recommended > stable > available > name
                if (regA.isRecommended !== regB.isRecommended) {
                    return regA.isRecommended ? -1 : 1;
                }
                if (regA.isStable !== regB.isStable) {
                    return regA.isStable ? -1 : 1;
                }
                if (regA.isAvailable !== regB.isAvailable) {
                    return regA.isAvailable ? -1 : 1;
                }
                return nameA.localeCompare(nameB);
            })
            .map(([name]) => name);
    }

    /**
     * Get formatted list of agents for display
     */
    getFormattedList(): string {
        const sortedNames = this.getSortedNames();

        if (sortedNames.length === 0) {
            return 'No agents registered';
        }

        const lines: string[] = [];
        for (const name of sortedNames) {
            const reg = this.agents.get(name)!;
            const status = reg.isAvailable ? '✅' : '❌';
            const recommended = reg.isRecommended ? ' (recommended)' : '';
            const experimental = !reg.isStable ? ' [experimental]' : '';

            lines.push(`${status} ${name}${recommended}${experimental}`);
            if (reg.description) {
                lines.push(`   ${reg.description}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Get count of registered agents
     */
    count(): number {
        return this.agents.size;
    }

    /**
     * Get count of available agents
     */
    countAvailable(): number {
        return Array.from(this.agents.values()).filter(r => r.isAvailable).length;
    }

    /**
     * Clear all registrations (for testing)
     */
    clear(): void {
        this.agents.clear();
        logger.info('[AgentRegistry] Cleared all agent registrations');
    }

    /**
     * Get registry status summary
     */
    getStatus(): {
        total: number;
        available: number;
        stable: number;
        recommended: string | null;
    } {
        const recommended = this.getRecommended();

        return {
            total: this.count(),
            available: this.countAvailable(),
            stable: Array.from(this.agents.values()).filter(r => r.isStable).length,
            recommended: recommended?.name ?? null,
        };
    }

    /**
     * Parse user input to detect if a specific agent is requested
     *
     * WHY THIS PARSING APPROACH:
     * Users naturally say things like "fix the bug using cursor" or "add tests with claude".
     * Rather than requiring rigid syntax, we detect common preposition patterns:
     * - "using X", "with X", "via X", "in X", "on X"
     *
     * WHY ALIASES:
     * Users say "claude" but the canonical name is "claude-code".
     * Each agent registers aliases for flexible matching, resolving to canonical names.
     *
     * WHY REGEX WITH WORD BOUNDARIES (\b):
     * Prevents false positives like "discussing cursor" matching "cursor".
     * Only matches when the agent name follows a preposition.
     *
     * @param text - User input text to parse
     * @returns Canonical agent name if detected, null otherwise
     *
     * @example
     * registry.parseAgentFromInput("Fix the bug using cursor")  // returns "cursor"
     * registry.parseAgentFromInput("Add tests with claude")     // returns "claude-code" (via alias)
     * registry.parseAgentFromInput("Refactor the code")         // returns null
     */
    parseAgentFromInput(text: string): string | null {
        const lowerText = text.toLowerCase();

        // Build regex pattern from all agent names and aliases
        const patterns: Array<{ agentName: string; pattern: RegExp }> = [];

        for (const [agentName, registration] of this.agents.entries()) {
            const names = [agentName];
            if (registration.aliases) {
                names.push(...registration.aliases);
            }

            // Create pattern for this agent: matches "using X", "with X", "via X", "in X", "on X"
            const namePattern = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
            const pattern = new RegExp(
                `\\b(?:using|with|via|in|on)\\s+(?:the\\s+)?(${namePattern})(?:\\s+agent)?\\b`,
                'i'
            );

            patterns.push({ agentName, pattern });
        }

        // Try to match each pattern
        for (const { agentName, pattern } of patterns) {
            if (pattern.test(lowerText)) {
                return agentName;
            }
        }

        return null;
    }
}

/**
 * Check if a command exists in PATH
 */
export async function commandExists(command: string): Promise<boolean> {
    try {
        const proc = Bun.spawn(['which', command], {
            cwd: '/',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const exitCode = await proc.exited;
        return exitCode === 0;
    } catch {
        return false;
    }
}

/**
 * Helper function to register an agent with CLI detection
 */
export async function registerAgentWithDetection(
    agentName: string,
    agent: ICodingAgent,
    cliCommand: string,
    options: {
        displayName: string;
        isRecommended?: boolean;
        isStable?: boolean;
        description?: string;
        aliases?: string[];
    }
): Promise<boolean> {
    const isAvailable = await commandExists(cliCommand);

    const registry = AgentRegistry.getInstance();
    registry.register(agentName, {
        agent,
        displayName: options.displayName,
        cliCommand,
        isStable: options.isStable ?? true,
        isRecommended: options.isRecommended ?? false,
        description: options.description,
        aliases: options.aliases,
        isAvailable,
    });

    return isAvailable;
}
