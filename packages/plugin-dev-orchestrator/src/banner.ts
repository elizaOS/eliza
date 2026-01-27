/**
 * Dev Orchestrator Plugin Settings Banner
 * Beautiful ANSI art display for configuration on startup
 */

import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';

const c = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    brightRed: '\x1b[91m',
    brightGreen: '\x1b[92m',
    brightYellow: '\x1b[93m',
};

interface SettingDisplay {
    name: string;
    value: string | undefined | null;
    isSecret?: boolean;
    defaultValue?: string;
    required?: boolean;
}

function formatSettingValue(setting: SettingDisplay): string {
    const isSet = setting.value !== undefined && setting.value !== null && setting.value !== '';
    const isDefault = !isSet && setting.defaultValue !== undefined;
    
    let displayValue: string;
    let statusColor: string;
    let statusText: string;
    
    if (isSet) {
        if (setting.isSecret) {
            displayValue = '***configured***';
        } else {
            displayValue = String(setting.value).substring(0, 20);
            if (String(setting.value).length > 20) displayValue += '...';
        }
        statusColor = c.green;
        statusText = '(set)';
    } else if (isDefault) {
        displayValue = setting.defaultValue!.substring(0, 20);
        statusColor = c.dim;
        statusText = '(default)';
    } else {
        displayValue = 'not set';
        statusColor = setting.required ? c.red : c.dim;
        statusText = setting.required ? '(required!)' : '(optional)';
    }
    
    const nameCol = `${c.yellow}${setting.name.padEnd(36)}${c.reset}`;
    const valueCol = `${c.white}${displayValue.padEnd(18)}${c.reset}`;
    const statusCol = `${statusColor}${statusText}${c.reset}`;
    
    return `${c.dim}|${c.reset} ${nameCol}${c.dim}|${c.reset} ${valueCol}${statusCol}`;
}

export function printDevOrchestratorBanner(runtime: IAgentRuntime): void {
    // Get settings
    const mode = runtime.getSetting('DEV_ORCHESTRATOR_MODE');
    const buildCmd = runtime.getSetting('DEV_ORCHESTRATOR_BUILD_CMD');
    const authorizedUsers = runtime.getSetting('DEV_ORCHESTRATOR_AUTHORIZED_USERS');
    const authorizedRoles = runtime.getSetting('DEV_ORCHESTRATOR_AUTHORIZED_ROLES');
    const adminUsers = runtime.getSetting('DEV_ORCHESTRATOR_ADMIN_USERS');
    const requireApproval = runtime.getSetting('DEV_ORCHESTRATOR_REQUIRE_APPROVAL');
    const cmdAllowlist = runtime.getSetting('DEV_ORCHESTRATOR_COMMAND_ALLOWLIST');

    // Determine which git service is available
    let gitServiceType = 'legacy (standalone)';
    try {
        const pluginGitService = runtime.getService('git');
        if (pluginGitService) {
            gitServiceType = 'plugin-git (recommended)';
        }
    } catch (error) {
        // Fallback to legacy
    }

    const settings: SettingDisplay[] = [
        { name: 'Git Service', value: gitServiceType },
        { name: 'DEV_ORCHESTRATOR_MODE', value: mode as string, defaultValue: 'trust' },
        { name: 'DEV_ORCHESTRATOR_BUILD_CMD', value: buildCmd as string, defaultValue: 'npm run build' },
        { name: 'DEV_ORCHESTRATOR_REQUIRE_APPROVAL', value: requireApproval as string, defaultValue: 'false' },
        { name: 'DEV_ORCHESTRATOR_AUTHORIZED_USERS', value: authorizedUsers as string },
        { name: 'DEV_ORCHESTRATOR_AUTHORIZED_ROLES', value: authorizedRoles as string },
        { name: 'DEV_ORCHESTRATOR_ADMIN_USERS', value: adminUsers as string },
        { name: 'DEV_ORCHESTRATOR_COMMAND_ALLOWLIST', value: cmdAllowlist as string },
    ];

    // Dev Orchestrator-themed ASCII art with gears/pipeline motif
    const banner = `
${c.bright}${c.brightGreen}+------------------------------------------------------------------------------+${c.reset}
${c.bright}${c.brightGreen}|${c.reset}  ${c.brightYellow}    ____             ____           __              __                ${c.reset}  ${c.bright}${c.brightGreen}|${c.reset}
${c.bright}${c.brightGreen}|${c.reset}  ${c.brightYellow}   / __ \\___ _   __ / __ \\_________/ /_  ___  _____/ /__________ _____ ${c.reset}  ${c.bright}${c.brightGreen}|${c.reset}
${c.bright}${c.brightGreen}|${c.reset}  ${c.brightYellow}  / / / / _ \\ | / // / / / ___/ __/ __ \\/ _ \\/ ___/ __/ ___/ __ '/ __/ ${c.reset}  ${c.bright}${c.brightGreen}|${c.reset}
${c.bright}${c.brightGreen}|${c.reset}  ${c.brightYellow} / /_/ /  __/ |/ // /_/ / /  / /_/ / / /  __(__  ) /_/ /  / /_/ / /_   ${c.reset}  ${c.bright}${c.brightGreen}|${c.reset}
${c.bright}${c.brightGreen}|${c.reset}  ${c.brightYellow}/_____/\\___/|___/ \\____/_/   \\__/_/ /_/\\___/____/\\__/_/   \\__,_/\\__/   ${c.reset}  ${c.bright}${c.brightGreen}|${c.reset}
${c.bright}${c.brightGreen}+------------------------------------------------------------------------------+${c.reset}
${c.dim}|  AI-driven development: task queues, git safety, builds & code review       |${c.reset}
${c.bright}${c.brightGreen}+------------------------------------+--------------------+--------------------+${c.reset}
${c.dim}| SETTING                            | VALUE              | STATUS             |${c.reset}
${c.brightGreen}+------------------------------------+--------------------+--------------------+${c.reset}
${settings.map(s => formatSettingValue(s)).join('\n')}
${c.brightGreen}+------------------------------------------------------------------------------+${c.reset}
${c.dim}| To configure: Add settings to your .env file or character settings          |${c.reset}
${c.dim}| Modes: 'trust' (auto-approve) or 'review' (manual approval required)        |${c.reset}
${c.dim}| User lists: JSON arrays like '["user1", "user2"]'                            |${c.reset}
${c.brightGreen}+------------------------------------------------------------------------------+${c.reset}
`;

    logger.info(`\n${banner}\n`);
}

