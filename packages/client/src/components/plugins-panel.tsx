import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { usePlugins } from '@/hooks/use-plugins';
import type { Agent } from '@elizaos/core';
import { useMemo, useState } from 'react';
import { Button } from './ui/button';

interface PluginsPanelProps {
  characterValue: Agent;
  setCharacterValue: (value: (prev: Agent) => Agent) => void;
}

export default function PluginsPanel({ characterValue, setCharacterValue }: PluginsPanelProps) {
  const { data: plugins, error } = usePlugins();
  const [searchQuery, setSearchQuery] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const pluginNames = useMemo(() => {
    if (!plugins) return [];
    return Object.keys(plugins).map((name) => name.replace(/^@elizaos-plugins\//, '@elizaos/'));
  }, [plugins]);

  // Ensure we always have arrays and normalize plugin names
  const safeCharacterPlugins = useMemo(() => {
    if (!Array.isArray(characterValue?.plugins)) return [];
    return characterValue.plugins;
  }, [characterValue?.plugins]);

  const filteredPlugins = useMemo(() => {
    return pluginNames
      .filter((plugin) => !safeCharacterPlugins.includes(plugin))
      .filter((plugin) => plugin.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [pluginNames, safeCharacterPlugins, searchQuery]);

  const handlePluginToggle = (plugin: string) => {
    setCharacterValue((prev) => {
      const currentPlugins = Array.isArray(prev.plugins) ? prev.plugins : [];
      const newPlugins = currentPlugins.includes(plugin)
        ? currentPlugins.filter((p) => p !== plugin)
        : [...currentPlugins, plugin];

      return {
        ...prev,
        plugins: newPlugins,
      };
    });
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
              {safeCharacterPlugins.length > 0 && (
                <div className="rounded-md bg-muted p-4">
                  <h4 className="text-sm font-medium mb-2">Currently Enabled</h4>
                  <div className="flex flex-wrap gap-2">
                    {safeCharacterPlugins.map((plugin) => (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        key={plugin}
                        className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 h-auto"
                        onClick={() => handlePluginToggle(plugin)}
                      >
                        {plugin} ×
                      </Button>
                    ))}
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
                                handlePluginToggle(plugin);
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
