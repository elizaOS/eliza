/**
 * PLUGIN ANALYZER
 * 
 * Responsibilities:
 * - Analyze plugin directory structure
 * - Detect services, actions, providers, evaluators
 * - Extract plugin metadata for test generation
 */

import { logger } from '@elizaos/core';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import type { PluginAnalysis } from './types.js';

export class PluginAnalyzer {
  private repoPath: string;
  private pluginName: string;

  constructor(repoPath: string, pluginName: string) {
    this.repoPath = repoPath;
    this.pluginName = pluginName;
  }

  /**
   * Analyze plugin structure to understand what tests are needed
   */
  async analyzePlugin(): Promise<PluginAnalysis> {
    const analysis: PluginAnalysis = {
      name: this.pluginName || 'unknown',
      description: '',
      hasServices: false,
      hasActions: false,
      hasProviders: false,
      hasEvaluators: false,
      services: [],
      actions: [],
      providers: [],
      evaluators: []
    };

    try {
      // Check for services
      const servicesPath = path.join(this.repoPath, 'src', 'services');
      if (await fs.pathExists(servicesPath)) {
        analysis.hasServices = true;
        const serviceFiles = await fs.readdir(servicesPath);
        for (const file of serviceFiles.filter(f => f.endsWith('.ts'))) {
          analysis.services.push({
            name: file.replace('.ts', ''),
            type: 'service',
            methods: [] // Will be filled by Claude analysis
          });
        }
      }

      // Check for actions
      const actionsPath = path.join(this.repoPath, 'src', 'actions');
      if (await fs.pathExists(actionsPath)) {
        analysis.hasActions = true;
        const actionFiles = await fs.readdir(actionsPath);
        for (const file of actionFiles.filter(f => f.endsWith('.ts'))) {
          analysis.actions.push({
            name: file.replace('.ts', ''),
            description: '',
            handler: ''
          });
        }
      }

      // Check for providers
      const providersPath = path.join(this.repoPath, 'src', 'providers');
      if (await fs.pathExists(providersPath)) {
        analysis.hasProviders = true;
        const providerFiles = await fs.readdir(providersPath);
        for (const file of providerFiles.filter(f => f.endsWith('.ts'))) {
          analysis.providers.push({
            name: file.replace('.ts', ''),
            description: '',
            methods: []
          });
        }
      }

      // Check for evaluators
      const evaluatorsPath = path.join(this.repoPath, 'src', 'evaluators');
      if (await fs.pathExists(evaluatorsPath)) {
        analysis.hasEvaluators = true;
        const evaluatorFiles = await fs.readdir(evaluatorsPath);
        for (const file of evaluatorFiles.filter(f => f.endsWith('.ts'))) {
          analysis.evaluators.push({
            name: file.replace('.ts', ''),
            description: ''
          });
        }
      }

      logger.info(`📊 Plugin Analysis: ${analysis.name}`, {
        services: analysis.services.length,
        actions: analysis.actions.length,
        providers: analysis.providers.length,
        evaluators: analysis.evaluators.length
      });

    } catch (error) {
      logger.warn('⚠️  Could not fully analyze plugin structure:', error);
    }

    return analysis;
  }
} 