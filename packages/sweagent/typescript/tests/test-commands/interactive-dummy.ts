#!/usr/bin/env node
/**
 * Interactive dummy command for testing
 * Converted from tests/test_commands/_interactive_dummy.py
 */

import * as readline from 'readline';

export class InteractiveDummyCommand {
  private static readonly PROMPT = '(dummy) ';
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: InteractiveDummyCommand.PROMPT,
    });
  }

  start(): void {
    console.log('Started interactive dummy command');
  }

  send(input: string): void {
    console.log(`Received input: ${input}`);
    // Simulate processing delay
    setTimeout(() => {}, 500);
  }

  stop(): void {
    console.log('Stopped interactive dummy command');
    this.rl.close();
  }

  run(): void {
    this.start();

    this.rl.prompt();

    this.rl.on('line', (line: string) => {
      const [cmd, ...args] = line.trim().split(' ');

      switch (cmd) {
        case 'stop':
          this.stop();
          process.exit(0);
          break;

        case 'send':
          this.send(args.join(' '));
          break;

        default:
          if (cmd) {
            console.log(`Unknown command: ${cmd}`);
          }
          break;
      }

      this.rl.prompt();
    });

    this.rl.on('close', () => {
      process.exit(0);
    });
  }
}

// Run if called directly
if (require.main === module) {
  const command = new InteractiveDummyCommand();
  command.run();
}
