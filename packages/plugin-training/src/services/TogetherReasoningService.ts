import { v4 } from 'uuid';
import {
  Service,
  type IAgentRuntime,
  type UUID,
  type ServiceTypeName,
  shouldRespondTemplate,
  messageHandlerTemplate,
  parseKeyValueXml,
  elizaLogger,
} from '@elizaos/core';

import type {
  CustomReasoningService,
  ModelConfig,
  ModelStatus,
  DeploymentInfo,
  CostReport,
  ModelCostInfo,
  ShouldRespondContext,
  ShouldRespondResult,
  PlanningContext,
  PlanningResult,
  CodingContext,
  CodingResult,
  TrainingDataPoint,
  ExportOptions,
  TrainingDataset,
  CustomReasoningConfig,
} from '../interfaces/CustomReasoningService.js';

import { TogetherAIClient } from '../lib/together-client.js';
import { TrainingDataCollector } from '../training/DataCollector.js';
import { type CustomModelType } from '../types.js';

export class TogetherReasoningService extends Service implements CustomReasoningService {
  static serviceType = 'custom-reasoning' as ServiceTypeName;

  capabilityDescription =
    'Custom reasoning service using fine-tuned DeepSeek models via Together.ai';

  private client: TogetherAIClient;
  private models: Map<CustomModelType, ModelConfig> = new Map();
  private enabledModels: Set<CustomModelType> = new Set();
  private deployments: Map<string, DeploymentInfo> = new Map();
  public config: any;
  private budgetLimit?: number;
  private budgetUsed: number = 0;
  private dataCollector: TrainingDataCollector;
  private usageStats: Map<string, { requests: number; totalCost: number; lastUsed: Date }> =
    new Map();

  constructor(runtime: IAgentRuntime) {
    super(runtime);

    // Load configuration
    this.config = this.loadConfiguration();

    // Initialize Together.ai client
    this.client = new TogetherAIClient(this.config.togetherAI.apiKey);

    // Initialize training data collector
    this.dataCollector = new TrainingDataCollector(runtime);

    // Initialize model configurations
    this.initializeModels();

    // Set budget if configured
    if (this.config.costManagement.budgetLimitUSD) {
      this.budgetLimit = this.config.costManagement.budgetLimitUSD;
    }
  }

  static async start(runtime: IAgentRuntime): Promise<TogetherReasoningService> {
    const service = new TogetherReasoningService(runtime);

    // Validate API key
    const isValidKey = await service.client.validateApiKey();
    if (!isValidKey) {
      throw new Error('Invalid Together.ai API key');
    }

    // Load existing deployments
    await service.loadExistingDeployments();

    // Enable configured models
    await service.enableConfiguredModels();

    elizaLogger.info('TogetherReasoningService started successfully');
    return service;
  }

