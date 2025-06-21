import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiClient } from '@/lib/api';
import { SocketIOManager } from '@/lib/socketio-manager';
import clientLogger from '@/lib/logger';

interface PluginComponentConfig {
  enabled: boolean;
  settings?: Record<string, any>;
}

interface PluginConfiguration {
  pluginName: string;
  enabled: boolean;
  actions?: Record<string, PluginComponentConfig>;
  providers?: Record<string, PluginComponentConfig>;
  evaluators?: Record<string, PluginComponentConfig>;
  settings?: Record<string, any>;
}

/**
 * Hook for fetching plugin configurations for a specific agent
 */
export function usePluginConfigurations(agentId: string) {
  return useQuery({
    queryKey: ['plugin-configurations', agentId],
    queryFn: async () => {
      if (!agentId) {
        throw new Error('Agent ID is required');
      }
      
      try {
        const response = await apiClient.getAgentConfigurations(agentId);
        
        if (!response.success) {
          throw new Error('Failed to fetch plugin configurations');
        }
        
        const configMap: Record<string, PluginConfiguration> = {};
        response.data.configurations.forEach((config: PluginConfiguration) => {
          configMap[config.pluginName] = config;
        });
        
        return configMap;
      } catch (error) {
        clientLogger.error('Failed to fetch plugin configurations:', error);
        throw error;
      }
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Hook for fetching a specific plugin configuration
 */
export function usePluginConfiguration(agentId: string, pluginName: string) {
  return useQuery({
    queryKey: ['plugin-configuration', agentId, pluginName],
    queryFn: async () => {
      if (!agentId || !pluginName) {
        throw new Error('Agent ID and plugin name are required');
      }
      
      try {
        const response = await apiClient.getPluginConfiguration(agentId, pluginName);
        
        if (!response.success) {
          throw new Error(`Failed to fetch configuration for plugin: ${pluginName}`);
        }
        
        return response.data.configuration;
      } catch (error) {
        clientLogger.error(`Failed to fetch configuration for plugin ${pluginName}:`, error);
        throw error;
      }
    },
    enabled: !!agentId && !!pluginName,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Hook for updating component configuration
 */
export function useUpdateComponentConfiguration() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({
      agentId,
      pluginName,
      componentType,
      componentName,
      config,
      dependencies = []
    }: {
      agentId: string;
      pluginName: string;
      componentType: 'action' | 'provider' | 'evaluator';
      componentName: string;
      config: any;
      dependencies?: string[];
    }) => {
      const response = await apiClient.updateComponentConfiguration(
        agentId,
        pluginName,
        componentType,
        componentName,
        config,
        dependencies
      );
      
      if (!response.success) {
        throw new Error('Failed to update component configuration');
      }
      
      return response.data;
    },
    onSuccess: (data, variables) => {
      // Invalidate and refetch the plugin configurations cache
      queryClient.invalidateQueries({
        queryKey: ['plugin-configurations', variables.agentId]
      });
      
      // Invalidate the specific plugin configuration cache
      queryClient.invalidateQueries({
        queryKey: ['plugin-configuration', variables.agentId, variables.pluginName]
      });
      
      clientLogger.info(`Updated ${variables.componentName} configuration`);
    },
    onError: (error, variables) => {
      clientLogger.error(`Failed to update ${variables.componentName} configuration:`, error);
    }
  });
}

/**
 * Hook for updating entire plugin configuration
 */
export function useUpdatePluginConfiguration() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({
      agentId,
      pluginName,
      configuration
    }: {
      agentId: string;
      pluginName: string;
      configuration: any;
    }) => {
      const response = await apiClient.updatePluginConfiguration(agentId, pluginName, configuration);
      
      if (!response.success) {
        throw new Error('Failed to update plugin configuration');
      }
      
      return response.data;
    },
    onSuccess: (data, variables) => {
      // Invalidate and refetch the plugin configurations cache
      queryClient.invalidateQueries({
        queryKey: ['plugin-configurations', variables.agentId]
      });
      
      // Invalidate the specific plugin configuration cache
      queryClient.invalidateQueries({
        queryKey: ['plugin-configuration', variables.agentId, variables.pluginName]
      });
      
      clientLogger.info(`Updated ${variables.pluginName} plugin configuration`);
    },
    onError: (error, variables) => {
      clientLogger.error(`Failed to update ${variables.pluginName} plugin configuration:`, error);
    }
  });
}

/**
 * Hook for enabling a component with hot-swap
 */
export function useEnableComponent() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({
      agentId,
      pluginName,
      componentType,
      componentName,
      options = {}
    }: {
      agentId: string;
      pluginName: string;
      componentType: 'action' | 'provider' | 'evaluator' | 'service';
      componentName: string;
      options?: { overrideReason?: string; settings?: any };
    }) => {
      const response = await apiClient.enableComponent(
        agentId,
        pluginName,
        componentType,
        componentName,
        options
      );
      
      if (!response.success) {
        throw new Error('Failed to enable component');
      }
      
      return response.data;
    },
    onSuccess: (data, variables) => {
      // Invalidate and refetch caches
      queryClient.invalidateQueries({
        queryKey: ['plugin-configurations', variables.agentId]
      });
      queryClient.invalidateQueries({
        queryKey: ['plugin-configuration', variables.agentId, variables.pluginName]
      });
      queryClient.invalidateQueries({
        queryKey: ['runtime-status', variables.agentId, variables.pluginName]
      });
      
      clientLogger.info(`Enabled ${variables.componentName} component`);
    },
    onError: (error, variables) => {
      clientLogger.error(`Failed to enable ${variables.componentName} component:`, error);
    }
  });
}

