/**
 * Complete rules configuration
 * This file consolidates all rules into a single configuration object
 */

import { RulesConfig, Rule } from './types';
import { GENERAL_CODING_GUIDELINES, TYPESCRIPT_CODING_GUIDELINES } from './general';
import { PROJECT_STRUCTURE } from './project-overview';

/**
 * Cursor IDE rules converted to TypeScript format
 */
export const CURSOR_RULES: Rule[] = [
  {
    name: 'general',
    description: 'General coding guidelines',
    globs: [],
    alwaysApply: true,
    content: {
      title: 'General Coding Rules',
      guidelines: [
        'Use python with type annotations',
        'Target python 3.11 or higher',
        'Use pathlib instead of os.path. Also use Path.read_text() over with...open() constructs',
        'Use argparse to add interfaces',
        'Keep code comments to a minimum and only highlight particularly logically challenging things',
        'Do not append to the README unless specifically requested',
      ],
    },
  },
  {
    name: 'project-overview',
    description: 'SWE-agent project structure and overview',
    globs: [],
    alwaysApply: true,
    content: {
      title: 'SWE-agent Overview',
      overview: 'SWE-agent implements an AI software engineering agent that uses language models to fix github issues.',
      projectStructure: PROJECT_STRUCTURE,
    },
  },
];

/**
 * Complete rules configuration
 */
export const RULES_CONFIG: RulesConfig = {
  general: GENERAL_CODING_GUIDELINES,
  projectOverview: PROJECT_STRUCTURE,
  cursorRules: CURSOR_RULES,
};

/**
 * Helper function to export rules to Cursor IDE format
 */
export function exportToCursorFormat(rule: Rule): string {
  const frontmatter = [
    '---',
    `description: ${rule.description || ''}`,
    `globs: ${rule.globs?.join(', ') || ''}`,
    `alwaysApply: ${rule.alwaysApply}`,
    '---',
    '',
  ].join('\n');

  let content = '';
  if (typeof rule.content === 'string') {
    content = rule.content;
  } else if (rule.content) {
    if (rule.content.title) {
      content += `# ${rule.content.title}\n\n`;
    }
    if (rule.content.overview) {
      content += `${rule.content.overview}\n\n`;
    }
    if (rule.content.guidelines) {
      content += rule.content.guidelines.map((g) => `- ${g}`).join('\n');
    }
    if (rule.content.projectStructure) {
      content += '\n\nProject Structure:\n';
      content += `- Main entry points: ${rule.content.projectStructure.mainEntryPoints.map((e) => e.path).join(', ')}\n`;
      content += `- Main class: ${rule.content.projectStructure.mainClass.name} (${rule.content.projectStructure.mainClass.path})\n`;
      content += `- Execution: ${rule.content.projectStructure.executionEnvironment.description}\n`;
      content += `- Tools: Located in ${rule.content.projectStructure.tools.location}\n`;
      content += `- Inspectors: ${rule.content.projectStructure.inspectors.map((i) => i.name).join(', ')}\n`;
    }
  }

  return frontmatter + content;
}

/**
 * Convert all rules to Cursor IDE format
 */
export function exportAllRulesToCursor(): Record<string, string> {
  const exported: Record<string, string> = {};

  for (const rule of CURSOR_RULES) {
    exported[`${rule.name}.mdc`] = exportToCursorFormat(rule);
  }

  return exported;
}

/**
 * Get configuration for a specific language
 */
export function getLanguageConfig(language: 'python' | 'typescript') {
  return language === 'python' ? GENERAL_CODING_GUIDELINES : TYPESCRIPT_CODING_GUIDELINES;
}

/**
 * Check if a file should have rules applied based on globs
 */
export function shouldApplyRules(filePath: string, rule: Rule): boolean {
  if (rule.alwaysApply) {
    return true;
  }

  if (!rule.globs || rule.globs.length === 0) {
    return false;
  }

  // Simple glob matching (extend as needed)
  for (const glob of rule.globs) {
    if (glob === '*' || filePath.includes(glob.replace('*', ''))) {
      return true;
    }
  }

  return false;
}
