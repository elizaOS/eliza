#!/usr/bin/env bun

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { parseArgs } from 'util';

// Helper to run commands
function runCommand(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        console.log(`\n> ${command} ${args.join(' ')}`);
        const proc = spawn(command, args, {
            cwd,
            stdio: 'inherit',
            shell: true
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with code ${code}`));
            }
        });
    });
}

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            task: { type: 'string', default: 'Write a poem about optimizing code.' },
            rubric: { type: 'string' }, // Optional rubric file
            iterations: { type: 'string', default: '1' },
            epochs: { type: 'string', default: '5' },
        },
    });

    const projectRoot = path.resolve(__dirname, '../../..');

    // 1. Generate Data (Rollout)
    console.log("=== PHASE 1: GENERATE (Rollout) ===");
    await runCommand(
        'bun',
        [
            'packages/training/scripts/run_task_benchmark.ts',
            `--task "${values.task}"`,
            `--iterations ${values.iterations}`
        ],
        projectRoot
    );

    // 2. Rank Data (Evaluation)
    console.log("=== PHASE 2: RANK (Evaluation) ===");
    const rankArgs = ['packages/training/scripts/rank_trajectories.ts'];
    if (values.rubric) {
        rankArgs.push(`--rubric "${values.rubric}"`);
    }
    await runCommand('bun', rankArgs, projectRoot);

    // 3. Train Model (Improvement)
    console.log("=== PHASE 3: TRAIN (Improvement) ===");
    await runCommand(
        'python3',
        [
            'packages/training/python/scripts/train_jsonl.py',
            `--iters ${values.epochs}`,
            // Lower threshold to ensure we pick up something for demo
            `--min-score 0.1`
        ],
        projectRoot
    );

    console.log("\nRLAIF Loop Complete!");
    console.log("New model adapters are in: trained_models/jsonl_run");
}

main().catch(console.error);
