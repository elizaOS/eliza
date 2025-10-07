import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { usePlugins } from '@/hooks/use-plugins';
import { useToast } from '@/hooks/use-toast';
import type { Agent } from '@elizaos/core';
import clsx from 'clsx';
import { CircleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  // getAllRequiredPlugins,
  getVoiceModelByValue,
  providerPluginMap,
} from '../config/voice-models';
import { Button } from './ui/button';

interface PluginsPanelProps {
  characterValue: Agent;
  setCharacterValue: {
    addPlugin?: (pluginId: string) => void;
    removePlugin?: (index: number) => void;
    setPlugins?: (plugins: string[]) => void;
    updateField?: <T>(path: string, value: T) => void;
    [key: string]: any;
  };
  initialPlugins?: string[];
}

// Define a type for the essential plugin information
type EssentialPluginInfo = {
  title: string;
  description: string;
};

// Map of essential plugins that require confirmation when removing
const ESSENTIAL_PLUGINS: Record<string, EssentialPluginInfo> = {
  '@elizaos/plugin-sql': {
    title: 'Essential Plugin: SQL',
    description:
      'Provides memory and state storage. If removed, replace with an adapter plugin or your agent may lose conversation history and memory capabilities.',
  },
  '@elizaos/plugin-openai': {
    title: 'Essential Plugin: OpenAI',
    description:
      'Provides language model access. If removed, replace with another LLM plugin or your agent may fail to function properly.',
  },
  '@elizaos/plugin-bootstrap': {
    title: 'Essential Plugin: Bootstrap',
    description:
      'Provides default message processing, event handling, and attachment workflows for your agent. If removed, ensure you have a custom plugin handling these responsibilities, or your agent may not process events or respond to messages as expected.',
  },
};

