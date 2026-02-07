import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  ProseCompileOptions,
  ProseCompileResult,
  ProseConfig,
  ProseRunOptions,
  ProseRunResult,
  ProseSkillFile,
  ProseStateMode,
} from "../types";

// Embedded skill content (loaded at init time)
let skillContent: Map<string, string> = new Map();

const DEFAULT_CONFIG: ProseConfig = {
  workspaceDir: ".prose",
  defaultStateMode: "filesystem",
};

/**
 * Generates a unique run ID in format YYYYMMDD-HHMMSS-random6
 */
function generateRunId(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
  const random = Math.random().toString(36).substring(2, 8);
  return `${dateStr}-${timeStr}-${random}`;
}

/**
 * Service for OpenProse VM operations
 */
export class ProseService {
  private config: ProseConfig;
  private runtime: IAgentRuntime;
  private skillsDir: string | null = null;

  constructor(runtime: IAgentRuntime, config?: Partial<ProseConfig>) {
    this.runtime = runtime;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the service by locating skill files
   */
  async init(skillsDir?: string): Promise<void> {
    if (skillsDir) {
      this.skillsDir = skillsDir;
      await this.loadSkillFiles(skillsDir);
    }
    logger.info("[ProseService] Initialized");
  }

  /**
   * Load skill files from a directory
   */
  private async loadSkillFiles(baseDir: string): Promise<void> {
    const files = [
      "SKILL.md",
      "prose.md",
      "help.md",
      "compiler.md",
      "state/filesystem.md",
      "state/in-context.md",
      "state/sqlite.md",
      "state/postgres.md",
      "guidance/patterns.md",
      "guidance/antipatterns.md",
      "primitives/session.md",
    ];

    for (const file of files) {
      const filePath = path.join(baseDir, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        skillContent.set(file, content);
        logger.debug(`[ProseService] Loaded skill file: ${file}`);
      } catch {
        logger.debug(`[ProseService] Skill file not found: ${file}`);
      }
    }
  }

  /**
   * Get the VM specification (prose.md)
   */
  getVMSpec(): string | undefined {
    return skillContent.get("prose.md");
  }

  /**
   * Get the skill description (SKILL.md)
   */
  getSkillSpec(): string | undefined {
    return skillContent.get("SKILL.md");
  }

  /**
   * Get the help documentation
   */
  getHelp(): string | undefined {
    return skillContent.get("help.md");
  }

  /**
   * Get the compiler/validation spec
   */
  getCompilerSpec(): string | undefined {
    return skillContent.get("compiler.md");
  }

  /**
   * Get state management spec for a given mode
   */
  getStateSpec(mode: ProseStateMode): string | undefined {
    const filename =
      mode === "filesystem"
        ? "state/filesystem.md"
        : mode === "in-context"
          ? "state/in-context.md"
          : mode === "sqlite"
            ? "state/sqlite.md"
            : mode === "postgres"
              ? "state/postgres.md"
              : null;

    return filename ? skillContent.get(filename) : undefined;
  }

  /**
   * Get authoring guidance (patterns and antipatterns)
   */
  getAuthoringGuidance(): { patterns?: string; antipatterns?: string } {
    return {
      patterns: skillContent.get("guidance/patterns.md"),
      antipatterns: skillContent.get("guidance/antipatterns.md"),
    };
  }

  /**
   * Get all loaded skill files
   */
  getLoadedSkills(): ProseSkillFile[] {
    const result: ProseSkillFile[] = [];
    for (const [name, content] of skillContent) {
      result.push({ name, path: name, content });
    }
    return result;
  }

  /**
   * Check if a .prose file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a .prose file
   */
  async readProseFile(filePath: string): Promise<string> {
    return await fs.readFile(filePath, "utf-8");
  }

  /**
   * Create the workspace directory structure
   */
  async ensureWorkspace(baseDir = "."): Promise<string> {
    const workspaceDir = path.join(baseDir, this.config.workspaceDir || ".prose");

    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "runs"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "agents"), { recursive: true });