  private loadConfiguration(): CustomReasoningConfig {
    const enabled = this.runtime.getSetting('REASONING_SERVICE_ENABLED') === 'true';
    const apiKey = this.runtime.getSetting('TOGETHER_AI_API_KEY');

    if (!apiKey) {
      throw new Error('TOGETHER_AI_API_KEY is required for custom reasoning service');
    }

    return {
      enabled,
      models: {
        shouldRespond: {
          modelName:
            this.runtime.getSetting('REASONING_SERVICE_SHOULD_RESPOND_MODEL') ||
            'moonmakesmagic/DeepSeek-R1-Distill-Qwen-1.5B-shouldrespond',
          enabled: this.runtime.getSetting('REASONING_SERVICE_SHOULD_RESPOND_ENABLED') === 'true',
        },
        planning: {
          modelName:
            this.runtime.getSetting('REASONING_SERVICE_PLANNING_MODEL') ||
            'moonmakesmagic/DeepSeek-Qwen-14B-planning',
          enabled: this.runtime.getSetting('REASONING_SERVICE_PLANNING_ENABLED') === 'true',
        },
        coding: {
          modelName:
            this.runtime.getSetting('REASONING_SERVICE_CODING_MODEL') ||
            'moonmakesmagic/DeepSeek-Llama-67B-coding',
          enabled: this.runtime.getSetting('REASONING_SERVICE_CODING_ENABLED') === 'true',
        },
      },
      togetherAI: {
        apiKey,
        baseUrl: this.runtime.getSetting('TOGETHER_AI_BASE_URL'),
      },
      costManagement: {
        budgetLimitUSD:
          parseFloat(this.runtime.getSetting('REASONING_SERVICE_BUDGET_LIMIT') || '0') || undefined,
        autoShutdownIdleMinutes: parseInt(
          this.runtime.getSetting('REASONING_SERVICE_AUTO_SHUTDOWN_MINUTES') || '30',
          10
        ),
        maxCostPerHour: parseFloat(
          this.runtime.getSetting('REASONING_SERVICE_MAX_COST_PER_HOUR') || '10'
        ),
      },
      trainingData: {
        collectData: this.runtime.getSetting('REASONING_SERVICE_COLLECT_TRAINING_DATA') === 'true',
        maxSamplesPerModel: parseInt(
          this.runtime.getSetting('REASONING_SERVICE_MAX_SAMPLES_PER_MODEL') || '10000',
          10
        ),
        retentionDays: parseInt(
          this.runtime.getSetting('REASONING_SERVICE_RETENTION_DAYS') || '30',
          10
        ),
      },
    };
  }

  private initializeModels(): void {
    // Ultra-small model for shouldRespond decisions
    this.models.set('should_respond' as CustomModelType, {
      name:
        this.config.models.shouldRespond?.modelName ||
        'moonmakesmagic/DeepSeek-R1-Distill-Qwen-1.5B-shouldrespond',
      size: 'ultra-small',
      costPerHour: 0.1, // Example pricing
      maxTokens: 512,
      temperature: 0.1,
      enabled: this.config.models.shouldRespond?.enabled || false,
    });

    // Medium-sized model for planning
    this.models.set('planning' as CustomModelType, {
      name: this.config.models.planning?.modelName || 'moonmakesmagic/DeepSeek-Qwen-14B-planning',
      size: 'medium',
      costPerHour: 0.5,
      maxTokens: 2048,
      temperature: 0.3,
      enabled: this.config.models.planning?.enabled || false,
    });

    // Large model for coding
    this.models.set('coding' as CustomModelType, {
      name: this.config.models.coding?.modelName || 'moonmakesmagic/DeepSeek-Llama-67B-coding',
      size: 'large',
      costPerHour: 2.0,
      maxTokens: 4096,
      temperature: 0.2,
      enabled: this.config.models.coding?.enabled || false,
    });
  }

  private async loadExistingDeployments(): Promise<void> {
    try {
      const deployments = await this.client.listDeployments();

      for (const deployment of deployments) {
        this.deployments.set(deployment.name, {
          deploymentId: deployment.id,
          endpoint: deployment.endpoint,
          deployedAt: deployment.created_at,
          status: deployment.status,
          costPerHour: 0, // Will be updated from model config
          lastUsed: Date.now(),
        });
      }

      elizaLogger.info(`Loaded ${deployments.length} existing deployments`);
    } catch (error) {
      elizaLogger.warn('Failed to load existing deployments:', error);
    }
  }

  private async enableConfiguredModels(): Promise<void> {
    for (const [modelType, modelConfig] of this.models) {
      if (modelConfig.enabled) {
        await this.enableModel(modelType);
      }
    }
  }

