/**
 * Batch instance handling
 * Converted from sweagent/run/batch_instances.py
 */

import path from 'path';
import fs from 'fs';
import { EnvironmentConfig } from '../environment/swe-env';
import {
  ProblemStatementConfig,
  TextProblemStatement,
  SWEBenchMultimodalProblemStatement,
} from '../agent/problem-statement';
import { DeploymentConfig } from '../environment/deployment';
import { BatchInstanceSourceConfig } from './types';
export { BatchInstanceSourceConfig } from './types';

/**
 * Abstract instance source
 */
export abstract class AbstractInstanceSource {
  abstract getInstanceConfigs(): BatchInstance[];
  abstract get id(): string;
}

/**
 * A single instance in a batch
 */
export interface BatchInstance {
  env: EnvironmentConfig;
  problemStatement: ProblemStatementConfig;
}

/**
 * Simple batch instance for benchmarking
 */
export interface SimpleBatchInstance {
  imageName: string;
  problemStatement: string;
  instanceId: string;
  repoName?: string;
  baseCommit?: string;
  extraFields?: Record<string, unknown>;
}

/**
 * Convert simple instance to full batch instance
 */
export function simpleToFullBatchInstance(simple: SimpleBatchInstance, deployment: DeploymentConfig): BatchInstance {
  // Create problem statement
  let problemStatement: ProblemStatementConfig;

  if (simple.extraFields?.issueImages && Array.isArray(simple.extraFields.issueImages)) {
    problemStatement = new SWEBenchMultimodalProblemStatement({
      text: simple.problemStatement,
      issueImages: simple.extraFields.issueImages as string[],
      id: simple.instanceId,
      extraFields: simple.extraFields,
    });
  } else {
    problemStatement = new TextProblemStatement({
      text: simple.problemStatement,
      id: simple.instanceId,
      extraFields: (simple.extraFields as any) || {},
    });
  }

  // Create environment config
  const env: EnvironmentConfig = {
    deployment: {
      ...deployment,
      image: simple.imageName,
    },
    repo: simple.repoName
      ? {
          type: 'preexisting' as const,
          repoName: simple.repoName,
          baseCommit: simple.baseCommit || 'HEAD',
          reset: false,
        }
      : null,
    postStartupCommands: [],
    postStartupCommandTimeout: 500,
    name: 'main',
  };

  return { env, problemStatement };
}

/**
 * Slice specification to slice object
 */
function sliceSpecToSlice(sliceSpec: string): { start?: number; stop?: number; step?: number } {
  if (!sliceSpec) {
    return {};
  }

  const parts = sliceSpec.split(':').map((p) => (p ? parseInt(p) : undefined));

  return {
    start: parts[0],
    stop: parts[1],
    step: parts[2],
  };
}

/**
 * Simple seeded random number generator
 */
function seededRandom(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

/**
 * Filter batch items
 */
export function filterBatchItems(
  instances: BatchInstance[],
  options: {
    filter?: string;
    slice?: string;
    shuffle?: boolean;
    shuffleSeed?: number;
  } = {},
): BatchInstance[] {
  let filtered = [...instances];

  // Shuffle if requested
  if (options.shuffle) {
    // Use a deterministic seed if not provided
    const seed = options.shuffleSeed ?? 42;
    const random = seededRandom(seed);
    filtered.sort(() => random() - 0.5);
  }

  // Apply filter
  if (options.filter) {
    const regex = new RegExp(options.filter);
    filtered = filtered.filter((instance) => {
      const id = (instance.problemStatement as { id?: string }).id || '';
      return regex.test(id);
    });
  }

  // Apply slice
  if (options.slice) {
    const { start, stop, step } = sliceSpecToSlice(options.slice);
    const startIdx = start || 0;
    const stopIdx = stop || filtered.length;
    const stepSize = step || 1;

    const sliced: BatchInstance[] = [];
    for (let i = startIdx; i < stopIdx && i < filtered.length; i += stepSize) {
      sliced.push(filtered[i]);
    }
    filtered = sliced;
  }

  return filtered;
}

/**
 * Load instances from file
 */
export class InstancesFromFile extends AbstractInstanceSource {
  private path: string;
  private _filter: string;
  private _slice: string;
  private _shuffle: boolean;
  private _deployment: DeploymentConfig;

  constructor(config: {
    path: string;
    filter?: string;
    slice?: string;
    shuffle?: boolean;
    deployment?: DeploymentConfig;
  }) {
    super();
    this.path = config.path;
    this._filter = config.filter || '.*';
    this._slice = config.slice || '';
    this._shuffle = config.shuffle || false;
    this._deployment = config.deployment || {
      type: 'docker' as const,
      image: 'python:3.11',
      pythonStandaloneDir: '/root',
      volumes: {},
      environment: {},
      removeOnStop: true,
      workDir: '/workspace',
    };
  }

  getInstanceConfigs(): BatchInstance[] {
    // Load instances from file
    const content = fs.readFileSync(this.path, 'utf-8');
    const data = this.path.endsWith('.json')
      ? JSON.parse(content)
      : content
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));

    // Convert to batch instances
    const instances: BatchInstance[] = [];
    for (const item of data) {
      if ('env' in item && 'problemStatement' in item) {
        // Already a full batch instance
        instances.push(item as BatchInstance);
      } else {
        // Simple instance, convert
        const simple = item as SimpleBatchInstance;
        instances.push(simpleToFullBatchInstance(simple, this._deployment));
      }
    }

    // Filter and return
    return filterBatchItems(instances, {
      filter: this._filter,
      slice: this._slice,
      shuffle: this._shuffle,
    });
  }

  get id(): string {
    return path.basename(this.path, path.extname(this.path));
  }
}

