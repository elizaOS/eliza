import { type Command } from 'commander';
import { elizaLogger } from '@elizaos/core';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function testFineTunedCommand(program: Command) {
  program
    .command('test-fine-tuned')
    .description('Test fine-tuned model against base model with ElizaOS prompts')
    .requiredOption('-k, --api-key <key>', 'Together.ai API key')
    .requiredOption('-m, --model <model>', 'Fine-tuned model name to test')
    .option(
      '-b, --base-model <model>',
      'Base model for comparison',
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B'
    )
    .option('-o, --output <file>', 'Save comparison results to file', 'test-results.json')
    .action(async (options) => {
      try {
        const { apiKey, model, baseModel, output } = options;

        elizaLogger.info('🧪 Fine-tuned Model Testing Suite');
        elizaLogger.info('═'.repeat(60));
        elizaLogger.info(`🎯 Fine-tuned: ${model}`);
        elizaLogger.info(`📊 Base model: ${baseModel}`);
        elizaLogger.info('─'.repeat(60));

        // Test prompts specifically for ElizaOS development
        const testPrompts = [
          {
            name: 'Discord Plugin Creation',
            prompt:
              'Create a Discord plugin for ElizaOS that responds to mentions with personalized greetings based on user history.',
          },
          {
            name: 'Twitter Integration',
            prompt:
              'Build an ElizaOS plugin that monitors Twitter mentions and automatically responds with contextual replies.',
          },
          {
            name: 'Database Action',
            prompt:
              'Create an ElizaOS action that stores user preferences in a database and retrieves them in future conversations.',
          },
          {
            name: 'Blockchain Provider',
            prompt:
              'Design an ElizaOS provider that fetches real-time crypto prices and wallet balances for Solana.',
          },
          {
            name: 'Complex Workflow',
            prompt:
              'Build an ElizaOS plugin with actions, providers, and evaluators that manages a complete project workflow from task creation to completion tracking.',
          },
        ];

        const results = {
          timestamp: new Date().toISOString(),
          fineTunedModel: model,
          baseModel,
          testResults: [] as any[],
        };

        for (let i = 0; i < testPrompts.length; i++) {
          const testCase = testPrompts[i];
          elizaLogger.info(`\n🔬 Test ${i + 1}/${testPrompts.length}: ${testCase.name}`);
          elizaLogger.info('─'.repeat(40));

          // Test fine-tuned model
          elizaLogger.info('🎯 Testing fine-tuned model...');
          const fineStartTime = Date.now();
          const fineResponse = await testModelInference(apiKey, model, testCase.prompt);
          const fineDuration = Date.now() - fineStartTime;

          // Test base model
          elizaLogger.info('📊 Testing base model...');
          const baseStartTime = Date.now();
          const baseResponse = await testModelInference(apiKey, baseModel, testCase.prompt);
          const baseDuration = Date.now() - baseStartTime;

          // Analyze responses
          const analysis = analyzeResponses(fineResponse, baseResponse, testCase.prompt);

          const testResult = {
            testName: testCase.name,
            prompt: testCase.prompt,
            fineTuned: {
              response: fineResponse,
              duration: fineDuration,
              score: analysis.fineScore,
            },
            base: {
              response: baseResponse,
              duration: baseDuration,
              score: analysis.baseScore,
            },
            analysis: analysis.analysis,
            winner: analysis.winner,
          };

          results.testResults.push(testResult);

          // Display summary
          elizaLogger.info(`✅ Fine-tuned: ${analysis.fineScore}/10 (${fineDuration}ms)`);
          elizaLogger.info(`📊 Base model: ${analysis.baseScore}/10 (${baseDuration}ms)`);
          elizaLogger.info(`🏆 Winner: ${analysis.winner}`);
          elizaLogger.info(`💭 Analysis: ${analysis.analysis}`);
        }

        // Overall summary
        elizaLogger.info('\n🏁 FINAL RESULTS');
        elizaLogger.info('═'.repeat(60));

        const avgFineScore =
          results.testResults.reduce((sum, r) => sum + r.fineTuned.score, 0) /
          results.testResults.length;
        const avgBaseScore =
          results.testResults.reduce((sum, r) => sum + r.base.score, 0) /
          results.testResults.length;
        const fineWins = results.testResults.filter((r) => r.winner === 'Fine-tuned').length;
        const baseWins = results.testResults.filter((r) => r.winner === 'Base').length;
        const ties = results.testResults.filter((r) => r.winner === 'Tie').length;

        elizaLogger.info(`🎯 Fine-tuned average: ${avgFineScore.toFixed(1)}/10`);
        elizaLogger.info(`📊 Base model average: ${avgBaseScore.toFixed(1)}/10`);
        elizaLogger.info(`🏆 Wins: Fine-tuned ${fineWins}, Base ${baseWins}, Ties ${ties}`);

        const improvement = (((avgFineScore - avgBaseScore) / avgBaseScore) * 100).toFixed(1);
        elizaLogger.info(`📈 Improvement: ${improvement}%`);

        // Save results
        await fs.writeFile(output, JSON.stringify(results, null, 2));
        elizaLogger.info(`\n💾 Results saved to: ${output}`);

        // Recommendations
        elizaLogger.info('\n💡 Recommendations:');
        if (avgFineScore > avgBaseScore) {
          elizaLogger.info(
            '✅ Fine-tuning successful! Model shows improvement in ElizaOS development tasks.'
          );
          elizaLogger.info('🚀 Ready for production deployment.');
        } else {
          elizaLogger.info('⚠️ Fine-tuning needs improvement. Consider:');
          elizaLogger.info('   - More training data');
          elizaLogger.info('   - Better quality examples');
          elizaLogger.info('   - Longer training duration');
        }
      } catch (error) {
        elizaLogger.error(
          '❌ Testing failed:',
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}

async function testModelInference(apiKey: string, model: string, prompt: string): Promise<string> {
  try {
    // Use Together.ai CLI completions command - prompt is the last argument
    const result = await execAsync(
      `TOGETHER_API_KEY="${apiKey}" together completions --model "${model}" --max-tokens 800 --temperature 0.1 "${prompt.replace(/"/g, '\\"')}"`,
      { timeout: 60000 }
    );

    return result.stdout.trim();
  } catch (error) {
    throw new Error(
      `Inference failed for ${model}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function analyzeResponses(
  fineResponse: string,
  baseResponse: string,
  prompt: string
): {
  fineScore: number;
  baseScore: number;
  analysis: string;
  winner: 'Fine-tuned' | 'Base' | 'Tie';
} {
  // Scoring criteria for ElizaOS development
  const _criteria = [
    { name: 'Code Structure', weight: 0.25 },
    { name: 'ElizaOS Patterns', weight: 0.3 },
    { name: 'Completeness', weight: 0.2 },
    { name: 'Best Practices', weight: 0.15 },
    { name: 'Documentation', weight: 0.1 },
  ];

  const fineScore = scoreResponse(fineResponse, prompt);
  const baseScore = scoreResponse(baseResponse, prompt);

  let winner: 'Fine-tuned' | 'Base' | 'Tie';
  if (fineScore > baseScore + 0.5) {
    winner = 'Fine-tuned';
  } else if (baseScore > fineScore + 0.5) {
    winner = 'Base';
  } else {
    winner = 'Tie';
  }

  const analysis = generateAnalysis(fineResponse, baseResponse, fineScore, baseScore);

  return {
    fineScore: Math.round(fineScore * 10) / 10,
    baseScore: Math.round(baseScore * 10) / 10,
    analysis,
    winner,
  };
}

function scoreResponse(response: string, prompt: string): number {
  let score = 5; // Base score

  // Check for ElizaOS-specific patterns
  const elizaPatterns = [
    'Plugin',
    'Action',
    'Provider',
    'Evaluator',
    'IAgentRuntime',
    'handler',
    'validate',
    'export',
    'import.*@elizaos',
    'runtime\\.',
    'memory',
    'state',
    'character',
  ];

  let patternMatches = 0;
  elizaPatterns.forEach((pattern) => {
    if (new RegExp(pattern, 'i').test(response)) {
      patternMatches++;
    }
  });

  // Bonus for ElizaOS patterns (0-2 points)
  score += Math.min(2, patternMatches / 3);

  // Check code structure
  if (response.includes('export') && response.includes('interface')) {
    score += 0.5;
  }
  if (response.includes('async') && response.includes('await')) {
    score += 0.5;
  }
  if (response.includes('try') && response.includes('catch')) {
    score += 0.5;
  }

  // Check completeness
  const codeBlocks = (response.match(/```/g) || []).length / 2;
  if (codeBlocks >= 1) {
    score += 1;
  }
  if (codeBlocks >= 2) {
    score += 0.5;
  }

  // Check for good practices
  if (response.includes('type') || response.includes('interface')) {
    score += 0.5;
  }
  if (response.includes('// ') || response.includes('* ')) {
    score += 0.3;
  }

  // Penalty for incomplete or broken code
  if (response.includes('...') || response.includes('TODO')) {
    score -= 0.5;
  }
  if (response.length < 200) {
    score -= 1;
  }

  return Math.max(0, Math.min(10, score));
}

function generateAnalysis(
  fineResponse: string,
  baseResponse: string,
  fineScore: number,
  baseScore: number
): string {
  const analyses = [];

  if (fineScore > baseScore) {
    analyses.push('Fine-tuned model shows better ElizaOS pattern recognition');
  }

  if (fineResponse.length > baseResponse.length * 1.2) {
    analyses.push('Fine-tuned provides more detailed implementation');
  }

  if (baseScore > fineScore) {
    analyses.push('Base model maintains competitive performance');
  }

  const finePatterns = (fineResponse.match(/Plugin|Action|Provider|runtime/gi) || []).length;
  const basePatterns = (baseResponse.match(/Plugin|Action|Provider|runtime/gi) || []).length;

  if (finePatterns > basePatterns) {
    analyses.push('Fine-tuned uses more ElizaOS-specific terminology');
  }

  return analyses.length > 0
    ? `${analyses.join('. ')}.`
    : 'Both models show similar performance characteristics.';
}
