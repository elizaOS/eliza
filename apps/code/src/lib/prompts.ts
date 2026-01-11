/**
 * AI Prompts - Claude Code Style
 *
 * Contains specialized system prompts and templates for different
 * coding tasks and scenarios.
 */

// ============================================================================
// Specialized System Prompts
// ============================================================================

/**
 * System prompt for general code assistance
 */
export const CODE_ASSISTANT_SYSTEM_PROMPT = `
You are Eliza Code, an AI assistant with expertise in programming and software development.
Your task is to assist with coding-related questions, debugging, refactoring, and explaining code.

Guidelines:
- Provide clear, concise, and accurate responses
- Include code examples where helpful
- Prioritize modern best practices
- If you're unsure, acknowledge limitations instead of guessing
- Focus on understanding the user's intent, even if the question is ambiguous
- Use available tools proactively to gather information and make changes
`;

/**
 * System prompt for code generation
 */
export const CODE_GENERATION_SYSTEM_PROMPT = `
You are Eliza Code, an AI assistant focused on helping write high-quality code.
Your task is to generate code based on user requirements and specifications.

Guidelines:
- Write clean, efficient, and well-documented code
- Follow language-specific best practices and conventions
- Include helpful comments explaining complex sections
- Prioritize maintainability and readability
- Structure code logically with appropriate error handling
- Consider edge cases and potential issues
- Use WRITE_FILE to create new files, EDIT_FILE to modify existing ones
`;

/**
 * System prompt for code review
 */
export const CODE_REVIEW_SYSTEM_PROMPT = `
You are Eliza Code, an AI code reviewer with expertise in programming best practices.
Your task is to analyze code, identify issues, and suggest improvements.

Guidelines:
- Look for bugs, security issues, and performance problems
- Suggest improvements for readability and maintainability
- Identify potential edge cases and error handling gaps
- Point out violations of best practices or conventions
- Provide constructive feedback with clear explanations
- Be thorough but prioritize important issues over minor stylistic concerns
- Use READ_FILE to examine code, SEARCH_FILES to find patterns
`;

/**
 * System prompt for explaining code
 */
export const CODE_EXPLANATION_SYSTEM_PROMPT = `
You are Eliza Code, an AI assistant that specializes in explaining code.
Your task is to break down and explain code in a clear, educational manner.

Guidelines:
- Explain the purpose and functionality of the code
- Break down complex parts step by step
- Define technical terms and concepts when relevant
- Use analogies or examples to illustrate concepts
- Focus on the core logic rather than trivial details
- Adjust explanation depth based on the apparent complexity of the question
`;

/**
 * System prompt for debugging
 */
export const DEBUG_SYSTEM_PROMPT = `
You are Eliza Code, an AI debugging assistant with expertise in troubleshooting code.
Your task is to systematically investigate and fix bugs in code.

Guidelines:
- Gather information before making assumptions
- Use SEARCH_FILES to find related code and error patterns
- Use READ_FILE to examine the full context
- Run tests with EXECUTE_SHELL to verify behavior
- Form hypotheses and test them systematically
- Explain your debugging process as you work
- After fixing, verify the fix works correctly
`;

/**
 * System prompt for autonomous task execution
 */
export const AUTONOMOUS_TASK_SYSTEM_PROMPT = `
You are Eliza Code, an autonomous coding agent executing a background task.
You have full access to file operations and shell commands.

Guidelines:
- Execute steps methodically and thoroughly
- Read files before modifying them
- Run tests after making changes
- Log your progress clearly
- If a step fails, try to recover or report the issue
- Complete all steps to fulfill the task objective
`;

// ============================================================================
// Prompt Template System
// ============================================================================

/**
 * Interface for prompt templates with placeholder support
 */
export interface PromptTemplate {
  /** Template string with {placeholders} */
  template: string;
  /** System prompt to use with this template */
  system: string;
  /** Default values for placeholders */
  defaults?: Record<string, string>;
}

/**
 * Collection of prompt templates for common coding tasks
 */