/**
 * Convert SWE-bench instance to SimpleBatchInstance
 */
export function fromSWEBench(sweBenchInstance: Record<string, unknown>): SimpleBatchInstance {
  const instanceId = sweBenchInstance.instance_id as string;
  const problemStatement = sweBenchInstance.problem_statement as string;
  const baseCommit = sweBenchInstance.base_commit as string;
  let imageName = sweBenchInstance.image_name as string | undefined;

  // Generate image name if not provided
  if (!imageName) {
    const parts = instanceId.split('__');
    if (parts.length === 2) {
      const [org, proj] = parts;
      // Only replace hyphens in the org part, keep proj as is for the tag
      const imageTag = `${org.replace(/-/g, '_')}_1776_${proj}`;
      imageName = `swebench/sweb.eval.x86_64.${imageTag}:latest`;
    } else {
      // Fallback for instances without proper org__proj format
      const safeId = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
      imageName = `swebench/sweb.eval.x86_64.${safeId}:latest`;
    }
  }

  const result: SimpleBatchInstance = {
    instanceId,
    problemStatement,
    baseCommit,
    imageName,
    repoName: 'testbed',
    extraFields: {},
  };

  // Handle multimodal instances
  if (sweBenchInstance.image_assets) {
    let imageAssets = sweBenchInstance.image_assets;
    if (typeof imageAssets === 'string') {
      imageAssets = JSON.parse(imageAssets);
    }
    if ((imageAssets as any).problem_statement) {
      result.extraFields = { ...result.extraFields, issue_images: (imageAssets as any).problem_statement };
    }
  }

  return result;
}

/**
 * SWE-bench instances
 */
export class SWEBenchInstances extends AbstractInstanceSource {
  public readonly subset: 'lite' | 'verified' | 'full' | 'multimodal' | 'multilingual';
  public readonly split: 'dev' | 'test';
  private pathOverride?: string;
  private _filter: string;
  private _slice: string;
  private _shuffle: boolean;
  public readonly evaluate: boolean;
  private _deployment: DeploymentConfig;

  constructor(config: {
    subset?: 'lite' | 'verified' | 'full' | 'multimodal' | 'multilingual';
    split?: 'dev' | 'test';
    pathOverride?: string;
    filter?: string;
    slice?: string;
    shuffle?: boolean;
    evaluate?: boolean;
    deployment?: DeploymentConfig;
  }) {
    super();
    this.subset = config.subset || 'lite';
    this.split = config.split || 'dev';
    this.pathOverride = config.pathOverride;
    this._filter = config.filter || '.*';
    this._slice = config.slice || '';
    this._shuffle = config.shuffle || false;
    this.evaluate = config.evaluate || false;
    this._deployment = config.deployment || {
      type: 'docker' as const,
      image: 'python:3.11',
      pythonStandaloneDir: '/root',
      volumes: {},
      environment: {},
      removeOnStop: true,
      workDir: '/workspace',
    };
  }

  getDatasetPath(): string {
    if (this.pathOverride) {
      return this.pathOverride;
    }

    // Map subset to HuggingFace dataset path
    const datasetMap: Record<string, string> = {
      lite: 'princeton-nlp/SWE-bench_Lite',
      verified: 'princeton-nlp/SWE-bench_Verified',
      full: 'princeton-nlp/SWE-bench',
      multimodal: 'princeton-nlp/SWE-bench_Multimodal',
      multilingual: 'princeton-nlp/SWE-bench_Multilingual',
    };

    return datasetMap[this.subset] || datasetMap.lite;
  }

  getInstanceConfigs(): BatchInstance[] {
    // In a real implementation, this would load from HuggingFace
    // For now, return empty array
    console.warn('SWE-bench loading not yet implemented');
    console.warn(
      `Loading from ${this.getDatasetPath()} with filter=${this._filter}, slice=${this._slice}, shuffle=${this._shuffle}`,
    );
    // TODO: Implement actual loading using deployment configuration
    // The deployment config would be used as: this._deployment
    console.warn(`Would use deployment: ${this._deployment.type}`);
    return [];
  }

  get id(): string {
    return `swe_bench_${this.subset}_${this.split}`;
  }

  get isEvaluationEnabled(): boolean {
    return this.evaluate;
  }
}

/**
 * Create instance source from config
 */
export function createInstanceSource(config: BatchInstanceSourceConfig): AbstractInstanceSource {
  if (config.type === 'file' || config.path) {
    if (!config.path) {
      throw new Error('path is required for file instance source');
    }
    return new InstancesFromFile({
      path: config.path,
      filter: config.filter,
      slice: config.slice,
      shuffle: config.shuffle,
      deployment: config.deployment,
    });
  } else if (config.type === 'swe_bench') {
    return new SWEBenchInstances(config);
  } else {
    throw new Error(`Unknown instance source type: ${config.type}`);
  }
}
