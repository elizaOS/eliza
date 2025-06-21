import { Command } from 'commander';
import { logger } from '@elizaos/core';
import { LLMScenarioGenerator } from '../../scenario-runner/llm-scenario-generator.js';
import { loadProject } from '../../project.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface GenerateScenarioOptions {
  description: string;
  plugins?: string;
  complexity?: 'low' | 'medium' | 'high' | 'very-high';
  testType?: 'functional' | 'integration' | 'security' | 'performance';
  duration?: string;
  actors?: string;
  output?: string;
  enhance?: boolean;
}

export const generateScenarioCommand = new Command('generate')
  .description('Generate a new scenario using AI from natural language description')
  .argument('<description>', 'Natural language description of what to test')
  .option('-p, --plugins <plugins>', 'Comma-separated list of plugins to test')
  .option('-c, --complexity <level>', 'Complexity level: low, medium, high, very-high', 'medium')
  .option(
    '-t, --test-type <type>',
    'Test type: functional, integration, security, performance',
    'functional'
  )
  .option('-d, --duration <seconds>', 'Maximum duration in seconds', '120')
  .option('-a, --actors <count>', 'Number of actors to include', '3')
  .option('-o, --output <path>', 'Output file path for generated scenario')
  .option('--enhance', 'Apply additional AI enhancements to the scenario')
  .action(async (description: string, options: GenerateScenarioOptions) => {
    try {
      await generateScenario(description, options);
    } catch (error) {
      logger.error('Scenario generation failed:', error);
      process.exit(1);
    }
  });

async function generateScenario(
  description: string,
  options: GenerateScenarioOptions
): Promise<void> {
  logger.info('🤖 Generating scenario using AI...');

  // Load project to get runtime
  const project = await loadProject(process.cwd());
  if (!project.agents || project.agents.length === 0) {
    throw new Error('No agents found in project. Create a project with at least one agent first.');
  }

  // Initialize runtime for the first agent
  const { AgentRuntime } = await import('@elizaos/core');
  const sqlModule = await import('@elizaos/plugin-sql');
  const sqlPlugin = sqlModule.plugin;

  const agentWithSqlPlugin = {
    ...project.agents[0],
    plugins: [...(project.agents[0].plugins || []), sqlPlugin],
  };

  const runtime = new AgentRuntime({
    character: project.agents[0].character,
    plugins: agentWithSqlPlugin.plugins,
  });

  await runtime.initialize();

  // Create generator
  const generator = new LLMScenarioGenerator(runtime);

  // Parse options
  const context = {
    plugins: options.plugins?.split(',').map((p) => p.trim()),
    complexity: options.complexity,
    testType: options.testType,
    duration: parseInt(options.duration || '120'),
    actors: parseInt(options.actors || '3'),
  };

  logger.info(`Generating scenario with context: ${JSON.stringify(context, null, 2)}`);

  // Generate scenario
  const scenario = await generator.generateScenario(description, context);

  // Generate actors with diverse personalities
  logger.info('🎭 Generating diverse actor personalities...');
  const actorRoles = ['subject', 'participant', 'tester'];
  const actors = await generator.generateActorPersonalities(
    `${scenario.name}: ${scenario.description}`,
    actorRoles,
    context.complexity
  );
  scenario.actors = actors;

  // Generate comprehensive verification rules
  logger.info('✅ Generating verification rules...');
  const testObjectives = [
    'Core functionality validation',
    'Error handling and edge cases',
    'Performance and efficiency',
    'Security and safety measures',
    'User experience quality',
  ];
  const verificationRules = await generator.generateAdaptiveVerificationRules(
    `${scenario.name}: ${scenario.description}`,
    actors,
    testObjectives
  );
  scenario.verification = {
    ...scenario.verification,
    rules: verificationRules,
  };

  // Apply enhancements if requested
  if (options.enhance) {
    logger.info('🚀 Applying AI enhancements...');
    const enhancements = [
      'Add dynamic response adaptation',
      'Include emergent behavior opportunities',
      'Create conditional complexity scaling',
      'Add real-time scenario modification',
    ];
    const enhancedScenario = await generator.enhanceScenarioWithDynamicElements(
      scenario,
      enhancements
    );
    Object.assign(scenario, enhancedScenario);
  }

  // Generate output
  const scenarioCode = generateScenarioCode(scenario, description);

  // Save to file or display
  if (options.output) {
    const outputPath = path.resolve(options.output);
    await fs.writeFile(outputPath, scenarioCode, 'utf8');
    logger.info(`✨ Scenario saved to: ${outputPath}`);
  } else {
    // Auto-generate filename
    const filename = `generated-${scenario.id}.ts`;
    const outputPath = path.join(process.cwd(), 'scenarios', filename);

    // Ensure scenarios directory exists
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, scenarioCode, 'utf8');
    logger.info(`✨ Scenario saved to: ${outputPath}`);
  }

  // Display summary
  displayScenarioSummary(scenario);
}

function generateScenarioCode(scenario: any, originalDescription: string): string {
  return `import type { Scenario } from '../src/scenario-runner/types.js';

// Generated scenario based on: "${originalDescription}"
// Generated at: ${new Date().toISOString()}

export const ${scenario.id.replace(/-/g, '')}Scenario: Scenario = ${JSON.stringify(scenario, null, 2)};

export default ${scenario.id.replace(/-/g, '')}Scenario;
`;
}

function displayScenarioSummary(scenario: any): void {
  logger.info('\n📋 Generated Scenario Summary:');
  logger.info(`Name: ${scenario.name}`);
  logger.info(`ID: ${scenario.id}`);
  logger.info(`Description: ${scenario.description}`);
  logger.info(`Actors: ${scenario.actors?.length || 0}`);
  logger.info(`Verification Rules: ${scenario.verification?.rules?.length || 0}`);
  logger.info(`Complexity: ${scenario.metadata?.complexity || 'medium'}`);
  logger.info(`Duration: ${scenario.execution?.maxDuration / 1000 || 120}s`);

  if (scenario.actors?.length > 0) {
    logger.info('\n🎭 Actors:');
    scenario.actors.forEach((actor: any) => {
      logger.info(`  - ${actor.name} (${actor.role})`);
    });
  }

  if (scenario.verification?.rules?.length > 0) {
    logger.info('\n✅ Verification Rules:');
    scenario.verification.rules.slice(0, 3).forEach((rule: any) => {
      logger.info(`  - ${rule.description}`);
    });
    if (scenario.verification.rules.length > 3) {
      logger.info(`  ... and ${scenario.verification.rules.length - 3} more`);
    }
  }

  logger.info('\n🚀 Ready to run with: elizaos scenario -s <generated-file>');
}
