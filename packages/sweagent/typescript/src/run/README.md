# SWE-agent Run Module (TypeScript)

This module has been converted from Python to TypeScript and provides the core functionality for running SWE-agent on single instances or batches of instances.

## Structure

```
src/run/
├── hooks/              # Run hooks for extending functionality
│   ├── types.ts       # Hook interfaces and base classes
│   ├── apply-patch.ts # Hook for saving/applying patches
│   ├── open-pr.ts     # Hook for opening GitHub PRs
│   └── swe-bench-evaluate.ts # Hook for SWE-bench evaluation
├── batch-instances.ts  # Batch instance management
├── cli.ts             # Command-line interface
├── common.ts          # Common utilities
├── compare-runs.ts    # Compare run results
├── merge-predictions.ts # Merge prediction files
├── progress.ts        # Progress management for batch runs
├── quick-stats.ts     # Calculate statistics from trajectories
├── remove-unfinished.ts # Remove incomplete trajectories
├── run-batch.ts       # Run on batches of instances
├── run-replay.ts      # Replay trajectory files
├── run-single.ts      # Run on single instances
└── index.ts           # Main exports

```

## Features

### Single Run (`run-single.ts`)
- Run SWE-agent on a single problem statement (e.g., GitHub issue)
- Support for various repository sources (GitHub, local, pre-existing)
- Configurable actions (open PR, apply patch locally)

### Batch Run (`run-batch.ts`)
- Run SWE-agent on multiple instances (e.g., SWE-bench dataset)
- Support for parallel execution with worker threads
- Progress tracking and exit status reporting
- Instance filtering, slicing, and shuffling

### Run Replay (`run-replay.ts`)
- Replay previously recorded trajectories
- Useful for debugging and creating demonstrations
- Support for updating configurations during replay

### Hooks System
- Extensible hook system for customizing run behavior
- Built-in hooks for:
  - Saving and applying patches
  - Opening GitHub pull requests
  - SWE-bench evaluation
- Easy to add custom hooks by implementing the `RunHook` interface

### Utilities
- **merge-predictions.ts**: Combine multiple prediction files
- **compare-runs.ts**: Compare results across multiple runs
- **quick-stats.ts**: Generate statistics from trajectory files
- **remove-unfinished.ts**: Clean up incomplete trajectories
- **progress.ts**: Progress tracking for batch runs

## Usage

### Command Line Interface

```bash
# Run on a single GitHub issue
sweagent run --agent.model.name gpt-4 \
  --env.repo.github_url https://github.com/user/repo \
  --problem_statement.github_url https://github.com/user/repo/issues/1

# Run on a batch of instances
sweagent run-batch --instances.type swe_bench \
  --instances.subset lite \
  --instances.split dev \
  --agent.model.name gpt-4

# Replay a trajectory
sweagent run-replay --traj_path path/to/trajectory.traj

# Merge predictions
sweagent merge-preds dir1 dir2 --output merged.json

# Compare runs
sweagent compare-runs run1/results.json run2/results.json
```

### Programmatic Usage

```typescript
import { RunSingle, RunBatch, RunReplay } from '@swe-agent/run';

// Single run
const runSingle = RunSingle.fromConfig({
  agent: { model: { name: 'gpt-4' } },
  env: { repo: { type: 'github', githubUrl: 'https://...' } },
  problemStatement: { type: 'github', githubUrl: 'https://...' }
});
await runSingle.run();

// Batch run
const runBatch = RunBatch.fromConfig({
  instances: { type: 'swe_bench', subset: 'lite' },
  agent: { model: { name: 'gpt-4' } }
});
await runBatch.main();
```

## Migration Notes

This module has been converted from Python to TypeScript with the following considerations:

1. **Async/Await**: All I/O operations use async/await patterns
2. **Type Safety**: Full TypeScript type definitions for all interfaces
3. **Zod Schemas**: Configuration validation using Zod schemas
4. **Node.js APIs**: File system operations use Node.js fs module
5. **Commander.js**: CLI implementation using Commander.js instead of argparse

Some features that may require additional implementation:
- Full parallel execution in batch runs (would need Worker Threads)
- HuggingFace datasets integration (needs Node.js library)
- Terminal-based trajectory inspector (needs terminal UI library)

## Dependencies

- `commander`: CLI framework
- `zod`: Schema validation
- `js-yaml`: YAML parsing
- `@octokit/rest`: GitHub API client
- `axios`: HTTP client

## Building

```bash
cd src/run
npm install
npm run build
```

## Testing

Tests should be added for all major functionality. Run tests with:

```bash
npm test
```
