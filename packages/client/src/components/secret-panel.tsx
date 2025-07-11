import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Agent } from '@elizaos/core';
import { decryptObjectValues, getSalt } from '@elizaos/core';
import {
  Check,
  CloudUpload,
  Eye,
  EyeOff,
  X,
  AlertCircle,
  FileText,
  Copy,
  Trash2,
  Edit3,
  Globe,
} from 'lucide-react';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { createElizaClient } from '@/lib/api-client-config';

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
    const [globalEnvs, setGlobalEnvs] = useState<Record<string, string>>({});
    const [isLoadingGlobalEnvs, setIsLoadingGlobalEnvs] = useState(true);

    // Raw editor modal state
    const [rawEditorOpen, setRawEditorOpen] = useState(false);
    const [rawEditorContent, setRawEditorContent] = useState('');

    const lastAgentIdRef = useRef<string | null>(null);
    const lastSecretsRef = useRef<string>('');
    const dropRef = useRef<HTMLDivElement>(null);
    const lastRequiredSecretsKeyRef = useRef<string>('');

    // Get required secrets based on enabled plugins
    const enabledPlugins = useMemo(() => characterValue?.plugins || [], [characterValue?.plugins]);
    const { requiredSecrets, isLoading: isLoadingSecrets } = useRequiredSecrets(enabledPlugins);

    // Fetch global environment variables
    useEffect(() => {
      const fetchGlobalEnvs = async () => {
        try {
          setIsLoadingGlobalEnvs(true);
          const elizaClient = createElizaClient();
          const data = await elizaClient.system.getEnvironment();
          setGlobalEnvs(data || {});
        } catch (error) {
          console.error('Failed to fetch global environment variables:', error);
          setGlobalEnvs({});
        } finally {
          setIsLoadingGlobalEnvs(false);
        }
      };

      fetchGlobalEnvs();
    }, []);

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

      // If we're still loading required secrets, check against current envs marked as required
      const secretsToCheck = isLoadingSecrets
        ? envs.filter((env) => env.isRequired)
        : requiredSecrets;

      const missingSecrets = secretsToCheck
        .filter((secret) => {
          const secretName = typeof secret === 'object' && 'name' in secret ? secret.name : secret;
          const value = currentSecrets[secretName];

          // Check if the value exists in current secrets
          if (value && value.trim() !== '') {
            return false;
          }

          // Check if the value exists in global environment
          if (globalEnvs[secretName] && globalEnvs[secretName].trim() !== '') {
            return false;
          }

          return true;
        })
        .map((secret) => (typeof secret === 'object' && 'name' in secret ? secret.name : secret));

      return {
        isValid: missingSecrets.length === 0,
        missingSecrets,
      };
    }, [getCurrentSecrets, requiredSecrets, isLoadingSecrets, envs, globalEnvs]);

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

    // Convert envs to raw editor format - include ALL variables, even empty required ones
    const envsToRawText = useCallback(() => {
      const lines: string[] = [];

      // Add a header comment
      lines.push('# Environment Variables');
      lines.push('');

      // Group by required vs optional
      const requiredEnvs = envs.filter((env) => env.isRequired);
      const optionalEnvs = envs.filter(
        (env) => !env.isRequired && env.value && env.value.trim() !== ''
      );

      // Add required secrets section
      if (requiredEnvs.length > 0) {
        lines.push('# Required Secrets');
        requiredEnvs.forEach((env) => {
          if (env.plugin) {
            lines.push(`# Required by ${env.plugin}`);
          }
          if (env.description) {
            lines.push(`# ${env.description}`);
          }
          lines.push(`${env.name}=${env.value || ''}`);
          lines.push('');
        });
      }

      // Add optional secrets section
      if (optionalEnvs.length > 0) {
        lines.push('# Optional Variables');
        optionalEnvs.forEach((env) => {
          lines.push(`${env.name}=${env.value}`);
        });
      }

      return lines.join('\n');
    }, [envs]);

    // Parse raw editor content back to envs
    const parseRawText = useCallback((text: string) => {
      const lines = text.split('\n');
      const parsedEnvs: Record<string, string> = {};

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) continue;

        const [key, ...rest] = trimmedLine.split('=');
        const val = rest
          .join('=')
          .trim()
          .replace(/^['"]|['"]$/g, '');
        if (key && key.trim()) {
          parsedEnvs[key.trim()] = val;
        }
      }

      return parsedEnvs;
    }, []);

    // Handle raw editor save - this should trigger the parent onChange
    const handleRawEditorSave = () => {
      const parsedEnvs = parseRawText(rawEditorContent);

      // Create a new envs array with updates from raw editor
      const newEnvs = envs
        .map((env) => {
          if (parsedEnvs.hasOwnProperty(env.name)) {
            const cleanValue = parsedEnvs[env.name].startsWith('process.env.')
              ? ''
              : parsedEnvs[env.name];
            return { ...env, value: cleanValue, isModified: env.value !== cleanValue };
          }
          // Keep required secrets even if not in parsed content
          if (env.isRequired) {
            return { ...env, value: '', isModified: env.value !== '' };
          }
          // Remove non-required secrets that aren't in parsed content
          return null;
        })
        .filter(Boolean) as EnvVariable[];

      // Add new secrets from parsed content
      Object.entries(parsedEnvs).forEach(([key, value]) => {
        const exists = newEnvs.some((env) => env.name === key);
        if (!exists) {
          const cleanValue = value.startsWith('process.env.') ? '' : value;
          const reqSecret = requiredSecrets.find((s) => s.name === key);
          newEnvs.push({
            name: key,
            value: cleanValue,
            isNew: true,
            isModified: false,
            isDeleted: false,
            isRequired: reqSecret?.required || false,
            description: reqSecret?.description,
            example: reqSecret?.example,
            plugin: reqSecret?.plugin,
          });
        }
      });

      // Sort: required secrets first, then alphabetically
      newEnvs.sort((a, b) => {
        if (a.isRequired && !b.isRequired) return -1;
        if (!a.isRequired && b.isRequired) return 1;
        return a.name.localeCompare(b.name);
      });

      setEnvs(newEnvs);
      setRawEditorOpen(false);

      // The useEffect watching envs will trigger onChange to parent
    };

    // Open raw editor modal
    const openRawEditor = () => {
      setRawEditorContent(envsToRawText());
      setRawEditorOpen(true);
    };

    // Copy env content to clipboard
    const copyEnvContent = () => {
      navigator.clipboard.writeText(rawEditorContent);
    };

    // Load initial secrets from characterValue and merge with required secrets
    useEffect(() => {
      // Skip if still loading secrets or global envs
      if (isLoadingSecrets || isLoadingGlobalEnvs) return;

      // Only reset if we're switching to a different agent or this is the first load
      // or if envs is empty (meaning we haven't initialized yet)
      if (
        characterValue.id !== lastAgentIdRef.current ||
        !lastAgentIdRef.current ||
        envs.length === 0
      ) {
        // Decrypt secrets from the server using the core decryption function
        const salt = getSalt();
        const decryptedSecretsRaw = characterValue?.settings?.secrets || {};
        // Ensure we're working with a plain object
        const decryptedSecrets =
          typeof decryptedSecretsRaw === 'object' &&
          !Array.isArray(decryptedSecretsRaw) &&
          decryptedSecretsRaw !== null
            ? decryptObjectValues(decryptedSecretsRaw, salt)
            : {};

        const existingSecrets = Object.entries(decryptedSecrets).map(([name, value]) => {
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
        });

        // Create a map for quick lookup
        const existingSecretsMap = new Map(existingSecrets.map((s) => [s.name, s]));

        // Add required secrets that don't exist yet
        const allSecrets: EnvVariable[] = [...existingSecrets];

        requiredSecrets.forEach((reqSecret) => {
          if (!existingSecretsMap.has(reqSecret.name)) {
            // Check if this secret exists in global environment
            // Don't populate the value - let the UI show it's using global
            allSecrets.push({
              name: reqSecret.name,
              value: '', // Keep empty to show it's using global
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
              // Keep existing value as is - don't auto-populate from global
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
    }, [
      characterValue.id,
      characterValue.settings?.secrets,
      requiredSecrets,
      isLoadingSecrets,
      globalEnvs,
      isLoadingGlobalEnvs,
    ]);

    // Sync secrets when plugins change (not just when agent changes)
    useEffect(() => {
      // Skip only if still loading secrets
      if (isLoadingSecrets) return;

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
            // Don't auto-populate from global - let UI show it's using global
            updatedEnvs.push({
              name: reqSecret.name,
              value: '', // Keep empty to show it's using global
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
    }, [requiredSecrets, isLoadingSecrets, globalEnvs]);

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
    }, [envs, deletedKeys, onChange, characterValue?.settings?.secrets, getCurrentSecrets]);

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

      const highlight = () => {
        setIsDragging(true);
      };

      const unhighlight = () => {
        setIsDragging(false);
      };

      const handleDrop = (e: DragEvent) => {
        preventDefaults(e);
        unhighlight();

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
            envs.map((env) =>
              env.name === name ? { ...env, value: cleanValue, isModified: true } : env
            )
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

    // Get missing required secrets (considering global envs)
    const missingRequiredSecrets = requiredSecrets.filter((reqSecret) => {
      const env = envs.find((e) => e.name === reqSecret.name);
      const hasLocalValue = env && env.value && env.value.trim() !== '';
      const hasGlobalValue = globalEnvs[reqSecret.name] && globalEnvs[reqSecret.name].trim() !== '';
      return !hasLocalValue && !hasGlobalValue;
    });

    // Check if a secret exists in global environment
    const isInGlobalEnv = useCallback(
      (secretName: string) => {
        return globalEnvs[secretName] && globalEnvs[secretName].trim() !== '';
      },
      [globalEnvs]
    );

    // Custom scrollbar styles for input containers - visible scrollbar like Railway
    const scrollbarContainerClass = `
      overflow-x-auto 
      overflow-y-hidden
      [&::-webkit-scrollbar]:h-2
      [&::-webkit-scrollbar]:block
      [&::-webkit-scrollbar]:visible
      [&::-webkit-scrollbar-track]:bg-gray-100
      [&::-webkit-scrollbar-track]:dark:bg-gray-800
      [&::-webkit-scrollbar-track]:rounded-full
      [&::-webkit-scrollbar-thumb]:bg-gray-400
      [&::-webkit-scrollbar-thumb]:dark:bg-gray-600
      [&::-webkit-scrollbar-thumb]:rounded-full
      [&::-webkit-scrollbar-thumb]:hover:bg-gray-500
      [&::-webkit-scrollbar-thumb]:dark:hover:bg-gray-500
      [scrollbar-width:thin]
      [scrollbar-color:theme(colors.gray.400)_theme(colors.gray.100)]
      dark:[scrollbar-color:theme(colors.gray.600)_theme(colors.gray.800)]
    `
      .replace(/\s+/g, ' ')
      .trim();

    return (
      <div className="w-full h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Variables</h2>
            <Badge variant="secondary" className="text-xs">
              {envs.filter((env) => env.value && env.value.trim() !== '').length} Service Variables
            </Badge>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openRawEditor}
            className="flex items-center gap-2"
          >
            <FileText className="w-4 h-4" />
            Raw Editor
          </Button>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            {/* Show loading state for required secrets */}
            {(isLoadingSecrets || isLoadingGlobalEnvs) && (
              <div className="space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-64" />
              </div>
            )}

            {/* Show alert if there are missing required secrets */}
            {!isLoadingSecrets && !isLoadingGlobalEnvs && missingRequiredSecrets.length > 0 && (
              <Alert>
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

            {/* Show info about global environment variables */}
            {!isLoadingSecrets &&
              !isLoadingGlobalEnvs &&
              requiredSecrets.some(
                (secret) =>
                  isInGlobalEnv(secret.name) && !envs.find((e) => e.name === secret.name)?.value
              ) && (
                <Alert className="border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20">
                  <Globe className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  <AlertDescription className="text-blue-800 dark:text-blue-200">
                    <strong>Global environment variables detected:</strong>
                    <p className="text-sm mt-1">
                      Some required secrets are automatically using values from your global
                      environment settings. To override any of these for this specific agent, simply
                      enter a new value in the field.
                    </p>
                  </AlertDescription>
                </Alert>
              )}

            {/* Add new variable form */}
            <div className="space-y-2">
              {/* Desktop layout */}
              <div className="hidden md:grid md:grid-cols-[minmax(200px,1fr)_2fr_auto] gap-2 items-end">
                <div className="space-y-1">
                  <label
                    htmlFor="new-secret-name"
                    className="text-xs font-medium text-muted-foreground uppercase"
                  >
                    Name
                  </label>
                  <Input
                    id="new-secret-name"
                    placeholder="VARIABLE_NAME"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="font-mono text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addEnv();
                      }
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="new-secret-value"
                    className="text-xs font-medium text-muted-foreground uppercase"
                  >
                    Value
                  </label>
                  <div className="relative">
                    <div className={`rounded border ${scrollbarContainerClass}`}>
                      <Input
                        id="new-secret-value"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Enter value..."
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        className="font-mono text-sm pr-10 border-0 focus-visible:ring-0 w-auto min-w-full rounded"
                        style={{ minWidth: '100%' }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addEnv();
                          }
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
                <Button type="button" onClick={addEnv} size="sm">
                  Add
                </Button>
              </div>

              {/* Mobile layout */}
              <div className="md:hidden space-y-3">
                <div className="space-y-1">
                  <label
                    htmlFor="new-secret-name-mobile"
                    className="text-xs font-medium text-muted-foreground uppercase"
                  >
                    Name
                  </label>
                  <Input
                    id="new-secret-name-mobile"
                    placeholder="VARIABLE_NAME"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="font-mono text-sm w-full"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        // Focus on value input on mobile
                        document.getElementById('new-secret-value-mobile')?.focus();
                      }
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="new-secret-value-mobile"
                    className="text-xs font-medium text-muted-foreground uppercase"
                  >
                    Value
                  </label>
                  <div className="relative">
                    <div className={`rounded border ${scrollbarContainerClass}`}>
                      <Input
                        id="new-secret-value-mobile"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Enter value..."
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        className="font-mono text-sm pr-10 border-0 focus-visible:ring-0 w-auto min-w-full rounded"
                        style={{ minWidth: '100%' }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addEnv();
                          }
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
                <Button type="button" onClick={addEnv} size="sm" className="w-full">
                  Add Variable
                </Button>
              </div>
            </div>

            {/* Variables Table */}
            {envs.length > 0 && (
              <TooltipProvider>
                {/* Desktop Table Layout */}
                <div className="hidden md:block border rounded-lg overflow-hidden relative">
                  <div className="bg-muted/50 px-4 py-2 border-b">
                    <div className="grid grid-cols-[minmax(200px,1fr)_2fr_auto] gap-4 text-xs font-medium text-muted-foreground uppercase">
                      <div>Name</div>
                      <div>Value</div>
                      <div className="text-center">Actions</div>
                    </div>
                  </div>

                  {/* Scrollable content area for variables */}
                  <div className="max-h-[400px] overflow-y-auto">
                    {envs.map((env, index) => (
                      <div
                        key={`${env.name}-${index}`}
                        className={`grid grid-cols-[minmax(200px,1fr)_2fr_auto] gap-4 items-center px-4 py-3 border-b last:border-b-0 hover:bg-muted/10 transition-colors ${
                          env.isRequired &&
                          (!env.value || env.value.trim() === '') &&
                          !isInGlobalEnv(env.name)
                            ? 'bg-red-500/5'
                            : ''
                        }`}
                      >
                        {/* Name Column */}
                        <div className="pr-2">
                          <div className="flex items-start gap-2 flex-wrap">
                            <code className="font-mono text-sm font-medium break-words cursor-default">
                              {env.name}
                            </code>
                            {env.isRequired && (
                              <Badge variant="outline" className="text-xs shrink-0">
                                Required
                              </Badge>
                            )}
                            {isInGlobalEnv(env.name) && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge
                                    variant="secondary"
                                    className="text-xs shrink-0 flex items-center gap-1"
                                  >
                                    <Globe className="w-3 h-3" />
                                    Global
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>
                                    {env.value
                                      ? 'Overriding global value'
                                      : 'Value pulled from global environment. Add new value to override.'}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                          {env.description && (
                            <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {env.description}
                            </div>
                          )}
                          {env.plugin && (
                            <div className="text-xs text-muted-foreground truncate">
                              Required by: {env.plugin}
                            </div>
                          )}
                        </div>

                        {/* Value Column */}
                        <div className="min-w-0">
                          {editingIndex === index ? (
                            <div className="flex items-center gap-2">
                              <div className="relative flex-1">
                                <div className={`rounded border ${scrollbarContainerClass}`}>
                                  <Input
                                    value={editedValue}
                                    onChange={(e) => setEditedValue(e.target.value)}
                                    className="font-mono text-sm border-0 focus-visible:ring-0 w-auto min-w-full rounded"
                                    style={{ minWidth: '100%' }}
                                    type={visibleSecrets.has(index) ? 'text' : 'password'}
                                    placeholder={
                                      isInGlobalEnv(env.name) && !env.value
                                        ? `Using global (enter to override)`
                                        : env.example || 'Enter value...'
                                    }
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
                                </div>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleSecretVisibility(index)}
                                  className="h-8 w-8 p-0"
                                >
                                  {visibleSecrets.has(index) ? (
                                    <EyeOff className="w-4 h-4" />
                                  ) : (
                                    <Eye className="w-4 h-4" />
                                  )}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => saveEdit(index)}
                                  className="h-8 w-8 p-0 text-green-600 hover:text-green-700"
                                >
                                  <Check className="w-4 h-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={cancelEdit}
                                  className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                                >
                                  <X className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 group">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    className={`flex-1 border rounded px-3 py-1 ${scrollbarContainerClass}`}
                                  >
                                    {visibleSecrets.has(index) ? (
                                      <code className="font-mono text-sm whitespace-nowrap block">
                                        {env.value || (
                                          <span className="text-muted-foreground italic">
                                            {isInGlobalEnv(env.name)
                                              ? 'Using global value'
                                              : env.example
                                                ? `e.g. ${env.example}`
                                                : 'Not set'}
                                          </span>
                                        )}
                                      </code>
                                    ) : env.value ? (
                                      <code className="font-mono text-sm text-muted-foreground block">
                                        ••••••••
                                      </code>
                                    ) : (
                                      <span className="text-muted-foreground italic text-sm block">
                                        {isInGlobalEnv(env.name) ? 'Using global value' : 'Not set'}
                                      </span>
                                    )}
                                  </div>
                                </TooltipTrigger>
                                {isInGlobalEnv(env.name) && (
                                  <TooltipContent className="max-w-xs">
                                    <div className="space-y-1">
                                      <p className="font-semibold">Global Environment Variable</p>
                                      <p className="text-sm">
                                        {env.value
                                          ? "You've entered a custom value for this agent. This overrides the global environment setting. Clear the field to use the global value."
                                          : 'This secret is currently using the value from your global environment settings. The actual value is hidden for security. Enter a value here if you want to override it for this agent only.'}
                                      </p>
                                    </div>
                                  </TooltipContent>
                                )}
                              </Tooltip>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleSecretVisibility(index)}
                                className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                {visibleSecrets.has(index) ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </Button>
                            </div>
                          )}
                        </div>

                        {/* Actions Column */}
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => startEditing(index)}
                            disabled={editingIndex !== null && editingIndex !== index}
                            className="h-8 w-8 p-0"
                          >
                            <Edit3 className="w-4 h-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeEnv(index)}
                            disabled={editingIndex !== null}
                            className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Mobile Card Layout */}
                <div className="md:hidden space-y-3">
                  {envs.map((env, index) => (
                    <div
                      key={`${env.name}-${index}-mobile`}
                      className={`border rounded-lg p-4 space-y-3 ${
                        env.isRequired && (!env.value || env.value.trim() === '')
                          ? 'border-red-500/50 bg-red-500/5'
                          : ''
                      }`}
                    >
                      {/* Header with name and required badge */}
                      <div className="space-y-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <code className="font-mono text-sm font-medium break-all">
                                {env.name}
                              </code>
                              {env.isRequired && (
                                <Badge variant="outline" className="text-xs">
                                  Required
                                </Badge>
                              )}
                              {isInGlobalEnv(env.name) && (
                                <Badge
                                  variant="secondary"
                                  className="text-xs flex items-center gap-1"
                                >
                                  <Globe className="w-3 h-3" />
                                  Global
                                </Badge>
                              )}
                            </div>
                            {env.description && (
                              <div className="text-xs text-muted-foreground mt-1">
                                {env.description}
                              </div>
                            )}
                            {env.plugin && (
                              <div className="text-xs text-muted-foreground">
                                Required by: {env.plugin}
                              </div>
                            )}
                          </div>
                          {/* Actions on mobile */}
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => startEditing(index)}
                              disabled={editingIndex !== null && editingIndex !== index}
                              className="h-8 w-8 p-0"
                            >
                              <Edit3 className="w-4 h-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeEnv(index)}
                              disabled={editingIndex !== null}
                              className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </div>

                      {/* Value section */}
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-muted-foreground uppercase">
                          Value
                        </div>
                        {editingIndex === index ? (
                          <div className="space-y-2">
                            <div className="relative">
                              <div className={`rounded border ${scrollbarContainerClass}`}>
                                <Input
                                  value={editedValue}
                                  onChange={(e) => setEditedValue(e.target.value)}
                                  className="font-mono text-sm pr-10 border-0 focus-visible:ring-0 w-auto min-w-full rounded"
                                  style={{ minWidth: '100%' }}
                                  type={visibleSecrets.has(index) ? 'text' : 'password'}
                                  placeholder={
                                    isInGlobalEnv(env.name) && !env.value
                                      ? `Using global (enter to override)`
                                      : env.example || 'Enter value...'
                                  }
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
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleSecretVisibility(index)}
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                              >
                                {visibleSecrets.has(index) ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </Button>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => saveEdit(index)}
                                className="flex-1"
                              >
                                <Check className="w-4 h-4 mr-2" />
                                Save
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={cancelEdit}
                                className="flex-1"
                              >
                                <X className="w-4 h-4 mr-2" />
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div
                                  className={`flex-1 border rounded px-3 py-1 ${scrollbarContainerClass}`}
                                >
                                  {visibleSecrets.has(index) ? (
                                    <code className="font-mono text-sm whitespace-nowrap block">
                                      {env.value || (
                                        <span className="text-muted-foreground italic">
                                          {isInGlobalEnv(env.name)
                                            ? 'Using global value'
                                            : env.example
                                              ? `e.g. ${env.example}`
                                              : 'Not set'}
                                        </span>
                                      )}
                                    </code>
                                  ) : env.value ? (
                                    <code className="font-mono text-sm text-muted-foreground block">
                                      ••••••••
                                    </code>
                                  ) : (
                                    <span className="text-muted-foreground italic text-sm block">
                                      {isInGlobalEnv(env.name) ? 'Using global value' : 'Not set'}
                                    </span>
                                  )}
                                </div>
                              </TooltipTrigger>
                              {isInGlobalEnv(env.name) && (
                                <TooltipContent className="max-w-xs">
                                  <div className="space-y-1">
                                    <p className="font-semibold">Global Environment Variable</p>
                                    <p className="text-sm">
                                      {env.value
                                        ? "You've entered a custom value for this agent. This overrides the global environment setting. Clear the field to use the global value."
                                        : 'This secret is currently using the value from your global environment settings. The actual value is hidden for security. Enter a value here if you want to override it for this agent only.'}
                                    </p>
                                  </div>
                                </TooltipContent>
                              )}
                            </Tooltip>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleSecretVisibility(index)}
                              className="h-8 w-8 p-0"
                            >
                              {visibleSecrets.has(index) ? (
                                <EyeOff className="w-4 h-4" />
                              ) : (
                                <Eye className="w-4 h-4" />
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </TooltipProvider>
            )}

            {/* File Upload Area */}
            <div
              ref={dropRef}
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                isDragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
              onClick={() => document.getElementById('env-upload')?.click()}
            >
              <CloudUpload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
              <div className="text-sm text-muted-foreground">
                Drag & drop <code className="bg-muted px-1 rounded">.env</code> file or click to
                select
              </div>
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
        </ScrollArea>

        {/* Raw Editor Modal */}
        <Dialog open={rawEditorOpen} onOpenChange={setRawEditorOpen}>
          <DialogContent className="max-w-3xl h-[600px] flex flex-col">
            <DialogHeader>
              <DialogTitle>Raw Editor</DialogTitle>
              <DialogDescription>
                Add, edit, or delete your project variables in .env format
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 border rounded-lg overflow-hidden">
              <Textarea
                value={rawEditorContent}
                onChange={(e) => setRawEditorContent(e.target.value)}
                placeholder="# Environment Variables&#10;&#10;# Required Secrets&#10;API_KEY=your_api_key_here&#10;&#10;# Optional Variables&#10;DEBUG=true&#10;&#10;# Comments are supported"
                className="w-full h-full resize-none border-0 font-mono text-sm focus-visible:ring-0"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={copyEnvContent}>
                <Copy className="w-4 h-4 mr-2" />
                Copy ENV
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRawEditorOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleRawEditorSave}>
                Update Variables
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }
);

SecretPanel.displayName = 'SecretPanel';

// Also provide a default export for backward compatibility
export default SecretPanel;
