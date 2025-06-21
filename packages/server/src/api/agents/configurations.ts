import type { IAgentRuntime, UUID } from '@elizaos/core';
import { validateUuid, logger } from '@elizaos/core';
import express from 'express';
import type { AgentServer } from '../../index';
import { sendError, sendSuccess } from '../shared/response-utils';

/**
 * Agent plugin configuration management
 */
export function createAgentConfigurationsRouter(
  agents: Map<UUID, IAgentRuntime>,
  serverInstance: AgentServer
): express.Router {
  const router = express.Router();

  // Get plugin configurations for an agent
  router.get('/:agentId/configurations', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const configManager = runtime.getConfigurationManager();
      if (!configManager) {
        return sendError(res, 500, 'CONFIG_ERROR', 'Configuration manager not available');
      }

      const configurations = configManager.listConfigurations();
      sendSuccess(res, { configurations });
    } catch (error) {
      logger.error(`[AGENT CONFIG] Error retrieving configurations for agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'CONFIG_ERROR',
        'Error retrieving plugin configurations',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Get specific plugin configuration
  router.get('/:agentId/configurations/:pluginName', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { pluginName } = req.params;
    if (!pluginName) {
      return sendError(res, 400, 'INVALID_PLUGIN', 'Plugin name is required');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const configManager = runtime.getConfigurationManager();
      if (!configManager) {
        return sendError(res, 500, 'CONFIG_ERROR', 'Configuration manager not available');
      }

      const configuration = configManager.getPluginConfiguration(pluginName);
      if (!configuration) {
        return sendError(res, 404, 'NOT_FOUND', `Plugin configuration not found: ${pluginName}`);
      }

      sendSuccess(res, { configuration });
    } catch (error) {
      logger.error(`[AGENT CONFIG] Error retrieving configuration for plugin ${pluginName} in agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'CONFIG_ERROR',
        'Error retrieving plugin configuration',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Update plugin configuration
  router.patch('/:agentId/configurations/:pluginName', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { pluginName } = req.params;
    if (!pluginName) {
      return sendError(res, 400, 'INVALID_PLUGIN', 'Plugin name is required');
    }

    const { configuration } = req.body;
    if (!configuration) {
      return sendError(res, 400, 'INVALID_BODY', 'Configuration data is required');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const configManager = runtime.getConfigurationManager();
      if (!configManager) {
        return sendError(res, 500, 'CONFIG_ERROR', 'Configuration manager not available');
      }

      await configManager.setOverride('gui', pluginName, configuration);
      
      // Get updated configuration to return
      const updatedConfiguration = configManager.getPluginConfiguration(pluginName);
      sendSuccess(res, { configuration: updatedConfiguration });
    } catch (error) {
      logger.error(`[AGENT CONFIG] Error updating configuration for plugin ${pluginName} in agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'CONFIG_ERROR',
        'Error updating plugin configuration',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Update component configuration
  router.patch('/:agentId/configurations/:pluginName/components/:componentType/:componentName', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { pluginName, componentType, componentName } = req.params;
    if (!pluginName || !componentType || !componentName) {
      return sendError(res, 400, 'INVALID_PARAMS', 'Plugin name, component type, and component name are required');
    }

    if (!['action', 'provider', 'evaluator', 'service'].includes(componentType)) {
      return sendError(res, 400, 'INVALID_TYPE', 'Component type must be action, provider, evaluator, or service');
    }

    const { config, dependencies = [] } = req.body;
    if (!config) {
      return sendError(res, 400, 'INVALID_BODY', 'Component configuration data is required');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const configManager = runtime.getConfigurationManager();
      if (!configManager) {
        return sendError(res, 500, 'CONFIG_ERROR', 'Configuration manager not available');
      }

      // Get enabled components map for dependency validation
      const enabledComponents = configManager.getEnabledComponentsMap();

      const validationResult = await configManager.updateComponentConfiguration(
        pluginName,
        componentName,
        componentType as 'action' | 'provider' | 'evaluator' | 'service',
        config,
        dependencies,
        enabledComponents
      );

      if (!validationResult.valid) {
        return sendError(res, 400, 'VALIDATION_ERROR', `Cannot update component: ${validationResult.errors.join(', ')}`);
      }

      // Get updated component configuration
      const componentConfig = configManager.getComponentConfig(pluginName, componentName, componentType as 'action' | 'provider' | 'evaluator');
      
      sendSuccess(res, { 
        componentConfig,
        validationResult 
      });
    } catch (error) {
      logger.error(`[AGENT CONFIG] Error updating component ${componentName} configuration for plugin ${pluginName} in agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'CONFIG_ERROR',
        'Error updating component configuration',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Get component configuration
  router.get('/:agentId/configurations/:pluginName/components/:componentType/:componentName', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { pluginName, componentType, componentName } = req.params;
    if (!pluginName || !componentType || !componentName) {
      return sendError(res, 400, 'INVALID_PARAMS', 'Plugin name, component type, and component name are required');
    }

    if (!['action', 'provider', 'evaluator', 'service'].includes(componentType)) {
      return sendError(res, 400, 'INVALID_TYPE', 'Component type must be action, provider, evaluator, or service');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const configManager = runtime.getConfigurationManager();
      if (!configManager) {
        return sendError(res, 500, 'CONFIG_ERROR', 'Configuration manager not available');
      }

      const componentConfig = configManager.getComponentConfig(
        pluginName, 
        componentName, 
        componentType as 'action' | 'provider' | 'evaluator' | 'service'
      );

      sendSuccess(res, { componentConfig });
    } catch (error) {
      logger.error(`[AGENT CONFIG] Error retrieving component ${componentName} configuration for plugin ${pluginName} in agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'CONFIG_ERROR',
        'Error retrieving component configuration',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Hot-swap: Enable specific component
  router.post('/:agentId/configurations/:pluginName/components/:componentType/:componentName/enable', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { pluginName, componentType, componentName } = req.params;
    if (!pluginName || !componentType || !componentName) {
      return sendError(res, 400, 'INVALID_PARAMS', 'Plugin name, component type, and component name are required');
    }

    if (!['action', 'provider', 'evaluator', 'service'].includes(componentType)) {
      return sendError(res, 400, 'INVALID_TYPE', 'Component type must be action, provider, evaluator, or service');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const { overrideReason = 'Enabled via API', settings = {} } = req.body;

      // Use the hot-swap configuration API
      await runtime.configurePlugin(pluginName, {
        [`${componentType}s`]: {
          [componentName]: {
            enabled: true,
            overrideLevel: 'gui',
            overrideReason,
            settings,
            lastModified: new Date()
          }
        }
      });

      // Emit WebSocket event
      serverInstance.emitToAll('component_enabled', {
        agentId,
        pluginName,
        componentType,
        componentName,
        timestamp: new Date().toISOString()
      });

      // Get updated component configuration
      const configManager = runtime.getConfigurationManager();
      const componentConfig = configManager.getComponentConfig(pluginName, componentName, componentType as 'action' | 'provider' | 'evaluator' | 'service');
      
      sendSuccess(res, { 
        message: `Component ${componentName} enabled successfully`,
        componentConfig 
      });
    } catch (error) {
      logger.error(`[AGENT CONFIG] Error enabling component ${componentName} for plugin ${pluginName} in agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'CONFIG_ERROR',
        'Error enabling component',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Hot-swap: Disable specific component
  router.post('/:agentId/configurations/:pluginName/components/:componentType/:componentName/disable', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { pluginName, componentType, componentName } = req.params;
    if (!pluginName || !componentType || !componentName) {
      return sendError(res, 400, 'INVALID_PARAMS', 'Plugin name, component type, and component name are required');
    }

    if (!['action', 'provider', 'evaluator', 'service'].includes(componentType)) {
      return sendError(res, 400, 'INVALID_TYPE', 'Component type must be action, provider, evaluator, or service');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const { overrideReason = 'Disabled via API' } = req.body;

      // Use the hot-swap configuration API
      await runtime.configurePlugin(pluginName, {
        [`${componentType}s`]: {
          [componentName]: {
            enabled: false,
            overrideLevel: 'gui',
            overrideReason,
            settings: {},
            lastModified: new Date()
          }
        }
      });

      // Emit WebSocket event
      serverInstance.emitToAll('component_disabled', {
        agentId,
        pluginName,
        componentType,
        componentName,
        timestamp: new Date().toISOString()
      });

      // Get updated component configuration
      const configManager = runtime.getConfigurationManager();
      const componentConfig = configManager.getComponentConfig(pluginName, componentName, componentType as 'action' | 'provider' | 'evaluator' | 'service');
      
      sendSuccess(res, { 
        message: `Component ${componentName} disabled successfully`,
        componentConfig 
      });
    } catch (error) {
      logger.error(`[AGENT CONFIG] Error disabling component ${componentName} for plugin ${pluginName} in agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'CONFIG_ERROR',
        'Error disabling component',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Hot-swap: Toggle component
  router.post('/:agentId/configurations/:pluginName/components/:componentType/:componentName/toggle', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { pluginName, componentType, componentName } = req.params;
    if (!pluginName || !componentType || !componentName) {
      return sendError(res, 400, 'INVALID_PARAMS', 'Plugin name, component type, and component name are required');
    }

    if (!['action', 'provider', 'evaluator', 'service'].includes(componentType)) {
      return sendError(res, 400, 'INVALID_TYPE', 'Component type must be action, provider, evaluator, or service');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      const configManager = runtime.getConfigurationManager();
      const currentConfig = configManager.getComponentConfig(pluginName, componentName, componentType as 'action' | 'provider' | 'evaluator' | 'service');
      
      const newEnabledState = !currentConfig.enabled;
      const { overrideReason = `${newEnabledState ? 'Enabled' : 'Disabled'} via API toggle` } = req.body;

      // Use the hot-swap configuration API
      await runtime.configurePlugin(pluginName, {
        [`${componentType}s`]: {
          [componentName]: {
            enabled: newEnabledState,
            overrideLevel: 'gui',
            overrideReason,
            settings: currentConfig.settings || {},
            lastModified: new Date()
          }
        }
      });

      // Emit WebSocket event
      serverInstance.emitToAll(newEnabledState ? 'component_enabled' : 'component_disabled', {
        agentId,
        pluginName,
        componentType,
        componentName,
        timestamp: new Date().toISOString()
      });

      // Get updated component configuration
      const updatedConfig = configManager.getComponentConfig(pluginName, componentName, componentType as 'action' | 'provider' | 'evaluator' | 'service');
      
      sendSuccess(res, { 
        message: `Component ${componentName} ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
        componentConfig: updatedConfig,
        previousState: currentConfig.enabled,
        newState: newEnabledState
      });
    } catch (error) {
      logger.error(`[AGENT CONFIG] Error toggling component ${componentName} for plugin ${pluginName} in agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'CONFIG_ERROR',
        'Error toggling component',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  // Get runtime component status (what's actually registered)
  router.get('/:agentId/configurations/:pluginName/runtime-status', async (req, res) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const { pluginName } = req.params;
    if (!pluginName) {
      return sendError(res, 400, 'INVALID_PLUGIN', 'Plugin name is required');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    try {
      // Get configuration state
      const configManager = runtime.getConfigurationManager();
      const pluginConfig = configManager.getPluginConfiguration(pluginName);

      // Get actual runtime registration status
      const runtimeStatus = {
        actions: runtime.actions.map(a => a.name),
        providers: runtime.providers.map(p => p.name),
        evaluators: runtime.evaluators.map(e => e.name),
        services: Array.from(runtime.services.keys())
      };

      // Compare configuration vs runtime
      const comparison = {
        actions: {},
        providers: {},
        evaluators: {},
        services: {}
      };

      if (pluginConfig) {
        // Check actions
        for (const [actionName, actionConfig] of Object.entries(pluginConfig.actions || {})) {
          comparison.actions[actionName] = {
            configured: actionConfig.enabled,
            registered: runtimeStatus.actions.includes(actionName),
            inSync: actionConfig.enabled === runtimeStatus.actions.includes(actionName)
          };
        }

        // Check providers
        for (const [providerName, providerConfig] of Object.entries(pluginConfig.providers || {})) {
          comparison.providers[providerName] = {
            configured: providerConfig.enabled,
            registered: runtimeStatus.providers.includes(providerName),
            inSync: providerConfig.enabled === runtimeStatus.providers.includes(providerName)
          };
        }

        // Check evaluators
        for (const [evaluatorName, evaluatorConfig] of Object.entries(pluginConfig.evaluators || {})) {
          comparison.evaluators[evaluatorName] = {
            configured: evaluatorConfig.enabled,
            registered: runtimeStatus.evaluators.includes(evaluatorName),
            inSync: evaluatorConfig.enabled === runtimeStatus.evaluators.includes(evaluatorName)
          };
        }

        // Check services
        for (const [serviceName, serviceConfig] of Object.entries(pluginConfig.services || {})) {
          comparison.services[serviceName] = {
            configured: serviceConfig.enabled,
            registered: runtimeStatus.services.includes(serviceName),
            inSync: serviceConfig.enabled === runtimeStatus.services.includes(serviceName)
          };
        }
      }

      sendSuccess(res, { 
        pluginName,
        configuration: pluginConfig,
        runtime: runtimeStatus,
        comparison,
        inSync: Object.values(comparison).every(componentGroup => 
          Object.values(componentGroup).every(comp => comp.inSync)
        )
      });
    } catch (error) {
      logger.error(`[AGENT CONFIG] Error retrieving runtime status for plugin ${pluginName} in agent ${agentId}:`, error);
      sendError(
        res,
        500,
        'CONFIG_ERROR',
        'Error retrieving runtime status',
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  return router;
}