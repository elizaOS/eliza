import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Agent } from '@elizaos/core';
import { Check, CloudUpload, Eye, EyeOff, MoreVertical, X, AlertCircle } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  useCallback,
  useMemo,
} from 'react';
import { useRequiredSecrets } from '@/hooks/use-plugin-details';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';

type EnvVariable = {
  name: string;
  value: string;
  isNew?: boolean;
  isModified?: boolean;
  isDeleted?: boolean;
  isRequired?: boolean;
  description?: string;
  example?: string;
  plugin?: string;
};

interface SecretPanelProps {
  characterValue: Agent;
  onChange?: (secrets: Record<string, string | null>) => void;
}

export interface SecretPanelRef {
  getSecrets: () => Record<string, string | null>;
  validateSecrets: () => { isValid: boolean; missingSecrets: string[] };
}

export const SecretPanel = forwardRef<SecretPanelRef, SecretPanelProps>(
  ({ characterValue, onChange }, ref) => {
    const [envs, setEnvs] = useState<EnvVariable[]>([]);
    const [name, setName] = useState('');
    const [value, setValue] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [editedValue, setEditedValue] = useState('');
    const [isDragging, setIsDragging] = useState(false);
    const [deletedKeys, setDeletedKeys] = useState<string[]>([]);
    const [visibleSecrets, setVisibleSecrets] = useState<Set<number>>(new Set());
    const lastAgentIdRef = useRef<string | null>(null);
    const lastSecretsRef = useRef<string>('');

    const dropRef = useRef<HTMLDivElement>(null);
    const lastRequiredSecretsKeyRef = useRef<string>('');

    // Get required secrets based on enabled plugins
    const enabledPlugins = useMemo(() => characterValue?.plugins || [], [characterValue?.plugins]);
    const { requiredSecrets, isLoading: isLoadingSecrets } = useRequiredSecrets(enabledPlugins);

    // Function to get current secrets
    const getCurrentSecrets = useCallback(() => {
      const currentSecrets: Record<string, string | null> = {};

      envs.forEach(({ name, value }) => {
        currentSecrets[name] = value;
      });

      deletedKeys.forEach((key) => {
        currentSecrets[key] = null;
      });

      return currentSecrets;
    }, [envs, deletedKeys]);

    // Function to validate if all required secrets are provided
    const validateSecrets = useCallback(() => {
      const currentSecrets = getCurrentSecrets();
      const missingSecrets = requiredSecrets
        .filter((secret) => {
          const value = currentSecrets[secret.name];
          return !value || value.trim() === '';
        })
        .map((secret) => secret.name);

      return {
        isValid: missingSecrets.length === 0,
        missingSecrets,
      };
    }, [getCurrentSecrets, requiredSecrets]);

    // Expose methods to get current secrets state and validate
    useImperativeHandle(
      ref,
      () => ({
        getSecrets: getCurrentSecrets,
        validateSecrets,
      }),
      [getCurrentSecrets, validateSecrets]
    );

    // Toggle visibility for a specific secret
    const toggleSecretVisibility = (index: number) => {
      setVisibleSecrets((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(index)) {
          newSet.delete(index);
        } else {
          newSet.add(index);
        }
        return newSet;
      });
    };

    // Load initial secrets from characterValue and merge with required secrets
    useEffect(() => {
      // Only reset if we're switching to a different agent or this is the first load
      if (characterValue.id !== lastAgentIdRef.current || !lastAgentIdRef.current) {
        const existingSecrets = Object.entries(characterValue?.settings?.secrets || {}).map(
          ([name, value]) => {
            // Filter out process.env values - these should not be stored as actual values
            const stringValue = String(value);
            const cleanValue = stringValue.startsWith('process.env.') ? '' : stringValue;
            
            return {
              name,
              value: cleanValue,
              isNew: false,
              isModified: false,
              isDeleted: false,
              isRequired: false,
              description: undefined,
              example: undefined,
              plugin: undefined,
            };
          }
        );

        // Create a map for quick lookup
        const existingSecretsMap = new Map(existingSecrets.map((s) => [s.name, s]));

        // Add required secrets that don't exist yet
        const allSecrets: EnvVariable[] = [...existingSecrets];

        requiredSecrets.forEach((reqSecret) => {
          if (!existingSecretsMap.has(reqSecret.name)) {
            allSecrets.push({
              name: reqSecret.name,
              value: '',
              isNew: true,
              isModified: false,
              isDeleted: false,
              isRequired: true,
              description: reqSecret.description,
              example: reqSecret.example,
              plugin: reqSecret.plugin,
            });
          } else {
            // Update existing secret with required metadata
            const existingIndex = allSecrets.findIndex((s) => s.name === reqSecret.name);
            if (existingIndex !== -1) {
              allSecrets[existingIndex] = {
                ...allSecrets[existingIndex],
                isRequired: true,
                description: reqSecret.description,
                example: reqSecret.example,
                plugin: reqSecret.plugin,
              };
            }
          }
        });

        // Sort: required secrets first, then alphabetically
        allSecrets.sort((a, b) => {
          if (a.isRequired && !b.isRequired) return -1;
          if (!a.isRequired && b.isRequired) return 1;
          return a.name.localeCompare(b.name);
        });

        setEnvs(allSecrets);
        setDeletedKeys([]); // Reset deleted keys when loading new data
        lastAgentIdRef.current = characterValue.id || 'new-agent';

        // Also reset the required secrets tracking
        const requiredSecretsKey = requiredSecrets
          .map((s) => s.name)
          .sort()
          .join(',');
        lastRequiredSecretsKeyRef.current = requiredSecretsKey;
      }
    }, [characterValue.id, characterValue.settings?.secrets, requiredSecrets]); // Be more specific about dependencies

    // Sync secrets when plugins change (not just when agent changes)
    useEffect(() => {
      // Skip if we haven't loaded initial data yet or if loading
      if (!lastAgentIdRef.current || isLoadingSecrets) return;

      // Create a stable key for comparison
      const requiredSecretsKey = requiredSecrets
        .map((s) => s.name)
        .sort()
        .join(',');

      // Only update if the required secrets actually changed
      if (requiredSecretsKey === lastRequiredSecretsKeyRef.current) return;
      lastRequiredSecretsKeyRef.current = requiredSecretsKey;

      // Get current required secret names
      const currentRequiredNames = new Set(requiredSecrets.map((s) => s.name));

      // Update existing envs
      setEnvs((prevEnvs) => {
        const updatedEnvs = prevEnvs
          .map((env) => {
            // Check if this secret is still required
            const isStillRequired = currentRequiredNames.has(env.name);
            const reqSecret = requiredSecrets.find((s) => s.name === env.name);

            // If it was required but no longer is, remove it entirely (regardless of value)
            if (env.isRequired && !isStillRequired) {
              // Mark this secret for deletion in parent component immediately
              setTimeout(() => {
                setDeletedKeys((prev) => (prev.includes(env.name) ? prev : [...prev, env.name]));
              }, 0);
              return null; // Mark for removal from envs array
            }

            // Update metadata if still required
            if (isStillRequired && reqSecret) {
              return {
                ...env,
                isRequired: true,
                description: reqSecret.description,
                example: reqSecret.example,
                plugin: reqSecret.plugin,
              };
            }

            // Keep non-required envs that have values
            return {
              ...env,
              isRequired: isStillRequired,
              description: isStillRequired ? env.description : undefined,
              example: isStillRequired ? env.example : undefined,
              plugin: isStillRequired ? env.plugin : undefined,
            };
          })
          .filter(Boolean) as EnvVariable[]; // Remove nulls

        // Add new required secrets that don't exist
        const existingNames = new Set(updatedEnvs.map((e) => e.name));
        requiredSecrets.forEach((reqSecret) => {
          if (!existingNames.has(reqSecret.name)) {
            updatedEnvs.push({
              name: reqSecret.name,
              value: '',
              isNew: true,
              isModified: false,
              isDeleted: false,
              isRequired: true,
              description: reqSecret.description,
              example: reqSecret.example,
              plugin: reqSecret.plugin,
            });
          }
        });

        // Sort: required secrets first, then alphabetically
        updatedEnvs.sort((a, b) => {
          if (a.isRequired && !b.isRequired) return -1;
          if (!a.isRequired && b.isRequired) return 1;
          return a.name.localeCompare(b.name);
        });

        return updatedEnvs;
      });
    }, [
      requiredSecrets,
      isLoadingSecrets,
      requiredSecrets.length,
      requiredSecrets.map((s) => s.name).join(','),
    ]);

    // Force cleanup of non-required secrets (alternative approach)
    useEffect(() => {
      const currentRequiredNames = new Set(requiredSecrets.map((s) => s.name));

      setEnvs((prevEnvs) => {
        const cleanedEnvs = prevEnvs.filter((env) => {
          const shouldKeep =
            currentRequiredNames.has(env.name) ||
            (!env.isRequired && env.value && env.value.trim() !== '');

          if (!shouldKeep && env.isRequired) {
            // Mark for deletion
            setDeletedKeys((prev) => (prev.includes(env.name) ? prev : [...prev, env.name]));
          }

          return shouldKeep;
        });

        return cleanedEnvs;
      });
    }, [requiredSecrets]);

    // Notify parent of changes
    useEffect(() => {
      if (!onChange) return;

      // Create a debounced version to avoid rapid fire updates
      const timeoutId = setTimeout(() => {
        const secrets = getCurrentSecrets();

        // Also check for secrets that should be removed
        // Get all env names that are currently in the list
        const currentEnvNames = new Set(envs.map((e) => e.name));

        // Check if there are any secrets in the character settings that are no longer in our envs
        // This happens when a plugin is removed and its required secrets are cleaned up
        const characterSecrets = characterValue?.settings?.secrets || {};
        Object.keys(characterSecrets).forEach((secretName) => {
          if (!currentEnvNames.has(secretName) && !deletedKeys.includes(secretName)) {
            // Mark this secret for deletion
            secrets[secretName] = null;
          }
        });

        // Only call onChange if secrets actually changed
        // Sort keys to ensure consistent comparison
        const sortedSecrets = Object.keys(secrets)
          .sort()
          .reduce(
            (acc, key) => {
              acc[key] = secrets[key];
              return acc;
            },
            {} as Record<string, string | null>
          );
        const secretsString = JSON.stringify(sortedSecrets);

        if (secretsString !== lastSecretsRef.current) {
          lastSecretsRef.current = secretsString;
          onChange(secrets);
        }
      }, 100); // 100ms debounce

      return () => clearTimeout(timeoutId);
    }, [envs, deletedKeys, onChange, characterValue?.settings?.secrets]); // Remove getCurrentSecrets from dependencies

    const handleFileUpload = useCallback(
      (file: File) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const text = event.target?.result as string;
          const lines = text.split('\n');

          const newEnvs: Record<string, string> = {};
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;

            const [key, ...rest] = trimmedLine.split('=');
            const val = rest
              .join('=')
              .trim()
              .replace(/^['"]|['"]$/g, '');
            if (key) newEnvs[key.trim()] = val;
          }

          setEnvs((prev) => {
            const merged = new Map(
              prev.map(({ name, value, ...rest }) => [name, { value, ...rest }])
            );
            for (const [key, val] of Object.entries(newEnvs)) {
              // Filter out process.env values
              const cleanValue = val.startsWith('process.env.') ? '' : val;
              const existing = merged.get(key);
              if (existing) {
                merged.set(key, { ...existing, value: cleanValue, isModified: true });
              } else {
                const reqSecret = requiredSecrets.find((s) => s.name === key);
                merged.set(key, {
                  value: cleanValue,
                  isNew: true,
                  isModified: false,
                  isRequired: reqSecret?.required || false,
                  description: reqSecret?.description,
                  example: reqSecret?.example,
                  plugin: reqSecret?.plugin,
                });
              }
            }
            const result = Array.from(merged.entries()).map(([name, data]) => ({
              name,
              ...data,
            }));

            // Sort: required secrets first, then alphabetically
            result.sort((a, b) => {
              if (a.isRequired && !b.isRequired) return -1;
              if (!a.isRequired && b.isRequired) return 1;
              return a.name.localeCompare(b.name);
            });

            return result;
          });

          if (deletedKeys.length > 0) {
            setDeletedKeys((prev) => prev.filter((key) => !Object.keys(newEnvs).includes(key)));
          }
        };
        reader.readAsText(file);
      },
      [requiredSecrets, deletedKeys]
    );

    useEffect(() => {
      const drop = dropRef.current;
      if (!drop) {
        return;
      }

      const preventDefaults = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      };

      const highlight = (e: Event) => {
        setIsDragging(true);
      };

      const unhighlight = (e: Event) => {
        setIsDragging(false);
      };

      const handleDrop = (e: DragEvent) => {
        preventDefaults(e);
        unhighlight(e);

        const file = e.dataTransfer?.files?.[0];
        if (file && file.name.endsWith('.env')) {
          handleFileUpload(file);
        }
      };

      ['dragenter', 'dragover'].forEach((event) => drop.addEventListener(event, highlight));
      ['dragleave', 'drop'].forEach((event) => drop.addEventListener(event, unhighlight));
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((event) =>
        drop.addEventListener(event, preventDefaults)
      );
      drop.addEventListener('drop', handleDrop);

      return () => {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((event) =>
          drop.removeEventListener(event, preventDefaults)
        );
        ['dragenter', 'dragover'].forEach((event) => drop.removeEventListener(event, highlight));
        ['dragleave', 'drop'].forEach((event) => drop.removeEventListener(event, unhighlight));
        drop.removeEventListener('drop', handleDrop);
      };
    }, [handleFileUpload]);

    const addEnv = () => {
      if (name && value) {
        const exists = envs.some((env) => env.name === name);
        
        // Filter out process.env values
        const cleanValue = value.startsWith('process.env.') ? '' : value;

        if (!exists) {
          if (deletedKeys.includes(name)) {
            setDeletedKeys(deletedKeys.filter((key) => key !== name));
          }

          const reqSecret = requiredSecrets.find((s) => s.name === name);
          const newEnv: EnvVariable = {
            name,
            value: cleanValue,
            isNew: true,
            isRequired: reqSecret?.required || false,
            description: reqSecret?.description,
            example: reqSecret?.example,
            plugin: reqSecret?.plugin,
          };

          const updatedEnvs = [...envs, newEnv];
          // Sort: required secrets first, then alphabetically
          updatedEnvs.sort((a, b) => {
            if (a.isRequired && !b.isRequired) return -1;
            if (!a.isRequired && b.isRequired) return 1;
            return a.name.localeCompare(b.name);
          });

          setEnvs(updatedEnvs);
          setName('');
          setValue('');
        } else {
          setEnvs(
            envs.map((env) => (env.name === name ? { ...env, value: cleanValue, isModified: true } : env))
          );
          setName('');
          setValue('');
        }
      }
    };

    const startEditing = (index: number) => {
      // Close any other editing
      if (editingIndex !== null && editingIndex !== index) {
        setEditingIndex(null);
      }

      setEditingIndex(index);
      setEditedValue(envs[index].value);
      // Show the secret when editing
      setVisibleSecrets((prev) => new Set(prev).add(index));
    };

    const saveEdit = (index: number) => {
      const updatedEnvs = [...envs];
      // Filter out process.env values
      const cleanValue = editedValue.startsWith('process.env.') ? '' : editedValue;
      
      if (updatedEnvs[index].value !== cleanValue) {
        updatedEnvs[index].value = cleanValue;
        updatedEnvs[index].isModified = true;
      }
      setEnvs(updatedEnvs);
      setEditingIndex(null);
      setEditedValue('');
      // Hide the secret after saving
      setVisibleSecrets((prev) => {
        const newSet = new Set(prev);
        newSet.delete(index);
        return newSet;
      });
    };

    const cancelEdit = () => {
      const currentIndex = editingIndex;
      setEditingIndex(null);
      setEditedValue('');
      // Hide the secret after canceling
      if (currentIndex !== null) {
        setVisibleSecrets((prev) => {
          const newSet = new Set(prev);
          newSet.delete(currentIndex);
          return newSet;
        });
      }
    };

    const removeEnv = (index: number) => {
      const keyToRemove = envs[index].name;

      setDeletedKeys([...deletedKeys, keyToRemove]);

      setEnvs(envs.filter((_, i) => i !== index));
      setEditingIndex(null);
    };

    // Get missing required secrets
    const missingRequiredSecrets = requiredSecrets.filter((reqSecret) => {
      const env = envs.find((e) => e.name === reqSecret.name);
      return !env || !env.value || env.value.trim() === '';
    });

    return (
      <div className="w-full h-full overflow-y-auto">
        <div className="rounded-lg w-full flex flex-col gap-3">
          <h2 className="text-xl font-bold mb-4 pb-5 ml-1">Environment Settings</h2>

          {/* Show loading state for required secrets */}
          {isLoadingSecrets && (
            <div className="mb-4">
              <Skeleton className="h-4 w-48 mb-2" />
              <Skeleton className="h-4 w-64" />
            </div>
          )}

          {/* Show alert if there are missing required secrets */}
          {!isLoadingSecrets && missingRequiredSecrets.length > 0 && (
            <Alert className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <strong>Missing required secrets:</strong>
                <ul className="mt-2 space-y-1">
                  {missingRequiredSecrets.map((secret) => (
                    <li key={secret.name} className="text-sm">
                      • <code className="font-mono">{secret.name}</code>
                      {secret.plugin && (
                        <span className="text-muted-foreground ml-1">
                          (required by {secret.plugin})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-center justify-center w-full px-10">
            <div
              ref={dropRef}
              className={`flex flex-col gap-2 items-center justify-center text-gray-500 w-full border-2 border-dashed border-muted rounded-lg p-16 mb-16 text-center cursor-pointer transition ${
                isDragging ? 'bg-muted' : ''
              }`}
              onClick={() => document.getElementById('env-upload')?.click()}
            >
              <CloudUpload />
              <p className="text-sm">
                Drag & drop <code>.env</code> file or select file
              </p>
              <input
                id="env-upload"
                type="file"
                accept="*/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && file.name.endsWith('.env')) {
                    handleFileUpload(file);
                  }
                }}
              />
            </div>
          </div>

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
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addEnv();
                  }
                }}
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addEnv();
                    }
                  }}
                />
                <div
                  className="absolute inset-y-0 right-3 flex items-center cursor-pointer text-gray-500"
                  onClick={() => setShowPassword(!showPassword)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      setShowPassword(!showPassword);
                    }
                  }}
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </div>
              </div>
            </div>
            <Button type="button" className="shrink-0" onClick={addEnv}>
              Add
            </Button>
          </div>

          {envs.length > 0 && (
            <>
              <div className="grid grid-cols-[1fr_2fr_auto] gap-4 mt-6 font-medium text-gray-400 border-b pb-2 ml-1">
                <div>Name</div>
                <div>Value</div>
                <div className="text-center">Actions</div>
              </div>

              <div className="mt-2 space-y-2">
                {envs.map((env, index) => (
                  <div
                    key={`${env.name}-${index}`}
                    className={`grid grid-cols-[1fr_2fr_auto] gap-4 items-center border-b py-3 ml-1 ${
                      env.isRequired && (!env.value || env.value.trim() === '')
                        ? 'border-red-500/50'
                        : ''
                    }`}
                  >
                    <div className="truncate">
                      <div className="font-mono text-sm flex items-center gap-2">
                        {env.name}
                        {env.isRequired && <span className="text-red-500 text-xs">*</span>}
                      </div>
                      {env.description && (
                        <div className="text-xs text-muted-foreground mt-1">{env.description}</div>
                      )}
                      {env.plugin && (
                        <div className="text-xs text-muted-foreground">
                          Required by: {env.plugin}
                        </div>
                      )}
                      {env.isRequired === false &&
                        env.plugin &&
                        (!env.value || env.value.trim() === '') && (
                          <div className="text-xs text-yellow-600 mt-1">
                            Plugin removed - this secret will be cleaned up
                          </div>
                        )}
                    </div>
                    <div>
                      {editingIndex === index ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={editedValue}
                            onChange={(e) => setEditedValue(e.target.value)}
                            className="w-full font-mono text-sm"
                            type={visibleSecrets.has(index) ? 'text' : 'password'}
                            placeholder={env.example || 'Enter value...'}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                saveEdit(index);
                              } else if (e.key === 'Escape') {
                                cancelEdit();
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleSecretVisibility(index)}
                            className="px-2"
                          >
                            {visibleSecrets.has(index) ? (
                              <EyeOff className="w-4 h-4 text-gray-500" />
                            ) : (
                              <Eye className="w-4 h-4 text-gray-500" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => saveEdit(index)}
                          >
                            <Check className="w-4 h-4 text-green-500" />
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={cancelEdit}>
                            <X className="w-4 h-4 text-red-500" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 truncate text-gray-500 font-mono text-sm">
                            {visibleSecrets.has(index) ? (
                              env.value || (
                                <span className="text-muted-foreground italic">
                                  {env.example ? `e.g. ${env.example}` : 'Not set'}
                                </span>
                              )
                            ) : env.value ? (
                              env.value.includes(':') && env.value.length > 50 ? (
                                'Encrypted'
                              ) : (
                                '••••••••'
                              )
                            ) : (
                              <span className="text-muted-foreground italic">Not set</span>
                            )}
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleSecretVisibility(index)}
                            className="px-2"
                          >
                            {visibleSecrets.has(index) ? (
                              <EyeOff className="w-4 h-4 text-gray-500" />
                            ) : (
                              <Eye className="w-4 h-4 text-gray-500" />
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-blue-500 hover:text-blue-600 hover:bg-blue-50"
                        onClick={() => {
                          startEditing(index);
                        }}
                        disabled={editingIndex !== null && editingIndex !== index}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        onClick={() => {
                          removeEnv(index);
                        }}
                        disabled={editingIndex !== null}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
);

SecretPanel.displayName = 'SecretPanel';

// Also provide a default export for backward compatibility
export default SecretPanel;