  async shouldRespond(context: ShouldRespondContext): Promise<ShouldRespondResult> {
    if (!this.enabledModels.has('should_respond' as CustomModelType)) {
      throw new Error('ShouldRespond model not enabled');
    }

    await this.checkBudgetLimit();

    const model = this.models.get('should_respond' as CustomModelType)!;
    const prompt = this.buildShouldRespondPrompt(context);

    const startTime = Date.now();
    const response = await this.client.complete({
      model: model.name,
      prompt,
      max_tokens: model.maxTokens,
      temperature: model.temperature,
    });

    const result = this.parseShouldRespondResponse(response.choices[0].text);
    const responseTime = Date.now() - startTime;

    // Update usage metrics
    await this.updateUsageMetrics(
      'should_respond' as CustomModelType,
      response.usage,
      responseTime
    );

    // Collect training data
    const trainingData: TrainingDataPoint = {
      id: v4() as UUID,
      timestamp: Date.now(),
      modelType: 'should_respond' as CustomModelType,
      input: {
        prompt,
        messageText: context.message.content.text,
        conversationContext: context.conversationHistory.slice(-5),
      },
      output: {
        decision: result.decision,
        reasoning: result.reasoning,
        confidence: result.confidence,
      },
      metadata: {
        agentId: context.runtime.agentId,
        roomId: context.message.roomId,
        modelName: model.name,
        responseTimeMs: responseTime,
        tokensUsed: response.usage.total_tokens,
      },
    };

    if (this.config.trainingData.collectData) {
      await this.collectTrainingData(trainingData);
    }

    return { ...result, trainingData };
  }

  async planResponse(context: PlanningContext): Promise<PlanningResult> {
    if (!this.enabledModels.has('planning' as CustomModelType)) {
      throw new Error('Planning model not enabled');
    }

    await this.checkBudgetLimit();

    const model = this.models.get('planning' as CustomModelType)!;
    const prompt = this.buildPlanningPrompt(context);

    const startTime = Date.now();
    const response = await this.client.complete({
      model: model.name,
      prompt,
      max_tokens: model.maxTokens,
      temperature: model.temperature,
    });

    const result = this.parsePlanningResponse(response.choices[0].text);
    const responseTime = Date.now() - startTime;

    // Update usage metrics
    await this.updateUsageMetrics('planning' as CustomModelType, response.usage, responseTime);

    // Collect training data
    const trainingData: TrainingDataPoint = {
      id: v4() as UUID,
      timestamp: Date.now(),
      modelType: 'planning' as CustomModelType,
      input: {
        prompt,
        messageText: context.message.content.text,
        availableActions: context.actionNames,
        state: context.state,
      },
      output: result,
      metadata: {
        agentId: context.runtime.agentId,
        roomId: context.message.roomId,
        modelName: model.name,
        responseTimeMs: responseTime,
        tokensUsed: response.usage.total_tokens,
      },
    };

    if (this.config.trainingData.collectData) {
      await this.collectTrainingData(trainingData);
    }

    return { ...result, trainingData };
  }

  async generateCode(context: CodingContext): Promise<CodingResult> {
    if (!this.enabledModels.has('coding' as CustomModelType)) {
      throw new Error('Coding model not enabled');
    }

    await this.checkBudgetLimit();

    const model = this.models.get('coding' as CustomModelType)!;

    const startTime = Date.now();
    const response = await this.client.complete({
      model: model.name,
      prompt: context.prompt,
      max_tokens: context.maxTokens || model.maxTokens,
      temperature: context.temperature || model.temperature,
    });

    const result = this.parseCodingResponse(response.choices[0].text);
    const responseTime = Date.now() - startTime;

    // Update usage metrics
    await this.updateUsageMetrics('coding' as CustomModelType, response.usage, responseTime);

    // Collect training data
    const trainingData: TrainingDataPoint = {
      id: v4() as UUID,
      timestamp: Date.now(),
      modelType: 'coding' as CustomModelType,
      input: context,
      output: result,
      metadata: {
        agentId: this.runtime.agentId,
        modelName: model.name,
        language: context.language,
        responseTimeMs: responseTime,
        tokensUsed: response.usage.total_tokens,
      },
    };

    if (this.config.trainingData.collectData) {
      await this.collectTrainingData(trainingData);
    }

    return { ...result, trainingData };
  }

