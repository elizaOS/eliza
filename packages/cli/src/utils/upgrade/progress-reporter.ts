import { SDKMessage } from '@anthropic-ai/claude-code';
import chalk from 'chalk';
import { GateResult } from './types';

export class MigrationProgressReporter {
  private gates = [
    { icon: '🌿', name: 'Branch Creation' },
    { icon: '🔍', name: 'Complete Analysis' },
    { icon: '🛠️', name: 'Initial Setup' },
    { icon: '🏗️', name: 'Build Must Pass' },
    { icon: '📝', name: 'TypeScript Check' },
    { icon: '🔄', name: 'Code Migration' },
    { icon: '🧪', name: 'Test Implementation' },
    { icon: '✨', name: 'Final Setup' },
    { icon: '✅', name: 'Verification' },
  ];

  private gateStatus: Map<number, 'pending' | 'running' | 'passed' | 'failed'> = new Map();
  private currentGate: number = -1;
  private currentActivity: string = '';
  private stats = {
    filesModified: 0,
    testsCreated: 0,
    coverage: 0,
    turnsUsed: 0,
    costUSD: 0,
    duration: 0,
  };
  private startTime = Date.now();

  constructor() {
    // Initialize all gates as pending
    for (let i = 0; i < this.gates.length; i++) {
      this.gateStatus.set(i, 'pending');
    }
  }

  onGateStart(gateIndex: number, _gateName: string) {
    this.currentGate = gateIndex;
    this.gateStatus.set(gateIndex, 'running');
  }

  onGateComplete(gateIndex: number, success: boolean, result: GateResult) {
    this.gateStatus.set(gateIndex, success ? 'passed' : 'failed');

    // Update stats from result
    if (result.messages.length > 0) {
      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage.type === 'result' && 'total_cost_usd' in lastMessage) {
        this.stats.costUSD += lastMessage.total_cost_usd;
        this.stats.turnsUsed += lastMessage.num_turns;
      }
    }
  }

  onMessage(message: SDKMessage, _gateIndex: number) {
    if (message.type === 'assistant') {
      const text = this.extractText(message);

      // Track activities
      if (text.includes('Creating') || text.includes('Writing')) {
        if (text.includes('test')) {
          this.stats.testsCreated++;
        }
      }

      if (text.includes('Modifying') || text.includes('Updating')) {
        this.stats.filesModified++;
      }

      // Extract current activity
      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length > 0) {
        const firstLine = lines[0];
        if (firstLine.length < 80) {
          this.currentActivity = firstLine;
        }
      }
    }
  }

  updateCoverage(coverage: number) {
    this.stats.coverage = coverage;
  }

  render() {
    // Clear console and render progress
    console.clear();

    // Header
    console.log(chalk.bold.cyan('\n🚀 ElizaOS Plugin Migration Progress\n'));

    // Progress bar
    const completedGates = Array.from(this.gateStatus.values()).filter(
      (status) => status === 'passed'
    ).length;
    const progress = (completedGates / this.gates.length) * 100;
    const filled = Math.floor(progress / 2);
    const bar = '█'.repeat(filled) + '░'.repeat(50 - filled);
    console.log(`Progress: [${chalk.cyan(bar)}] ${chalk.bold(progress.toFixed(1))}%\n`);

    // Gates table
    console.log(chalk.bold('Migration Gates:\n'));
    this.gates.forEach((gate, index) => {
      const status = this.gateStatus.get(index) || 'pending';
      const color = this.getStatusColor(status);
      const icon = this.getStatusIcon(status);
      const isCurrentGate = index === this.currentGate && status === 'running';

      const line = `  ${icon} ${gate.icon} ${gate.name}`;

      if (isCurrentGate) {
        console.log(chalk.bold(color(line + ' ⟵')));
      } else {
        console.log(color(line));
      }
    });

    // Current activity
    if (this.currentActivity && this.currentGate >= 0) {
      console.log(chalk.bold('\n📍 Current Activity:'));
      console.log(chalk.gray(`   ${this.currentActivity}`));
    }

    // Live stats
    console.log(chalk.bold('\n📊 Live Statistics:'));
    console.log(`   Files Modified: ${chalk.yellow(this.stats.filesModified)}`);
    console.log(`   Tests Created: ${chalk.green(this.stats.testsCreated)}`);
    if (this.stats.coverage > 0) {
      const coverageColor = this.stats.coverage >= 95 ? chalk.green : chalk.yellow;
      console.log(`   Test Coverage: ${coverageColor(this.stats.coverage + '%')}`);
    }
    console.log(`   API Turns: ${chalk.blue(this.stats.turnsUsed)}`);
    console.log(`   Est. Cost: ${chalk.magenta('$' + this.stats.costUSD.toFixed(3))}`);

    // Duration
    const duration = Math.floor((Date.now() - this.startTime) / 1000);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    console.log(`   Duration: ${chalk.cyan(`${minutes}m ${seconds}s`)}`);

    // Tips
    if (this.currentGate >= 0 && this.currentGate < 5) {
      console.log(chalk.dim('\n💡 Tip: Initial setup gates are usually quick...'));
    } else if (this.currentGate === 5) {
      console.log(chalk.dim('\n💡 Tip: Code migration may take several minutes...'));
    } else if (this.currentGate === 6) {
      console.log(chalk.dim('\n💡 Tip: Writing comprehensive tests for 95% coverage...'));
    }
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case 'pending':
        return '⏳';
      case 'running':
        return '🔄';
      case 'passed':
        return '✅';
      case 'failed':
        return '❌';
      default:
        return '❓';
    }
  }

  private getStatusColor(status: string) {
    switch (status) {
      case 'pending':
        return chalk.gray;
      case 'running':
        return chalk.yellow;
      case 'passed':
        return chalk.green;
      case 'failed':
        return chalk.red;
      default:
        return chalk.white;
    }
  }

  private extractText(message: SDKMessage): string {
    if (message.type === 'assistant' && message.message.content) {
      return message.message.content
        .filter((block) => block.type === 'text')
        .map((block) => ('text' in block ? block.text : ''))
        .join('');
    }
    return '';
  }
}
