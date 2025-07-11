import { promises as fs } from 'fs';
import path from 'path';
import FormData from 'form-data';
import fetch from 'node-fetch';
// Removed broken import - simple-types
// import { type TogetherAIConfig, type TogetherAIJob } from '../simple-types.js';

// Define the types inline for now
interface TogetherAIConfig {
  apiKey: string;
  baseModel: string;
  epochs: number;
  learningRate: number;
  batchSize: number;
  suffix?: string;
}

interface TogetherAIJob {
  id: string;
  status: string;
  model: string;
  progress?: number;
  fineTunedModel?: string;
  createdAt?: Date;
  finishedAt?: Date;
  error?: string;
}
import type { UsageMetrics } from '../interfaces/CustomReasoningService.js';
import { elizaLogger } from '@elizaos/core';

export interface TogetherAIResponse {
  id: string;
  choices: {
    text: string;
    index: number;
    logprobs?: any;
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
  object: string;
  created: number;
}

export interface TogetherAIRequest {
  model: string;
  prompt: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop?: string | string[];
  stream?: boolean;
}

export interface ModelDeployment {
  id: string;
  name: string;
  endpoint: string;
  status: 'active' | 'inactive' | 'deploying' | 'error';
  created_at: number;
}

/**
 * Simple, working Together.ai API client
 */
export class TogetherAIClient {
  private apiKey: string;
  private baseUrl = 'https://api.together.xyz/v1';

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('Together.ai API key is required');
    }
    this.apiKey = apiKey;
  }

  /**
   * Upload dataset file to Together.ai
   */
  async uploadDataset(filePath: string): Promise<string> {
    try {
      // Validate file exists
      await fs.access(filePath);
      const fileContent = await fs.readFile(filePath);

      const formData = new FormData();
      formData.append('file', fileContent, {
        filename: path.basename(filePath),
        contentType: 'text/plain',
      });
      formData.append('purpose', 'fine-tune');

      const response = await fetch(`${this.baseUrl}/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...formData.getHeaders(),
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        elizaLogger.error('Upload error details:', {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: errorText,
        });
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as any;
      return result.id;
    } catch (error) {
      throw new Error(
        `Failed to upload dataset: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Start fine-tuning job
   */
  async startFineTuning(config: TogetherAIConfig, trainingFileId: string): Promise<TogetherAIJob> {
    try {
      const jobConfig = {
        training_file: trainingFileId,
        model: config.baseModel,
        n_epochs: config.epochs || 3,
        learning_rate: config.learningRate || 1e-5,
        batch_size: config.batchSize || 1,
        suffix: config.suffix || `eliza-${Date.now()}`,
      };

      const response = await fetch(`${this.baseUrl}/fine-tunes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(jobConfig),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Fine-tuning failed: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as any;

      return {
        id: result.id,
        status: result.status,
        model: config.baseModel,
        fineTunedModel: result.fine_tuned_model,
        createdAt: new Date(result.created_at * 1000),
      };
    } catch (error) {
      throw new Error(
        `Failed to start fine-tuning: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get fine-tuning job status
   */
  async getJobStatus(jobId: string): Promise<TogetherAIJob> {
    try {
      const response = await fetch(`${this.baseUrl}/fine-tunes/${jobId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Status check failed: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as any;

      return {
        id: result.id,
        status: result.status,
        model: result.model,
        fineTunedModel: result.fine_tuned_model,
        createdAt: new Date(result.created_at * 1000),
        finishedAt: result.finished_at ? new Date(result.finished_at * 1000) : undefined,
        error: result.error,
      };
    } catch (error) {
      throw new Error(
        `Failed to get job status: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Test inference with a model
   */
  async testInference(modelName: string, prompt: string, maxTokens = 100): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
          prompt,
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Inference failed: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as any;
      return result.choices[0].text;
    } catch (error) {
      throw new Error(
        `Failed to test inference: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List available models
   */
  async getModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get models: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as any;

      // Handle different response formats
      const models = result.data || result || [];

      if (!Array.isArray(models)) {
        elizaLogger.warn('API response format unexpected:', result);
        return [];
      }

      return models
        .filter((model: any) => model?.fine_tuning_available !== false)
        .map((model: any) => model?.id || model?.name || String(model))
        .filter(Boolean);
    } catch (error) {
      throw new Error(
        `Failed to get models: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Enhanced completion method for custom reasoning
   */
  async complete(request: TogetherAIRequest): Promise<TogetherAIResponse> {
    const response = await fetch(`${this.baseUrl}/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        max_tokens: request.max_tokens || 2048,
        temperature: request.temperature || 0.3,
        top_p: request.top_p || 0.9,
        stop: request.stop,
        stream: false, // We don't support streaming for now
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Together.ai API error (${response.status}): ${errorText}`);
    }

    const result = (await response.json()) as TogetherAIResponse;
    return result;
  }

  /**
   * Deploy a model for inference
   */
  async deployModel(modelName: string): Promise<ModelDeployment> {
    const response = await fetch(`${this.baseUrl}/models/${encodeURIComponent(modelName)}/deploy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to deploy model ${modelName}: ${errorText}`);
    }

    return (await response.json()) as ModelDeployment;
  }

  /**
   * Undeploy a model to save costs
   */
  async undeployModel(deploymentId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/deployments/${deploymentId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to undeploy model ${deploymentId}: ${errorText}`);
    }
  }

  /**
   * Get deployment status
   */
  async getDeployment(deploymentId: string): Promise<ModelDeployment> {
    const response = await fetch(`${this.baseUrl}/deployments/${deploymentId}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get deployment ${deploymentId}: ${errorText}`);
    }

    return (await response.json()) as ModelDeployment;
  }

  /**
   * List all deployments
   */
  async listDeployments(): Promise<ModelDeployment[]> {
    const response = await fetch(`${this.baseUrl}/deployments`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list deployments: ${errorText}`);
    }

    const result = (await response.json()) as any;
    return result.data || [];
  }

  /**
   * Get usage metrics for cost tracking
   */
  async getUsageMetrics(deploymentId: string): Promise<UsageMetrics> {
    // Note: This might need to be adjusted based on Together.ai's actual usage API
    const response = await fetch(`${this.baseUrl}/deployments/${deploymentId}/usage`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      // If usage endpoint doesn't exist, try alternative endpoints or fail gracefully
      if (response.status === 404) {
        throw new Error(
          `Usage metrics endpoint not found for deployment ${deploymentId}. This feature may not be available for this model.`
        );
      } else if (response.status === 403) {
        throw new Error(
          `Access denied to usage metrics for deployment ${deploymentId}. Check API key permissions.`
        );
      } else {
        throw new Error(
          `Failed to fetch usage metrics for deployment ${deploymentId}: ${response.status} ${response.statusText}`
        );
      }
    }

    const result = (await response.json()) as any;
    return {
      deploymentId,
      hoursActive: result.hours_active || 1,
      requests: result.requests || 0,
      totalTokens: result.total_tokens || 0,
      cost: result.cost || 0,
      lastRequestAt: result.last_request_at || Date.now(),
    };
  }

  /**
   * Validate API key
   */
  async validateApiKey(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Test model availability and response time
   */
  async testModel(modelName: string): Promise<{ available: boolean; responseTimeMs: number }> {
    const startTime = Date.now();

    try {
      await this.complete({
        model: modelName,
        prompt: 'Test prompt',
        max_tokens: 1,
        temperature: 0,
      });

      const responseTimeMs = Date.now() - startTime;
      return { available: true, responseTimeMs };
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      return { available: false, responseTimeMs };
    }
  }

  /**
   * Estimate token count (rough approximation)
   */
  estimateTokens(text: string): number {
    // Rough approximation: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  /**
   * Calculate estimated cost for a request
   */
  estimateCost(prompt: string, maxTokens: number, costPerToken: number): number {
    const promptTokens = this.estimateTokens(prompt);
    const totalTokens = promptTokens + maxTokens;
    return totalTokens * costPerToken;
  }
}