  private buildShouldRespondPrompt(context: ShouldRespondContext): string {
    // Use the existing shouldRespondTemplate but optimized for fine-tuned model
    const agentName = context.runtime.character.name;

    // Get recent conversation context
    const recentMessages = context.conversationHistory
      .slice(-5)
      .map(
        (msg) =>
          `${msg.entityId === context.runtime.agentId ? agentName : 'User'}: ${msg.content.text}`
      )
      .join('\n');

    const providers = `Recent conversation:\n${recentMessages}`;

    return shouldRespondTemplate
      .replace(/{{agentName}}/g, agentName)
      .replace(/{{providers}}/g, providers);
  }

  private buildPlanningPrompt(context: PlanningContext): string {
    // Use the existing messageHandlerTemplate but optimized for fine-tuned model
    const agentName = context.runtime.character.name;
    const actionNames = context.actionNames.join(', ');

    // Format providers data
    const providers = Object.entries(context.state.data?.providers || {})
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');

    return messageHandlerTemplate
      .replace(/{{agentName}}/g, agentName)
      .replace(/{{providers}}/g, providers)
      .replace(/{{actionNames}}/g, actionNames);
  }

  private parseShouldRespondResponse(response: string): Omit<ShouldRespondResult, 'trainingData'> {
    // Parse XML response similar to existing parseKeyValueXml
    const parsed = parseKeyValueXml(response);
    return {
      decision: (parsed?.action as 'RESPOND' | 'IGNORE' | 'STOP') || 'IGNORE',
      reasoning: parsed?.reasoning || 'No reasoning provided',
      confidence: parsed?.confidence ? parseFloat(parsed.confidence) : 0.8,
    };
  }

  private parsePlanningResponse(response: string): Omit<PlanningResult, 'trainingData'> {
    const parsed = parseKeyValueXml(response);
    return {
      thought: parsed?.thought || 'No thought provided',
      actions: parsed?.actions
        ? parsed.actions.split(',').map((a: string) => a.trim())
        : ['IGNORE'],
      providers: parsed?.providers ? parsed.providers.split(',').map((p: string) => p.trim()) : [],
      text: parsed?.text || '',
    };
  }

  private parseCodingResponse(response: string): Omit<CodingResult, 'trainingData'> {
    // Extract code blocks and explanations from response
    const codeMatch = response.match(/```[\w]*\n([\s\S]*?)\n```/);
    const code = codeMatch ? codeMatch[1] : response;

    return {
      code: code.trim(),
      explanation: response.includes('```') ? response.split('```')[0].trim() : undefined,
    };
  }

  async enableModel(modelType: CustomModelType): Promise<void> {
    const model = this.models.get(modelType);
    if (!model) {
      throw new Error(`Unknown model type: ${modelType}`);
    }

    // Check if model is already deployed
    const existing = this.deployments.get(model.name);
    if (!existing) {
      elizaLogger.info(`Deploying model ${model.name}...`);

      try {
        const deployment = await this.client.deployModel(model.name);
        this.deployments.set(model.name, {
          deploymentId: deployment.id,
          endpoint: deployment.endpoint,
          deployedAt: Date.now(),
          status: 'active',
          costPerHour: model.costPerHour,
          lastUsed: Date.now(),
        });
      } catch (error) {
        // Model might already be available for inference without explicit deployment
        elizaLogger.warn(`Failed to deploy ${model.name}, checking availability:`, error);

        const test = await this.client.testModel(model.name);
        if (!test.available) {
          throw new Error(`Model ${model.name} is not available for inference`);
        }
      }
    }

    this.enabledModels.add(modelType);
    elizaLogger.info(`Enabled custom reasoning model: ${modelType}`);

    // Schedule auto-shutdown if configured
    if (this.config.costManagement.autoShutdownIdleMinutes) {
      this.scheduleAutoShutdown(model.name, this.config.costManagement.autoShutdownIdleMinutes);
    }
  }

