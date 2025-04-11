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
import { useMemo, useState, useEffect } from 'react';
import { Button } from './ui/button';
import {
  getVoiceModelByValue,
  providerPluginMap,
  getAllRequiredPlugins,
} from '../config/voice-models';

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

export default function PluginsPanel({
  characterValue,
  setCharacterValue,
  initialPlugins,
}: PluginsPanelProps) {
  const { data: plugins, error } = usePlugins();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // Ensure we always have arrays and normalize plugin names
  const safeCharacterPlugins = useMemo(() => {
    if (!Array.isArray(characterValue?.plugins)) return [];
    return characterValue.plugins;
  }, [characterValue?.plugins]);

  // Get plugin names from available plugins
  const pluginNames = useMemo(() => {
    const defaultPlugins = ['@elizaos/plugin-sql', '@elizaos/plugin-local-ai'];
    if (!plugins) return defaultPlugins;
    return [
      ...defaultPlugins,
      ...(Array.isArray(plugins) ? plugins : Object.keys(plugins))
        .map((name) => name.replace(/^@elizaos-plugins\//, '@elizaos/'))
        .filter((name) => !defaultPlugins.includes(name)),
    ];
  }, [plugins]);

  // Check if the selected voice model requires specific plugins
  const voiceModelPluginInfo = useMemo(() => {
    const voiceModelValue = characterValue?.settings?.voice?.model;
    if (!voiceModelValue) return null;

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
  }, [characterValue?.settings?.voice?.model, safeCharacterPlugins]);

  // Get all voice-related plugins that are currently enabled
  const enabledVoicePlugins = useMemo(() => {
    const voicePlugins = getAllRequiredPlugins();
    return safeCharacterPlugins.filter((plugin) => voicePlugins.includes(plugin));
  }, [safeCharacterPlugins]);

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

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold mb-4">Plugins</h3>
          {error ? (
            <p className="text-destructive">Failed to load plugins: {error.message}</p>
          ) : (
            <div className="space-y-4">
              {voiceModelPluginInfo && (
                <div className="rounded-md bg-blue-50 p-4 mb-4">
                  <p className="text-xs text-blue-700">
                    {(() => {
                      switch (voiceModelPluginInfo.provider) {
                        case 'elevenlabs':
                          return 'ElevenLabs plugin is required for the selected voice model.';
                        case 'openai':
                          return 'OpenAI plugin is required for the selected voice model.';
                        case 'local':
                          return 'Local AI plugin is required for the selected voice model.';
                        case 'none':
                          return 'No voice plugin required for "No Voice" option.';
                        default:
                          return `${voiceModelPluginInfo.provider} plugin is required for the selected voice model.`;
                      }
                    })()}
                  </p>
                  {enabledVoicePlugins.length > 1 && (
                    <p className="text-xs text-amber-600 mt-2">
                      Multiple voice plugins detected. This may cause conflicts. Consider removing
                      unused voice plugins.
                    </p>
                  )}
                </div>
              )}
              {safeCharacterPlugins.length > 0 && (
                <div className="rounded-md bg-muted p-4">
                  <h4 className="text-sm font-medium mb-2">Currently Enabled</h4>
                  <div className="flex flex-wrap gap-2">
                    {safeCharacterPlugins.map((plugin) => {
                      // Check if this plugin is required by the current voice model
                      const isRequiredByVoice = voiceModelPluginInfo?.requiredPlugin === plugin;

                      return (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          key={plugin}
                          className={`inline-flex items-center rounded-full ${
                            isRequiredByVoice
                              ? 'bg-green-100 text-green-700 hover:bg-green-200'
                              : 'bg-primary/10 text-primary hover:bg-primary/20'
                          } px-2.5 py-0.5 text-xs font-medium h-auto`}
                          onClick={() => {
                            // Don't allow removing if it's required by the voice model
                            if (isRequiredByVoice) {
                              toast({
                                title: "Can't Remove Plugin",
                                description: 'This plugin is required by the selected voice model.',
                                variant: 'destructive',
                              });
                              return;
                            }
                            handlePluginRemove(plugin);
                          }}
                          title={isRequiredByVoice ? 'Required by voice model' : 'Click to remove'}
                        >
                          {plugin} {!isRequiredByVoice && '×'}
                        </Button>
                      );
                    })}
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
