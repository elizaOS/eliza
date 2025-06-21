import { useState, useEffect, useMemo } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { 
  ChevronDown, 
  ChevronRight, 
  Settings, 
  Loader2, 
  Power, 
  PowerOff,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle
} from 'lucide-react';
import clsx from 'clsx';
import {
  usePluginConfigurations,
  useEnableComponent,
  useDisableComponent,
  useToggleComponent,
  useRuntimeStatus,
  usePluginConfigurationRealtime
} from '@/hooks/use-plugin-configurations';

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
  services?: Record<string, PluginComponentConfig>;
  settings?: Record<string, any>;
}

interface PluginComponentsPanelProps {
  agentId: string;
  plugins: string[];
  isOpen: boolean;
  onClose: () => void;
}

type ComponentType = 'actions' | 'providers' | 'evaluators' | 'services';

export default function PluginComponentsPanel({ 
  agentId, 
  plugins, 
  isOpen, 
  onClose 
}: PluginComponentsPanelProps) {
  const { toast } = useToast();
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [selectedPluginForStatus, setSelectedPluginForStatus] = useState<string | null>(null);

  // Use enhanced hooks for configuration management
  const { data: configurations, isLoading: loading, refetch: refetchConfigurations } = usePluginConfigurations(agentId);
  const enableComponent = useEnableComponent();
  const disableComponent = useDisableComponent();
  const toggleComponent = useToggleComponent();
  
  // Runtime status for selected plugin
  const { data: runtimeStatus, refetch: refetchRuntimeStatus } = useRuntimeStatus(
    agentId, 
    selectedPluginForStatus || ''
  );

  // Enable real-time updates
  usePluginConfigurationRealtime(agentId);

  const togglePluginExpanded = (pluginName: string) => {
    const newExpanded = new Set(expandedPlugins);
    if (newExpanded.has(pluginName)) {
      newExpanded.delete(pluginName);
      // Clear runtime status when collapsing
      if (selectedPluginForStatus === pluginName) {
        setSelectedPluginForStatus(null);
      }
    } else {
      newExpanded.add(pluginName);
    }
    setExpandedPlugins(newExpanded);
  };

  const toggleSectionExpanded = (sectionKey: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(sectionKey)) {
      newExpanded.delete(sectionKey);
    } else {
      newExpanded.add(sectionKey);
    }
    setExpandedSections(newExpanded);
  };

  const handleToggleComponent = async (
    pluginName: string,
    componentType: ComponentType,
    componentName: string
  ) => {
    try {
      const componentTypeMap: Record<ComponentType, 'action' | 'provider' | 'evaluator' | 'service'> = {
        actions: 'action',
        providers: 'provider', 
        evaluators: 'evaluator',
        services: 'service'
      };

      await toggleComponent.mutateAsync({
        agentId,
        pluginName,
        componentType: componentTypeMap[componentType],
        componentName,
        options: {
          overrideReason: 'Toggled via UI'
        }
      });

      toast({
        title: 'Success',
        description: `Component ${componentName} toggled successfully`,
      });
    } catch (error) {
      console.error('Failed to toggle component:', error);
      toast({
        title: 'Error',
        description: 'Failed to toggle component',
        variant: 'destructive',
      });
    }
  };

  const getPluginDisplayName = (pluginName: string) => {
    return pluginName.replace('@elizaos/', '').replace('plugin-', '');
  };

  const getComponentTypeDisplayName = (type: ComponentType) => {
    return type.charAt(0).toUpperCase() + type.slice(1);
  };

  const getComponentSyncStatus = (
    pluginName: string,
    componentType: ComponentType,
    componentName: string
  ) => {
    if (!runtimeStatus || selectedPluginForStatus !== pluginName) return null;
    
    const comparison = runtimeStatus.comparison?.[componentType]?.[componentName];
    if (!comparison) return null;
    
    return comparison;
  };

  const renderComponentSection = (
    pluginName: string,
    componentType: ComponentType,
    components: Record<string, PluginComponentConfig> | undefined
  ) => {
    if (!components || Object.keys(components).length === 0) {
      return null;
    }

    const sectionKey = `${pluginName}-${componentType}`;
    const isExpanded = expandedSections.has(sectionKey);

    return (
      <div key={componentType} className="border-l-2 border-muted ml-4 pl-4">
        <Collapsible>
          <CollapsibleTrigger
            onClick={() => toggleSectionExpanded(sectionKey)}
            className="flex items-center justify-between w-full py-2 text-left hover:bg-muted/30 rounded px-2"
          >
            <div className="flex items-center gap-2">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <span className="text-sm font-medium">
                {getComponentTypeDisplayName(componentType)} ({Object.keys(components).length})
              </span>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent className={clsx('space-y-2 mt-2', { hidden: !isExpanded })}>
            {Object.entries(components).map(([componentName, config]) => {
              const syncStatus = getComponentSyncStatus(pluginName, componentType, componentName);
              
              return (
                <div key={componentName} className="flex items-center justify-between py-2 px-3 bg-muted/20 rounded">
                  <div className="flex items-center space-x-3">
                    <Button
                      size="sm"
                      variant={config.enabled ? "default" : "outline"}
                      className="h-6 w-12 p-0 text-xs"
                      onClick={() => handleToggleComponent(pluginName, componentType, componentName)}
                      disabled={enableComponent.isPending || disableComponent.isPending || toggleComponent.isPending}
                    >
                      {config.enabled ? (
                        <>
                          <Power className="h-3 w-3 mr-1" />
                          ON
                        </>
                      ) : (
                        <>
                          <PowerOff className="h-3 w-3 mr-1" />
                          OFF
                        </>
                      )}
                    </Button>
                    
                    <div className="flex flex-col">
                      <label className="text-sm font-medium">
                        {componentName}
                      </label>
                      {syncStatus && (
                        <div className="flex items-center gap-1 text-xs">
                          {syncStatus.inSync ? (
                            <>
                              <CheckCircle className="h-3 w-3 text-green-500" />
                              <span className="text-green-600">In Sync</span>
                            </>
                          ) : (
                            <>
                              <AlertTriangle className="h-3 w-3 text-yellow-500" />
                              <span className="text-yellow-600">
                                Config: {syncStatus.configured ? 'ON' : 'OFF'} | 
                                Runtime: {syncStatus.registered ? 'ON' : 'OFF'}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {config.settings && Object.keys(config.settings).length > 0 && (
                      <Button size="sm" variant="ghost" className="h-6 w-6 p-0">
                        <Settings className="h-3 w-3" />
                      </Button>
                    )}
                    
                    {/* Status badge */}
                    <Badge variant={config.enabled ? "default" : "secondary"} className="text-xs">
                      {config.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  };

  const filteredPlugins = useMemo(() => {
    if (!configurations) return [];
    return plugins.filter(plugin => configurations[plugin]);
  }, [plugins, configurations]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Plugin Component Configuration
          </DialogTitle>
        </DialogHeader>
        
        <div className="flex flex-col gap-4 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="ml-2">Loading configurations...</span>
            </div>
          ) : (
            <div className="overflow-y-auto space-y-4 pr-2">
              {filteredPlugins.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No plugin configurations found
                </div>
              ) : (
                filteredPlugins.map((pluginName) => {
                  const config = configurations?.[pluginName];
                  if (!config) return null;
                  
                  const isExpanded = expandedPlugins.has(pluginName);
                  const showingRuntimeStatus = selectedPluginForStatus === pluginName;
                  
                  return (
                    <div key={pluginName} className="border rounded-lg p-4 space-y-3">
                      <Collapsible>
                        <CollapsibleTrigger
                          onClick={() => togglePluginExpanded(pluginName)}
                          className="flex items-center justify-between w-full text-left hover:bg-muted/30 rounded p-2"
                        >
                          <div className="flex items-center gap-2">
                            {isExpanded ? (
                              <ChevronDown className="h-5 w-5" />
                            ) : (
                              <ChevronRight className="h-5 w-5" />
                            )}
                            <span className="font-semibold">
                              {getPluginDisplayName(pluginName)}
                            </span>
                            <Badge variant={config.enabled ? "default" : "secondary"}>
                              {config.enabled ? 'Enabled' : 'Disabled'}
                            </Badge>
                          </div>
                          
                          <div className="flex items-center gap-2">
                            {runtimeStatus && showingRuntimeStatus && (
                              <Badge variant={runtimeStatus.inSync ? "default" : "destructive"}>
                                {runtimeStatus.inSync ? 'In Sync' : 'Out of Sync'}
                              </Badge>
                            )}
                          </div>
                        </CollapsibleTrigger>
                        
                        <CollapsibleContent className={clsx('space-y-3 mt-3', { hidden: !isExpanded })}>
                          {isExpanded && (
                            <div className="flex justify-end gap-2 mb-3">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  if (showingRuntimeStatus) {
                                    setSelectedPluginForStatus(null);
                                  } else {
                                    setSelectedPluginForStatus(pluginName);
                                  }
                                }}
                              >
                                <RefreshCw className="h-3 w-3 mr-1" />
                                {showingRuntimeStatus ? 'Hide Status' : 'Show Runtime Status'}
                              </Button>
                            </div>
                          )}
                          
                          {renderComponentSection(pluginName, 'actions', config.actions)}
                          {renderComponentSection(pluginName, 'providers', config.providers)}
                          {renderComponentSection(pluginName, 'evaluators', config.evaluators)}
                          {renderComponentSection(pluginName, 'services', config.services)}
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                  );
                })
              )}
            </div>
          )}
          
          <div className="flex justify-between gap-2 pt-4 border-t">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="flex items-center gap-1">
                <CheckCircle className="h-3 w-3 text-green-500" />
                In Sync
              </div>
              <div className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-yellow-500" />
                Out of Sync
              </div>
            </div>
            
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button onClick={() => refetchConfigurations()}>
                <RefreshCw className="h-3 w-3 mr-1" />
                Refresh
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}