  async disableModel(modelType: CustomModelType): Promise<void> {
    const model = this.models.get(modelType);
    if (!model) {
      throw new Error(`Unknown model type: ${modelType}`);
    }

    this.enabledModels.delete(modelType);

    // Optionally undeploy the model to save costs
    const deployment = this.deployments.get(model.name);
    if (deployment) {
      try {
        await this.client.undeployModel(deployment.deploymentId);
        this.deployments.delete(model.name);
        elizaLogger.info(`Undeployed model ${model.name}`);
      } catch (error) {
        elizaLogger.warn(`Failed to undeploy ${model.name}:`, error);
      }
    }

    elizaLogger.info(`Disabled custom reasoning model: ${modelType}`);
  }

  async getModelStatus(modelType: CustomModelType): Promise<ModelStatus> {
    const model = this.models.get(modelType);
    if (!model) {
      throw new Error(`Unknown model type: ${modelType}`);
    }

    const deployment = this.deployments.get(model.name);
    const isDeployed = deployment ? deployment.status === 'active' : false;

    return {
      enabled: this.enabledModels.has(modelType),
      name: model.name,
      size: model.size,
      costPerHour: model.costPerHour,
      isDeployed,
      lastUsed: deployment?.lastUsed,
      totalRequests: this.usageStats.get(model.name)?.requests || 0,
      totalCost: this.usageStats.get(model.name)?.totalCost || 0,
    };
  }

  /**
   * Track usage for a model deployment
   */
  private trackUsage(modelName: string, cost: number): void {
    const stats = this.usageStats.get(modelName) || {
      requests: 0,
      totalCost: 0,
      lastUsed: new Date(),
    };
    stats.requests += 1;
    stats.totalCost += cost;
    stats.lastUsed = new Date();
    this.usageStats.set(modelName, stats);
    this.budgetUsed += cost;
  }

  /**
   * Calculate cost based on model usage (approximate)
   */
  private calculateCost(modelType: CustomModelType, tokensUsed: number): number {
    // Approximate costs per 1K tokens for fine-tuned models
    const costPer1K = {
      should_respond: 0.0001, // Small model, low cost
      planning: 0.0002, // Medium complexity
      coding: 0.0003, // Higher complexity
      autocoder: 0.0003, // Similar to coding
      conversation: 0.0002, // Medium complexity
    };

    return (tokensUsed / 1000) * (costPer1K[modelType] || 0.0002);
  }

  async collectTrainingData(trainingData: TrainingDataPoint): Promise<void> {
    // Store in database for future training
    await (this.runtime as any).adapter?.log({
      entityId: this.runtime.agentId,
      roomId: this.runtime.agentId,
      body: trainingData,
      type: `training-data:${trainingData.modelType}`,
    });
  }