export default function PluginsPanel({
  characterValue,
  setCharacterValue,
  initialPlugins,
}: PluginsPanelProps) {
  const { data: plugins, error } = usePlugins();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);

  // Ensure we always have arrays and normalize plugin names
  const safeCharacterPlugins = useMemo(() => {
    if (!Array.isArray(characterValue?.plugins)) return [];
    return characterValue.plugins;
  }, [characterValue?.plugins]);

  // Get plugin names from available plugins
  const pluginNames = useMemo(() => {
    const defaultPlugins = ['@elizaos/plugin-sql'];
    if (!plugins) return defaultPlugins;
    return [
      ...defaultPlugins,
      ...(Array.isArray(plugins) ? plugins : Object.keys(plugins)).filter(
        (name) => !defaultPlugins.includes(name)
      ),
    ];
  }, [plugins]);

  // Check if the selected voice model requires specific plugins
  const voiceModelPluginInfo = useMemo(() => {
    const settings = characterValue?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;

    const voice = settings.voice;
    if (!voice || typeof voice !== 'object' || Array.isArray(voice)) return null;

    const voiceModelValue = voice.model;
    if (!voiceModelValue || typeof voiceModelValue !== 'string') return null;

    const voiceModel = getVoiceModelByValue(voiceModelValue);
    if (!voiceModel) return null;

    // Get required plugin from configuration
    const requiredPlugin = providerPluginMap[voiceModel.provider];
    const isPluginEnabled = safeCharacterPlugins.includes(requiredPlugin);

    return {
      provider: voiceModel.provider,
      requiredPlugin,
      isPluginEnabled,
    };
  }, [characterValue?.settings, safeCharacterPlugins]);

  // Get all voice-related plugins that are currently enabled
  // const enabledVoicePlugins = useMemo(() => {
  //   const voicePlugins = getAllRequiredPlugins();
  //   return safeCharacterPlugins.filter((plugin) => voicePlugins.includes(plugin));
  // }, [safeCharacterPlugins]);

  const hasChanged = useMemo(() => {
    if (!initialPlugins) return false;
    if (initialPlugins.length !== safeCharacterPlugins.length) return true;
    return !initialPlugins?.every((plugin) => safeCharacterPlugins.includes(plugin));
  }, [safeCharacterPlugins, initialPlugins]);

  const filteredPlugins = useMemo(() => {
    return pluginNames
      .filter((plugin) => !safeCharacterPlugins.includes(plugin))
      .filter((plugin) => plugin.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [pluginNames, safeCharacterPlugins, searchQuery]);

  const handlePluginAdd = (plugin: string) => {
    if (safeCharacterPlugins.includes(plugin)) return;

    if (setCharacterValue.addPlugin) {
      setCharacterValue.addPlugin(plugin);
    } else if (setCharacterValue.updateField) {
      const currentPlugins = Array.isArray(characterValue.plugins)
        ? [...characterValue.plugins]
        : [];
      setCharacterValue.updateField('plugins', [...currentPlugins, plugin]);
    }
  };

  const handlePluginRemove = (plugin: string) => {
    // Check if it's an essential plugin that needs confirmation
    if (Object.keys(ESSENTIAL_PLUGINS).includes(plugin)) {
      setPendingRemoval(plugin);
      setIsConfirmDialogOpen(true);
      return;
    }

    // If not essential, proceed with removal immediately
    removePlugin(plugin);
  };

  // Actual plugin removal after confirmation (if required)
  const removePlugin = (plugin: string) => {
    const index = safeCharacterPlugins.indexOf(plugin);
    if (index !== -1) {
      if (setCharacterValue.removePlugin) {
        setCharacterValue.removePlugin(index);
      } else if (setCharacterValue.updateField) {
        const newPlugins = [...safeCharacterPlugins];
        newPlugins.splice(index, 1);
        setCharacterValue.updateField('plugins', newPlugins);
      }
    }
  };

  // Function to handle confirmation dialog acceptance
  const handleConfirmRemoval = () => {
    if (pendingRemoval) {
      removePlugin(pendingRemoval);
      setPendingRemoval(null);
    }
    setIsConfirmDialogOpen(false);
  };

  // Function to handle confirmation dialog cancellation
  const handleCancelRemoval = () => {
    setPendingRemoval(null);
    setIsConfirmDialogOpen(false);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold mb-4">Plugins</h3>
          {error ? (
            <p className="text-destructive">Failed to load plugins: {error.message}</p>
          ) : (
            <div className="space-y-4">
              {/* Alert Dialog for Essential Plugin Removal */}
              <AlertDialog open={isConfirmDialogOpen} onOpenChange={setIsConfirmDialogOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {pendingRemoval && Object.keys(ESSENTIAL_PLUGINS).includes(pendingRemoval)
                        ? ESSENTIAL_PLUGINS[pendingRemoval].title
                        : 'Warning: Essential Plugin'}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {pendingRemoval && Object.keys(ESSENTIAL_PLUGINS).includes(pendingRemoval)
                        ? ESSENTIAL_PLUGINS[pendingRemoval].description
                        : 'This plugin provides essential functionality for your agent.'}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel onClick={handleCancelRemoval}>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleConfirmRemoval}>
                      Confirm Removal
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {voiceModelPluginInfo && (
                <div className="rounded-md border p-4 mb-4 flex items-center gap-2">
                  <CircleAlert className="h-4 w-4 text-yellow-500" />
                  <p className="text-xs text-white">
                    {(() => {
                      switch (voiceModelPluginInfo.provider) {
                        case 'elevenlabs':
                          return 'ElevenLabs plugin is required for the selected voice model.';
                        case 'openai':
                          return 'OpenAI plugin is required for the selected voice model.';
                        case 'none':
                          return 'No voice plugin required for "No Voice" option.';
                        default:
                          return `${voiceModelPluginInfo.provider} plugin is required for the selected voice model.`;
                      }
                    })()}
                  </p>
                  {/* 
                    Commented out for now — this warning doesn't make sense when using ElevenLabs voice model with OpenAI plugin.
                  */}
                  {/* {enabledVoicePlugins.length > 1 && (
                    <p className="text-xs text-amber-600 mt-2">
                      Multiple voice plugins detected. This may cause conflicts. Consider removing
                      unused voice plugins.
                    </p>
                  )} */}
                </div>
              )}
              {safeCharacterPlugins.length > 0 && (
                <div className="rounded-md bg-muted p-4">
                  <h4 className="text-sm font-medium mb-2">Currently Enabled</h4>
                  <div className="flex flex-wrap gap-2">
                    {[...safeCharacterPlugins]
                      .sort((a, b) => {
                        const aIsEssential = Object.keys(ESSENTIAL_PLUGINS).includes(a);
                        const bIsEssential = Object.keys(ESSENTIAL_PLUGINS).includes(b);
                        if (aIsEssential === bIsEssential) return 0;
                        return aIsEssential ? -1 : 1;
                      })
                      .map((plugin) => {
                        // Check if this plugin is required by the current voice model
                        const isRequiredByVoice = voiceModelPluginInfo?.requiredPlugin === plugin;
                        // Check if this is an essential plugin (SQL or OpenAI)
                        const isEssential = Object.keys(ESSENTIAL_PLUGINS).includes(plugin);

                        return (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            key={plugin}
                            className={`inline-flex items-center rounded-full ${
                              isEssential
                                ? 'bg-blue-800 text-blue-700 hover:bg-blue-600'
                                : 'bg-primary/10 text-primary hover:bg-primary/20'
                            } px-2.5 py-0.5 text-xs font-medium h-auto`}
                            title={
                              isRequiredByVoice
                                ? 'Required by voice model'
                                : isEssential
                                  ? 'Essential plugin for agent functionality'
                                  : ''
                            }
                          >
                            {isEssential && (
                              <span className="w-2 h-2 rounded-full bg-white inline-block"></span>
                            )}
                            <span className="text-white font-semibold">{plugin}</span>
                            <span
                              className={clsx(
                                'ml-1 opacity-70 hover:opacity-100',
                                isEssential && 'text-white'
                              )}
                              onClick={() => {
                                // Don't allow removing if it's required by the voice model
                                if (isRequiredByVoice) {
                                  toast({
                                    title: "Can't Remove Plugin",
                                    description:
                                      'This plugin is required by the selected voice model.',
                                    variant: 'destructive',
                                  });
                                  return;
                                }
                                handlePluginRemove(plugin);
                              }}
                            >
                              ×
                            </span>
                          </Button>
                        );
                      })}
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center">
                      <span className="w-2 h-2 rounded-full bg-blue-600 mr-1"></span>
                      Essential plugins provide core functionality
                    </span>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" className="w-full justify-start">
                      Search and add plugins...
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-[400px]">
                    <DialogHeader>
                      <DialogTitle>Add Plugins</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Input
                          type="search"
                          placeholder="Search plugins..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                        />
                      </div>
                      <div className="max-h-[300px] overflow-y-auto space-y-2">
                        {filteredPlugins.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No plugins found.</p>
                        ) : (
                          filteredPlugins.map((plugin) => (
                            <Button
                              key={plugin}
                              variant="ghost"
                              className="w-full justify-start font-normal"
                              onClick={() => {
                                handlePluginAdd(plugin);
                                setSearchQuery('');
                                setIsDialogOpen(false);
                              }}
                            >
                              {plugin}
                            </Button>
                          ))
                        )}
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
              {hasChanged && (
                <p className="text-xs text-yellow-500">Plugins configuration has been changed</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