    return workspaceDir;
  }

  /**
   * Create a new run directory
   */
  async createRunDirectory(
    workspaceDir: string,
    programContent: string
  ): Promise<{ runId: string; runDir: string }> {
    const runId = generateRunId();
    const runDir = path.join(workspaceDir, "runs", runId);

    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(path.join(runDir, "bindings"), { recursive: true });
    await fs.mkdir(path.join(runDir, "agents"), { recursive: true });
    await fs.mkdir(path.join(runDir, "imports"), { recursive: true });

    // Write the program copy
    await fs.writeFile(path.join(runDir, "program.prose"), programContent);

    // Initialize state.md
    const initialState = `# Run State

run_id: ${runId}
status: initializing
position: 0

## Program

\`\`\`prose
${programContent}
\`\`\`

## Execution Log

| Time | Position | Action | Status |
|------|----------|--------|--------|
`;
    await fs.writeFile(path.join(runDir, "state.md"), initialState);

    return { runId, runDir };
  }

  /**
   * List available example programs
   */
  async listExamples(): Promise<string[]> {
    if (!this.skillsDir) {
      return [];
    }

    const examplesDir = path.join(this.skillsDir, "examples");
    try {
      const files = await fs.readdir(examplesDir);
      return files.filter((f) => f.endsWith(".prose")).sort();
    } catch {
      return [];
    }
  }

  /**
   * Read an example program
   */
  async readExample(name: string): Promise<string | null> {
    if (!this.skillsDir) {
      return null;
    }

    const examplesDir = path.join(this.skillsDir, "examples");
    const filePath = path.join(examplesDir, name.endsWith(".prose") ? name : `${name}.prose`);

    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Build the VM context for the agent
   * This assembles the context that makes the agent "become" the OpenProse VM
   */
  buildVMContext(
    options: {
      stateMode?: ProseStateMode;
      includeCompiler?: boolean;
      includeGuidance?: boolean;
    } = {}
  ): string {
    const { stateMode = "filesystem", includeCompiler = false, includeGuidance = false } = options;

    const parts: string[] = [];

    // VM banner
    parts.push(`┌─────────────────────────────────────┐
│         ◇ OpenProse VM ◇            │
│       A new kind of computer        │
└─────────────────────────────────────┘`);

    // Core VM spec
    const vmSpec = this.getVMSpec();
    if (vmSpec) {
      parts.push("\n## VM Specification\n");
      parts.push(vmSpec);
    }

    // State management spec
    const stateSpec = this.getStateSpec(stateMode);
    if (stateSpec) {
      parts.push(`\n## State Management (${stateMode})\n`);
      parts.push(stateSpec);
    }

    // Compiler spec if needed
    if (includeCompiler) {
      const compilerSpec = this.getCompilerSpec();
      if (compilerSpec) {
        parts.push("\n## Compiler/Validator\n");
        parts.push(compilerSpec);
      }
    }

    // Authoring guidance if needed
    if (includeGuidance) {
      const guidance = this.getAuthoringGuidance();
      if (guidance.patterns) {
        parts.push("\n## Authoring Patterns\n");
        parts.push(guidance.patterns);
      }
      if (guidance.antipatterns) {
        parts.push("\n## Authoring Antipatterns\n");
        parts.push(guidance.antipatterns);
      }
    }

    return parts.join("\n");
  }
}

/**
 * Factory function to create a ProseService instance
 */
export function createProseService(
  runtime: IAgentRuntime,
  config?: Partial<ProseConfig>
): ProseService {
  return new ProseService(runtime, config);
}

/**
 * Set embedded skill content (for bundled deployment)
 */
export function setSkillContent(skills: Map<string, string>): void {
  skillContent = skills;
}

/**
 * Get all skill content
 */
export function getSkillContent(): Map<string, string> {
  return skillContent;
}
