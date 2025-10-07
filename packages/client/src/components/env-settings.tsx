import { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from './ui/input';
import { Check, Eye, EyeOff, MoreVertical, Settings, X } from 'lucide-react';
import { Button } from './ui/button';
import { createElizaClient } from '@/lib/api-client-config';
import { ApiKeyDialog } from './api-key-dialog';
import { useToast } from '@/hooks/use-toast';

export default function EnvSettings() {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedValue, setEditedValue] = useState('');
  const [localEnvs, setLocalEnvs] = useState<Record<string, string>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenIndex(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    fetchLocalEnvs();
  }, []);

  const fetchLocalEnvs = async () => {
    const elizaClient = createElizaClient();
    const data = await elizaClient.system.getEnvironment();
    setLocalEnvs(data);
  };

  const handleReset = async () => {
    await fetchLocalEnvs();

    setEditingIndex(null);
    setOpenIndex(null);
    setName('');
    setValue('');
  };

  const handleEdit = (key: string) => {
    setEditingIndex(openIndex);
    setEditedValue(localEnvs[key]);
    setOpenIndex(null);
  };

  const handleRemove = (key: string) => {
    const updatedData = { ...localEnvs };
    delete updatedData[key];
    setLocalEnvs(updatedData);
    setOpenIndex(null);
  };

  const saveEdit = (key: string) => {
    setLocalEnvs({
      ...localEnvs,
      [key]: editedValue,
    });
    setEditingIndex(null);
  };

  const addEnv = () => {
    if (!name || !value) return;

    setLocalEnvs({
      ...localEnvs,
      [name]: value,
    });

    setName('');
    setValue('');
    setEditingIndex(null);
  };

  // Dummy function for onApiKeySaved
  const handleApiKeySaved = () => {
    console.log('API Key was saved');
    // Potentially refetch envs or perform other actions here
  };

  return (
    <div className="container max-w-4xl mx-auto p-6">
      <ApiKeyDialog
        open={isApiKeyDialogOpen}
        onOpenChange={setIsApiKeyDialogOpen}
        onApiKeySaved={handleApiKeySaved}
      />

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Env settings</h1>
          <p className="text-muted-foreground mt-1">Env settings</p>
        </div>
        <Button onClick={() => setIsApiKeyDialogOpen(true)} aria-label="Manage API Key">
          <Settings className="h-5 w-5" />
          Manage API Key
        </Button>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="space-y-6">
            <div className="rounded-lg w-full flex flex-col gap-3">
              <h2 className="text-xl font-bold mb-4 pb-5 ml-1">Environment Settings</h2>
              <div className="grid grid-cols-[1fr_2fr_auto] gap-4 items-end w-full pb-4">
                <div className="flex flex-col gap-1">
                  <label htmlFor="secret-name" className="ml-2 text-xs font-medium text-gray-400">
                    NAME
                  </label>
                  <Input
                    id="secret-name"
                    placeholder="VARIABLE_NAME"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1 relative">
                  <label htmlFor="secret-value" className="ml-2 text-xs font-medium text-gray-400">
                    VALUE
                  </label>
                  <div className="relative">
                    <Input
                      id="secret-value"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="i9ju23nfsdf56"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      className="pr-10"
                    />
                    <div
                      className="absolute inset-y-0 right-3 flex items-center cursor-pointer text-gray-500"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </div>
                  </div>
                </div>
                <Button className="shrink-0" onClick={addEnv}>
                  Add
                </Button>
              </div>

              {Object.keys(localEnvs).length > 0 && (
                <div className="grid grid-cols-[1fr_2fr_auto] gap-4 mt-6 font-medium text-gray-400 border-b pb-2 ml-1">
                  <div>Name</div>
                  <div>Value</div>
                  <div>Action</div>
                </div>
              )}

              <div className="mt-2">
                {Object.entries(localEnvs).map(([key, value], index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[1fr_2fr_auto] gap-4 items-center border-b py-2 ml-1 relative"
                  >
                    <div className="truncate max-w-48">{key}</div>
                    <div>
                      {editingIndex === index ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={editedValue}
                            onChange={(e) => setEditedValue(e.target.value)}
                            className="w-full"
                          />
                          <Button variant="ghost" onClick={() => saveEdit(key)}>
                            <Check className="w-5 h-5 text-green-500" />
                          </Button>
                          <Button variant="ghost" onClick={() => setEditingIndex(null)}>
                            <X className="w-5 h-5 text-red-500" />
                          </Button>
                        </div>
                      ) : (
                        <div className="truncate text-gray-500">Encrypted</div>
                      )}
                    </div>
                    <div className="relative">
                      <Button
                        variant="ghost"
                        className="p-2 text-gray-500"
                        onClick={() => setOpenIndex(openIndex === index ? null : index)}
                      >
                        <MoreVertical className="h-5 w-5" />
                      </Button>
                      {openIndex === index && (
                        <div
                          ref={dropdownRef}
                          className="absolute right-0 mt-2 w-56 rounded-md shadow-lg bg-card ring-1 ring-black ring-opacity-5 z-10"
                        >
                          <div className="py-1">
                            <button
                              onClick={() => handleEdit(key)}
                              className="w-full text-left px-4 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleRemove(key)}
                              className="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-accent"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2 mt-4 justify-end">
        <Button variant="outline" onClick={handleReset}>
          Reset
        </Button>
        <Button
          type="submit"
          disabled={isUpdating}
          onClick={async () => {
            setIsUpdating(true);
            try {
              const elizaClient = createElizaClient();
              await elizaClient.system.updateLocalEnvironment(localEnvs);
              toast({
                title: 'Success',
                description: 'Environment variables updated successfully!',
              });
            } catch (error) {
              toast({
                title: 'Error',
                description: 'Failed to update environment variables.',
                variant: 'destructive',
              });
            } finally {
              setIsUpdating(false);
            }
          }}
        >
          Save Changes
        </Button>
      </div>
    </div>
  );
}
