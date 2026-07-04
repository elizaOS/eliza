#!/usr/bin/env bun
/**
 * CLI wrapper around the memory-benchmark service: loads a local model (optionally
 * the installed default) and measures peak RSS across a generation run, printing a
 * summary or JSON report. Tracks the on-device memory budget for Eliza-1 tiers.
 */
import {
	runMemoryBenchmark,
	summarizeMemoryBenchmark,
} from "../src/services/memory-benchmark";

interface Args {
	loadInstalled: boolean;
	json: boolean;
	outFile?: string;
	prompt?: string;
	maxTokens?: number;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { loadInstalled: false, json: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case "--load":
				args.loadInstalled = true;
				break;
			case "--json":
				args.json = true;
				break;
			case "--out":
				args.outFile = argv[++i];
				break;
			case "--prompt":
				args.prompt = argv[++i];
				break;
			case "--max-tokens": {
				const value = Number(argv[++i]);
				if (!Number.isInteger(value) || value <= 0) {
					throw new Error("--max-tokens must be a positive integer");
				}
				args.maxTokens = value;
				break;
			}
			case "--help":
			case "-h":
				console.log(
					[
						"Usage: bun run scripts/memory-benchmark.ts [options]",
						"",
						"Options:",
						"  --load              Load each installed Eliza-1 bundle and run a short decode",
						"  --json              Print the full JSON report",
						"  --out PATH          Write the JSON report to PATH",
						"  --prompt TEXT       Prompt used for --load decode sampling",
						"  --max-tokens N      Decode token cap for --load (default 32)",
					].join("\n"),
				);
				process.exit(0);
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const report = await runMemoryBenchmark(args);
console.log(args.json ? JSON.stringify(report, null, 2) : summarizeMemoryBenchmark(report));
