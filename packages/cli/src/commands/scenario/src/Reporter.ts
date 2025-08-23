import { Scenario } from './schema';
import { ExecutionResult } from './providers';
import { EvaluationResult } from './EvaluationEngine';
import chalk from 'chalk';

export class Reporter {
  public reportStart(scenario: Scenario) {
    console.log(chalk.bold.cyan(`\n▶️ RUNNING SCENARIO: ${scenario.name}`));
    console.log(chalk.gray(`  ${scenario.description}\n`));
  }

  public reportExecutionResult(result: ExecutionResult) {
    console.log(chalk.bold('--- Execution Output ---'));
    if (result.stdout) {
      console.log(chalk.green('STDOUT:'));
      console.log(
        result.stdout
          .trim()
          .split('\n')
          .map((l) => `  | ${l}`)
          .join('\n')
      );
    }
    if (result.stderr) {
      console.log(chalk.yellow('STDERR:'));
      console.log(
        result.stderr
          .trim()
          .split('\n')
          .map((l) => `  | ${l}`)
          .join('\n')
      );
    }
    console.log(chalk.bold('------------------------\n'));
  }

  public reportEvaluationResults(results: EvaluationResult[]) {
    console.log(chalk.bold('--- Evaluation Results ---'));
    if (results.length === 0) {
      console.log(chalk.gray('  No evaluations were run.'));
    }
    results.forEach((res) => {
      const status = res.success ? chalk.green('✅ PASS') : chalk.red('❌ FAIL');
      console.log(`${status}: ${res.message}`);
    });
    console.log(chalk.bold('------------------------\n'));
  }

  public reportFinalResult(finalSuccess: boolean) {
    const finalStatus = finalSuccess ? chalk.bold.green('✅ PASS') : chalk.bold.red('❌ FAIL');

    console.log(chalk.bold.cyan(`SCENARIO STATUS: ${finalStatus}`));
  }
}