/**
 * Hook for disabling a component with hot-swap
 */
export function useDisableComponent() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({
      agentId,
      pluginName,
      componentType,
      componentName,
      options = {}
    }: {
      agentId: string;
      pluginName: string;
      componentType: 'action' | 'provider' | 'evaluator' | 'service';
      componentName: string;
      options?: { overrideReason?: string };
    }) => {
      const response = await apiClient.disableComponent(
        agentId,
        pluginName,
        componentType,
        componentName,
        options
      );
      
      if (!response.success) {
        throw new Error('Failed to disable component');
      }
      
      return response.data;
    },
    onSuccess: (data, variables) => {
      // Invalidate and refetch caches
      queryClient.invalidateQueries({
        queryKey: ['plugin-configurations', variables.agentId]
      });
      queryClient.invalidateQueries({
        queryKey: ['plugin-configuration', variables.agentId, variables.pluginName]
      });
      queryClient.invalidateQueries({
        queryKey: ['runtime-status', variables.agentId, variables.pluginName]
      });
      
      clientLogger.info(`Disabled ${variables.componentName} component`);
    },
    onError: (error, variables) => {
      clientLogger.error(`Failed to disable ${variables.componentName} component:`, error);
    }
  });
}

/**
 * Hook for toggling a component with hot-swap
 */
export function useToggleComponent() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({
      agentId,
      pluginName,
      componentType,
      componentName,
      options = {}
    }: {
      agentId: string;
      pluginName: string;
      componentType: 'action' | 'provider' | 'evaluator' | 'service';
      componentName: string;
      options?: { overrideReason?: string };
    }) => {
      const response = await apiClient.toggleComponent(
        agentId,
        pluginName,
        componentType,
        componentName,
        options
      );
      
      if (!response.success) {
        throw new Error('Failed to toggle component');
      }
      
      return response.data;
    },
    onSuccess: (data, variables) => {
      // Invalidate and refetch caches
      queryClient.invalidateQueries({
        queryKey: ['plugin-configurations', variables.agentId]
      });
      queryClient.invalidateQueries({
        queryKey: ['plugin-configuration', variables.agentId, variables.pluginName]
      });
      queryClient.invalidateQueries({
        queryKey: ['runtime-status', variables.agentId, variables.pluginName]
      });
      
      clientLogger.info(`Toggled ${variables.componentName} component: ${data.previousState} → ${data.newState}`);
    },
    onError: (error, variables) => {
      clientLogger.error(`Failed to toggle ${variables.componentName} component:`, error);
    }
  });
}

/**
 * Hook for fetching runtime status comparison
 */
export function useRuntimeStatus(agentId: string, pluginName: string) {
  return useQuery({
    queryKey: ['runtime-status', agentId, pluginName],
    queryFn: async () => {
      if (!agentId || !pluginName) {
        throw new Error('Agent ID and plugin name are required');
      }
      
      try {
        const response = await apiClient.getRuntimeStatus(agentId, pluginName);
        
        if (!response.success) {
          throw new Error(`Failed to fetch runtime status for plugin: ${pluginName}`);
        }
        
        return response.data;
      } catch (error) {
        clientLogger.error(`Failed to fetch runtime status for plugin ${pluginName}:`, error);
        throw error;
      }
    },
    enabled: !!agentId && !!pluginName,
    staleTime: 30 * 1000, // 30 seconds - more frequent for runtime status
    refetchOnWindowFocus: false,
  });
}

/**
 * Hook for real-time plugin configuration updates via WebSocket
 */
export function usePluginConfigurationRealtime(agentId: string) {
  const queryClient = useQueryClient();
  
  useEffect(() => {
    if (!agentId) return;
    
    const socketManager = SocketIOManager.getInstance();
    
    // Listen for component enabled events
    const handleComponentEnabled = (data: any) => {
      if (data.agentId === agentId) {
        clientLogger.info(`Component enabled: ${data.pluginName}.${data.componentName}`);
        
        // Invalidate caches to trigger refetch
        queryClient.invalidateQueries({
          queryKey: ['plugin-configurations', agentId]
        });
        queryClient.invalidateQueries({
          queryKey: ['plugin-configuration', agentId, data.pluginName]
        });
        queryClient.invalidateQueries({
          queryKey: ['runtime-status', agentId, data.pluginName]
        });
      }
    };
    
    // Listen for component disabled events
    const handleComponentDisabled = (data: any) => {
      if (data.agentId === agentId) {
        clientLogger.info(`Component disabled: ${data.pluginName}.${data.componentName}`);
        
        // Invalidate caches to trigger refetch
        queryClient.invalidateQueries({
          queryKey: ['plugin-configurations', agentId]
        });
        queryClient.invalidateQueries({
          queryKey: ['plugin-configuration', agentId, data.pluginName]
        });
        queryClient.invalidateQueries({
          queryKey: ['runtime-status', agentId, data.pluginName]
        });
      }
    };
    
    // Register event listeners
    socketManager.on('component_enabled', handleComponentEnabled);
    socketManager.on('component_disabled', handleComponentDisabled);
    
    // Cleanup on unmount
    return () => {
      socketManager.off('component_enabled', handleComponentEnabled);
      socketManager.off('component_disabled', handleComponentDisabled);
    };
  }, [agentId, queryClient]);
}

export type { PluginConfiguration, PluginComponentConfig };