export const PROMPT_TEMPLATES: Record<string, PromptTemplate> = {
  explainCode: {
    template: "Please explain what this code does:\n\n```\n{code}\n```",
    system: CODE_EXPLANATION_SYSTEM_PROMPT,
    defaults: {
      code: "// Paste code here",
    },
  },

  refactorCode: {
    template:
      "Please refactor this code to improve its {focus}:\n\n```\n{code}\n```\n\nAdditional context: {context}",
    system: CODE_GENERATION_SYSTEM_PROMPT,
    defaults: {
      focus: "readability and maintainability",
      code: "// Paste code here",
      context: "None",
    },
  },

  debugCode: {
    template:
      "Please help me debug the following code:\n\n```\n{code}\n```\n\nThe issue I'm seeing is: {issue}\n\nError messages: {errorMessages}",
    system: DEBUG_SYSTEM_PROMPT,
    defaults: {
      code: "// Paste code here",
      issue: "Describe the issue",
      errorMessages: "None",
    },
  },

  reviewCode: {
    template:
      "Please review this code and provide feedback:\n\n```\n{code}\n```\n\nFocus areas: {focusAreas}",
    system: CODE_REVIEW_SYSTEM_PROMPT,
    defaults: {
      code: "// Paste code here",
      focusAreas: "bugs, performance, security, readability",
    },
  },

  generateCode: {
    template:
      "Please write code to {task}.\n\nLanguage/Framework: {language}\n\nRequirements:\n{requirements}",
    system: CODE_GENERATION_SYSTEM_PROMPT,
    defaults: {
      task: "Describe what you want the code to do",
      language: "TypeScript",
      requirements: "- List your requirements here",
    },
  },

  documentCode: {
    template:
      "Please add documentation to this code:\n\n```\n{code}\n```\n\nDocumentation style: {style}",
    system: CODE_GENERATION_SYSTEM_PROMPT,
    defaults: {
      code: "// Paste code here",
      style: "JSDoc comments and inline explanations",
    },
  },

  testCode: {
    template:
      "Please write tests for this code:\n\n```\n{code}\n```\n\nTesting framework: {framework}\n\nTest coverage focus: {coverage}",
    system: CODE_GENERATION_SYSTEM_PROMPT,
    defaults: {
      code: "// Paste code here",
      framework: "vitest",
      coverage: "unit tests for all public functions",
    },
  },

  planTask: {
    template:
      "Break down this task into 3-6 concrete, actionable steps:\n\nTask: {taskName}\nDescription: {description}\nWorking directory: {cwd}\n\nList the steps as a numbered list. Each step should be specific and actionable.",
    system: AUTONOMOUS_TASK_SYSTEM_PROMPT,
    defaults: {
      taskName: "Task",
      description: "No description",
      cwd: process.cwd(),
    },
  },

  executeStep: {
    template:
      "Execute this step of a coding task:\n\nTask: {taskName}\nStep: {stepDescription}\nPrevious output: {previousOutput}\nWorking directory: {cwd}\n\nUse the available tools to complete this step. Be specific about what actions you take.",
    system: AUTONOMOUS_TASK_SYSTEM_PROMPT,
    defaults: {
      taskName: "Task",
      stepDescription: "Complete the step",
      previousOutput: "None",
      cwd: process.cwd(),
    },
  },
};

/**
 * Format a prompt by replacing {placeholders} with values
 */
export function formatPrompt(
  template: string,
  values: Record<string, string | number | boolean>,
  defaults: Record<string, string> = {},
): string {
  const mergedValues = { ...defaults, ...values };

  return template.replace(/{(\w+)}/g, (match, key) => {
    const value = mergedValues[key];
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Use a predefined prompt template
 */
export function usePromptTemplate(
  templateName: string,
  values: Record<string, string | number | boolean>,
): { prompt: string; system: string } {
  const template = PROMPT_TEMPLATES[templateName];

  if (!template) {
    throw new Error(`Prompt template "${templateName}" not found`);
  }

  return {
    prompt: formatPrompt(template.template, values, template.defaults),
    system: template.system,
  };
}

/**
 * Get the appropriate system prompt for a task type
 */
export function getSystemPromptForTask(taskType: PromptTaskType): string {
  switch (taskType) {
    case "assist":
      return CODE_ASSISTANT_SYSTEM_PROMPT;
    case "generate":
      return CODE_GENERATION_SYSTEM_PROMPT;
    case "review":
      return CODE_REVIEW_SYSTEM_PROMPT;
    case "explain":
      return CODE_EXPLANATION_SYSTEM_PROMPT;
    case "debug":
      return DEBUG_SYSTEM_PROMPT;
    case "autonomous":
      return AUTONOMOUS_TASK_SYSTEM_PROMPT;
    default:
      return CODE_ASSISTANT_SYSTEM_PROMPT;
  }
}

export type PromptTaskType =
  | "assist"
  | "generate"
  | "review"
  | "explain"
  | "debug"
  | "autonomous";

/**
 * Create a file context block for including in prompts
 */
export function createFileContextBlock(
  filePath: string,
  content: string,
  language?: string,
): string {
  const lang = language || getLanguageFromPath(filePath);
  return `File: ${filePath}\n\n\`\`\`${lang}\n${content}\n\`\`\``;
}

/**
 * Get language identifier from file path
 */
function getLanguageFromPath(filePath: string): string {
  const parts = filePath.split(".");
  const extension =
    (parts.length > 0 &&
      parts[parts.length - 1] &&
      parts[parts.length - 1].toLowerCase()) ||
    "";

  const languageMap: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "javascript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    java: "java",
    c: "c",
    cpp: "cpp",
    cs: "csharp",
    go: "go",
    rs: "rust",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    html: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    md: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sql: "sql",
    graphql: "graphql",
    xml: "xml",
    vue: "vue",
    svelte: "svelte",
  };

  return languageMap[extension] || "";
}