  async exportTrainingData(options: ExportOptions): Promise<TrainingDataset> {
    try {
      elizaLogger.info('Starting training data export', { options });

      // Use the TrainingDataCollector to export data from database logs
      const dataset = await this.dataCollector.exportTrainingData(options);

      elizaLogger.info('Successfully exported training dataset', {
        modelType: dataset.modelType,
        totalSamples: dataset.samples.length,
        format: dataset.format,
      });

      return dataset;
    } catch (error) {
      elizaLogger.error('Failed to export training data:', error);
      throw new Error(
        `Training data export failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getCostReport(): Promise<CostReport> {
    const report: CostReport = {
      totalCost: 0,
      modelCosts: new Map(),
      period: '24h',
      budgetLimit: this.budgetLimit,
      budgetUsed: this.budgetUsed,
    };

    for (const [modelName, deployment] of this.deployments) {
      try {
        const usage = await this.client.getUsageMetrics(deployment.deploymentId);
        const cost = usage.hoursActive * deployment.costPerHour;

        report.modelCosts.set(modelName, {
          hoursActive: usage.hoursActive,
          cost,
          requests: usage.requests,
          averageCostPerRequest: usage.requests > 0 ? cost / usage.requests : 0,
        });

        report.totalCost += cost;
      } catch (error) {
        elizaLogger.warn(`Could not fetch usage metrics for ${modelName}:`, error);

        // Fallback: estimate cost based on deployment time
        const deploymentAge = Date.now() - deployment.deployedAt;
        const hoursActive = Math.max(0.1, deploymentAge / (1000 * 60 * 60)); // Minimum 0.1 hours
        const estimatedCost = hoursActive * deployment.costPerHour;

        report.modelCosts.set(modelName, {
          hoursActive,
          cost: estimatedCost,
          requests: 0, // Unknown
          averageCostPerRequest: 0,
        });

        report.totalCost += estimatedCost;
      }
    }

    this.budgetUsed = report.totalCost;
    return report;
  }

  async setBudgetLimit(limitUSD: number): Promise<void> {
    this.budgetLimit = limitUSD;
    elizaLogger.info(`Set budget limit to $${limitUSD}`);
  }

  async enableAutoShutdown(idleMinutes: number): Promise<void> {
    for (const [modelName] of this.deployments) {
      this.scheduleAutoShutdown(modelName, idleMinutes);
    }
  }

  private async checkBudgetLimit(): Promise<void> {
    if (!this.budgetLimit) {
      return;
    }

    const report = await this.getCostReport();
    if (report.totalCost >= this.budgetLimit) {
      // Disable all models to prevent further costs
      for (const modelType of this.enabledModels) {
        await this.disableModel(modelType);
      }
      throw new Error(
        `Budget limit of $${this.budgetLimit} exceeded. Current cost: $${report.totalCost}`
      );
    }
  }

  private async updateUsageMetrics(
    modelType: CustomModelType,
    usage: { total_tokens: number },
    responseTimeMs: number
  ): Promise<void> {
    const model = this.models.get(modelType);
    if (!model) {
      return;
    }

    const deployment = this.deployments.get(model.name);
    if (deployment) {
      deployment.lastUsed = Date.now();
    }

    // Track usage and cost
    const cost = this.calculateCost(modelType, usage.total_tokens);
    this.trackUsage(model.name, cost);

    // Log usage for cost tracking
    await (this.runtime as any).adapter?.log({
      entityId: this.runtime.agentId,
      roomId: this.runtime.agentId,
      body: {
        modelType,
        modelName: model.name,
        tokensUsed: usage.total_tokens,
        responseTimeMs,
        timestamp: Date.now(),
      },
      type: `model-usage:${modelType}`,
    });
  }

  private scheduleAutoShutdown(modelName: string, idleMinutes: number): void {
    setTimeout(
      async () => {
        const deployment = this.deployments.get(modelName);
        if (!deployment) {
          return;
        }

        const idleTime = Date.now() - deployment.lastUsed;
        const idleThreshold = idleMinutes * 60 * 1000;

        if (idleTime > idleThreshold) {
          try {
            await this.client.undeployModel(deployment.deploymentId);
            this.deployments.delete(modelName);
            elizaLogger.info(`Auto-shutdown: ${modelName} was idle for ${idleMinutes} minutes`);
          } catch (error) {
            elizaLogger.error(`Failed to auto-shutdown ${modelName}:`, error);
          }
        }
      },
      idleMinutes * 60 * 1000
    );
  }

  async stop(): Promise<void> {
    elizaLogger.info('Stopping TogetherReasoningService...');

    // Optionally undeploy all models to save costs
    for (const [modelName, deployment] of this.deployments) {
      try {
        await this.client.undeployModel(deployment.deploymentId);
        elizaLogger.info(`Undeployed ${modelName} on service stop`);
      } catch (error) {
        elizaLogger.warn(`Failed to undeploy ${modelName} on stop:`, error);
      }
    }
  }
}
