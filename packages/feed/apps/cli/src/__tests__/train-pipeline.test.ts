import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { dirname, resolve } from 'path';

const CLI_PATH = resolve(import.meta.dir, '..', 'index.ts');
const CLI_CWD = dirname(dirname(CLI_PATH));

describe('CLI Train Pipeline', () => {
  test('dry-run forwards --no-benchmark to the Python pipeline', () => {
    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--dry-run',
        '--no-benchmark',
      ],
      {
        cwd: CLI_CWD,
      }
    );

    expect(result.exitCode).toBe(0);

    const output = result.stdout.toString();
    expect(output).toContain('Mode: full (no benchmark)');
    expect(output).toContain('--skip-scambench');
  });

  test('dry-run maps --benchmark-only to benchmark mode', () => {
    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--dry-run',
        '--benchmark-only',
      ],
      {
        cwd: CLI_CWD,
      }
    );

    expect(result.exitCode).toBe(0);

    const output = result.stdout.toString();
    expect(output).toContain('Mode: benchmark-only');
    expect(output).toContain('--mode benchmark');
    expect(output).not.toContain('--skip-benchmark');
  });

  test('dry-run forwards --allow-mismatched-reuse', () => {
    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--dry-run',
        '--benchmark-only',
        '--allow-mismatched-reuse',
      ],
      {
        cwd: CLI_CWD,
      }
    );

    expect(result.exitCode).toBe(0);

    const output = result.stdout.toString();
    expect(output).toContain('Allow mismatched reuse: yes');
    expect(output).toContain('--allow-mismatched-reuse');
  });

  test('dry-run respects PYTHON_BIN when provided', () => {
    const result = spawnSync(
      ['bun', 'run', CLI_PATH, 'train', 'pipeline', '--dry-run'],
      {
        cwd: CLI_CWD,
        env: {
          ...process.env,
          PYTHON_BIN: '/custom/python',
        },
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('/custom/python');
  });

  test('dry-run forwards local training and data-loading options', () => {
    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--dry-run',
        '--local-backend',
        'mlx',
        '--local-model',
        'mlx-community/Qwen2.5-0.5B-Instruct-4bit',
        '--local-steps',
        '50',
        '--lookback-hours',
        '168',
        '--max-trajectories',
        '200',
      ],
      {
        cwd: CLI_CWD,
      }
    );

    expect(result.exitCode).toBe(0);

    const output = result.stdout.toString();
    expect(output).toContain('--local-backend mlx');
    expect(output).toContain(
      '--local-model mlx-community/Qwen2.5-0.5B-Instruct-4bit'
    );
    expect(output).toContain('--local-steps 50');
    expect(output).toContain('--lookback-hours 168');
    expect(output).toContain('--max-trajectories 200');
  });

  test('dry-run forwards Tinker backend and Hugging Face dataset options', () => {
    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--dry-run',
        '--training-backend',
        'tinker',
        '--trajectory-source',
        'huggingface',
        '--hf-dataset',
        'elizaos/scambench-trajectories',
        '--hf-split',
        'train',
        '--tinker-steps',
        '250',
        '--tinker-group-size',
        '8',
        '--tinker-lr',
        '0.00004',
        '--tinker-lora-rank',
        '64',
        '--tinker-weight-sync-interval',
        '10',
      ],
      {
        cwd: CLI_CWD,
      }
    );

    expect(result.exitCode).toBe(0);

    const output = result.stdout.toString();
    expect(output).toContain('--training-backend tinker');
    expect(output).toContain('--trajectory-source huggingface');
    expect(output).toContain('--hf-dataset elizaos/scambench-trajectories');
    expect(output).toContain('--hf-split train');
    expect(output).toContain('--tinker-steps 250');
    expect(output).toContain('--tinker-group-size 8');
    expect(output).toContain('--tinker-lr 0.00004');
    expect(output).toContain('--tinker-lora-rank 64');
    expect(output).toContain('--tinker-weight-sync-interval 10');
  });

  test('dry-run forwards RL and ScamBench options', () => {
    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--dry-run',
        '--rl-steps',
        '40',
        '--rl-batch-size',
        '8',
        '--rl-lr',
        '0.00002',
        '--reward-profile',
        'trust_blue',
        '--skip-rl',
        '--skip-scambench',
      ],
      {
        cwd: CLI_CWD,
      }
    );

    expect(result.exitCode).toBe(0);

    const output = result.stdout.toString();
    expect(output).toContain('--skip-rl');
    expect(output).toContain('--skip-scambench');
    expect(output).toContain('--rl-steps 40');
    expect(output).toContain('--rl-batch-size 8');
    expect(output).toContain('--rl-lr 0.00002');
    expect(output).toContain('--reward-profile trust_blue');
  });

  test('rejects conflicting benchmark flags', () => {
    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--dry-run',
        '--benchmark-only',
        '--no-benchmark',
      ],
      {
        cwd: CLI_CWD,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      '--no-benchmark and --benchmark-only cannot be used together'
    );
  });

  test('fails fast when DATABASE_URL is missing outside dry-run', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;

    const result = spawnSync(['bun', 'run', CLI_PATH, 'train', 'pipeline'], {
      cwd: CLI_CWD,
      env,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'DATABASE_URL is required for babylon train pipeline unless trajectory-source=huggingface'
    );
  });

  test('allows Hugging Face trajectory source without DATABASE_URL', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    env.PYTHON_BIN = '/usr/bin/true';

    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--trajectory-source',
        'huggingface',
        '--hf-dataset',
        'elizaos/scambench-trajectories',
      ],
      {
        cwd: CLI_CWD,
        env,
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).not.toContain('DATABASE_URL is required');
  });

  test('allows local_export trajectory source without DATABASE_URL and forwards source-dir', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    env.PYTHON_BIN = '/usr/bin/true';

    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--dry-run',
        '--trajectory-source',
        'local_export',
        '--source-dir',
        '/tmp/scambench-export',
      ],
      {
        cwd: CLI_CWD,
        env,
      }
    );

    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('Trajectory source: local_export');
    expect(output).toContain('--trajectory-source local_export');
    expect(output).toContain('--source-dir /tmp/scambench-export');
    expect(result.stderr.toString()).not.toContain('DATABASE_URL is required');
  });

  test('fails fast when local_export is requested without source-dir', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;

    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--trajectory-source',
        'local_export',
      ],
      {
        cwd: CLI_CWD,
        env,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'source-dir is required for babylon train pipeline with trajectory-source=local_export'
    );
  });

  test('fails fast when Tinker backend is requested without TINKER_API_KEY', () => {
    const env = { ...process.env };
    delete env.TINKER_API_KEY;
    env.DATABASE_URL = 'postgresql://example';

    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--training-backend',
        'tinker',
      ],
      {
        cwd: CLI_CWD,
        env,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'TINKER_API_KEY is required for babylon train pipeline with --training-backend=tinker'
    );
  });

  test('benchmark-only does not require DATABASE_URL', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;

    const result = spawnSync(
      [
        'bun',
        'run',
        CLI_PATH,
        'train',
        'pipeline',
        '--dry-run',
        '--benchmark-only',
      ],
      {
        cwd: CLI_CWD,
        env,
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).not.toContain('DATABASE_URL is required');
  });
});
