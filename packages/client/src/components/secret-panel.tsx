import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '@elizaos/core';
import { Check, CloudUpload, Eye, EyeOff, MoreVertical, X } from 'lucide-react';

type EnvVariable = {
  name: string;
  value: string;
  isNew?: boolean;
  isModified?: boolean;
  isDeleted?: boolean;
};

interface SecretPanelProps {
  characterValue: Agent;
  onChange: (updatedAgent: Agent) => void;
}

// Export as named export to match import in other files
export function SecretPanel({ characterValue, onChange }: SecretPanelProps) {
  console.log('[SecretPanel] MOUNTING with characterValue:', characterValue);
  console.log('[SecretPanel] Initial secrets:', characterValue?.settings?.secrets);

  // Initialize secrets from character data
  const initialSecrets = Object.entries(characterValue?.settings?.secrets || {}).map(
    ([name, value]) => ({
      name,
      value: String(value),
      isNew: false,
      isModified: false,
      isDeleted: false,
    })
  );

  console.log('[SecretPanel] Initialized envs with:', initialSecrets);

  const [envs, setEnvs] = useState<EnvVariable[]>(initialSecrets);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedValue, setEditedValue] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  // Keep track of deleted keys to ensure proper removal
  const [deletedKeys, setDeletedKeys] = useState<string[]>([]);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // Handle file drop for .env files
  const handleFile = (file: File) => {
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

      // Add new environment variables with isNew flag
      const updatedEnvs = [...envs];
      for (const [key, val] of Object.entries(newEnvs)) {
        const existingIndex = updatedEnvs.findIndex((env) => env.name === key);
        if (existingIndex !== -1) {
          // If value changed, mark as modified
          if (updatedEnvs[existingIndex].value !== val) {
            updatedEnvs[existingIndex].value = val;
            updatedEnvs[existingIndex].isModified = true;
          }
        } else {
          // Add new env with isNew flag
          updatedEnvs.push({ name: key, value: val, isNew: true });
          
          // If this key was previously deleted, remove it from deletedKeys
          if (deletedKeys.includes(key)) {
            setDeletedKeys(deletedKeys.filter((k) => k !== key));
          }
        }
      }
      
      setEnvs(updatedEnvs);
    };
    reader.readAsText(file);
  };

  // Set up drag and drop listeners for .env files
  useEffect(() => {
    const drop = dropRef.current;
    if (!drop) return;

    const preventDefaults = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const highlight = () => setIsDragging(true);
    const unhighlight = () => setIsDragging(false);

    const handleDrop = (e: DragEvent) => {
      preventDefaults(e);
      unhighlight();

      const file = e.dataTransfer?.files?.[0];
      if (file && file.name.endsWith('.env')) {
        handleFile(file);
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
  }, []);

  // Add a new environment variable
  const addEnv = () => {
    if (name && value) {
      const exists = envs.some((env) => env.name === name);
      if (!exists) {
        console.log(`[SecretPanel] Adding new secret: ${name}`);

        // If this key was previously deleted, remove it from deletedKeys
        if (deletedKeys.includes(name)) {
          setDeletedKeys(deletedKeys.filter((key) => key !== name));
        }

        setEnvs([...envs, { name, value, isNew: true }]);
        setName('');
        setValue('');
      }
    }
  };

  // Start editing an environment variable
  const startEditing = (index: number) => {
    setEditingIndex(index);
    setEditedValue(envs[index].value);
    setOpenIndex(null);
  };

  // Save edited environment variable
  const saveEdit = (index: number) => {
    const updatedEnvs = [...envs];
    // Only mark as modified if the value actually changed
    if (updatedEnvs[index].value !== editedValue) {
      updatedEnvs[index].value = editedValue;
      updatedEnvs[index].isModified = true;
    }
    setEnvs(updatedEnvs);
    setEditingIndex(null);
  };

  // Remove an environment variable
  const removeEnv = (index: number) => {
    const keyToRemove = envs[index].name;

    // Add the key to deletedKeys to track removal
    setDeletedKeys([...deletedKeys, keyToRemove]);

    // Update local state
    setEnvs(envs.filter((_, i) => i !== index));
    setOpenIndex(null);
    setEditingIndex(null);
  };

  // Handle clicks outside of dropdown
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

  // Update character value when envs change
  useEffect(() => {
    // Only update if there are actual changes to prevent unnecessary rerenders
    const hasChanges = envs.some((env) => env.isNew || env.isModified) || deletedKeys.length > 0;

    console.log('[SecretPanel] Checking for changes - hasChanges:', hasChanges);
    console.log('[SecretPanel] Current envs:', envs);
    console.log('[SecretPanel] Deleted keys:', deletedKeys);

    if (hasChanges) {
      console.log(`[SecretPanel] --- PROCESSING CHANGES ---`);
      console.log(
        `[SecretPanel] New/modified secrets: ${envs
          .filter((e) => e.isNew || e.isModified)
          .map((e) => e.name)
          .join(', ')}`
      );
      console.log(`[SecretPanel] Deleted keys: ${deletedKeys.join(', ')}`);

      // Start with the original secrets from characterValue
      const currentSettings = characterValue.settings || {};
      const currentSecrets = { ...(currentSettings.secrets || {}) };

      console.log('[SecretPanel] Starting with current secrets:', currentSecrets);

      // First, mark deleted keys explicitly as null instead of removing them
      // This ensures the server knows to remove them instead of just not updating them
      deletedKeys.forEach((key) => {
        console.log(`[SecretPanel] Marking key for deletion: ${key}`);
        currentSecrets[key] = null;
      });

      // Then update with current envs
      envs.forEach(({ name, value, isNew, isModified }) => {
        console.log(
          `[SecretPanel] Setting secret: ${name}, value: ${value}, isNew: ${isNew}, isModified: ${isModified}`
        );
        currentSecrets[name] = value;
      });

      // Create a new agent with updated secrets
      const updatedAgent: Agent = {
        ...characterValue,
        settings: {
          ...currentSettings,
          secrets: currentSecrets,
        },
      };

      console.log('[SecretPanel] Final updated secrets object:', currentSecrets);
      console.log('[SecretPanel] Calling onChange with updated agent');

      // Call the onChange prop with the updated agent
      onChange(updatedAgent);

      console.log('[SecretPanel] onChange called, now clearing modification flags');

      // Clear modification flags to prevent infinite update loops
      setEnvs((prevEnvs) => {
        const newEnvs = prevEnvs.map((env) => ({
          ...env,
          isNew: false,
          isModified: false,
        }));
        console.log('[SecretPanel] Cleared modification flags, new envs:', newEnvs);
        return newEnvs;
      });

      // Clear deletedKeys after changes are applied
      setDeletedKeys([]);
      console.log('[SecretPanel] Cleared deletedKeys');
    }
    // Remove characterValue from the dependency array to prevent cycles
  }, [envs, onChange, deletedKeys]);

  // Sync envs with characterValue when it changes
  useEffect(() => {
    console.log(
      '[SecretPanel] characterValue.settings?.secrets changed:',
      characterValue.settings?.secrets
    );

    if (characterValue?.settings?.secrets) {
      const currentSecretsEntries = Object.entries(characterValue.settings.secrets);
      // Only update if the secrets have actually changed (different keys/number of entries)
      const currentKeys = currentSecretsEntries
        .map(([key]) => key)
        .sort()
        .join(',');
      const envKeys = envs
        .map((env) => env.name)
        .sort()
        .join(',');

      console.log('[SecretPanel] Current keys from characterValue:', currentKeys);
      console.log('[SecretPanel] Current keys from envs:', envKeys);
      console.log(
        '[SecretPanel] Any new/modified envs:',
        envs.some((env) => env.isNew || env.isModified)
      );
      console.log('[SecretPanel] Any deleted keys:', deletedKeys.length > 0);

      if (
        currentKeys !== envKeys &&
        !envs.some((env) => env.isNew || env.isModified) &&
        deletedKeys.length === 0
      ) {
        console.log('[SecretPanel] Updating envs from changed characterValue');
        const newEnvs = currentSecretsEntries.map(([name, value]) => ({
          name,
          value: String(value),
          isNew: false,
          isModified: false,
          isDeleted: false,
        }));
        console.log('[SecretPanel] Setting new envs:', newEnvs);
        setEnvs(newEnvs);
      }
    }
  }, [characterValue.settings?.secrets, envs, deletedKeys]);

  return (
    <div className="rounded-lg w-full">
      <h2 className="text-xl font-bold mb-4 pb-5 ml-1">Environment Settings</h2>

      {/* Drag & Drop .env file section */}
      <div className="flex items-center justify-center w-full px-10 mb-6">
        <div
          ref={dropRef}
          className={`flex flex-col gap-2 items-center justify-center text-gray-500 w-full border-2 border-dashed border-muted rounded-lg p-12 text-center cursor-pointer transition ${
            isDragging ? 'bg-muted' : ''
          }`}
          onClick={() => document.getElementById('env-upload')?.click()}
        >
          <CloudUpload size={24} />
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
                handleFile(file);
              }
            }}
          />
        </div>
      </div>

      {/* Manual entry form */}
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setShowPassword(!showPassword);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </div>
          </div>
        </div>
        <Button
          className="shrink-0"
          onClick={addEnv}
          disabled={!name || !value || envs.some((env) => env.name === name)}
        >
          Add
        </Button>
      </div>

      {/* Secrets list header */}
      {envs.length > 0 && (
        <div className="grid grid-cols-[1fr_2fr_auto] gap-4 mt-6 font-medium text-gray-400 border-b pb-2 ml-1">
          <div>Name</div>
          <div>Value</div>
          <div>Action</div>
        </div>
      )}

      {/* Secrets list */}
      <div className="mt-2">
        {envs.map((env, index) => (
          <div
            key={index}
            className="grid grid-cols-[1fr_2fr_auto] gap-4 items-center border-b py-2 ml-1 relative"
          >
            <div className="flex items-center">
              {env.name}
              {env.isNew && (
                <span className="ml-2 px-2 py-0.5 bg-green-100 text-green-800 text-xs rounded-full">
                  New
                </span>
              )}
              {env.isModified && !env.isNew && (
                <span className="ml-2 px-2 py-0.5 bg-blue-100 text-blue-800 text-xs rounded-full">
                  Modified
                </span>
              )}
            </div>
            <div>
              {editingIndex === index ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={editedValue}
                    onChange={(e) => setEditedValue(e.target.value)}
                    className="w-full"
                    type={showPassword ? 'text' : 'password'}
                  />
                  <Button variant="ghost" onClick={() => saveEdit(index)} className="p-1">
                    <Check className="w-5 h-5 text-green-500" />
                  </Button>
                  <Button variant="ghost" onClick={() => setEditingIndex(null)} className="p-1">
                    <X className="w-5 h-5 text-red-500" />
                  </Button>
                </div>
              ) : (
                <div className="truncate text-gray-500">
                  {showPassword ? env.value : '••••••••••••••'}
                </div>
              )}
            </div>
            <div className="relative">
              <Button
                variant="ghost"
                className="p-2 text-gray-500"
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
              >
                <MoreVertical className="w-5 h-5" />
              </Button>
              {openIndex === index && (
                <div
                  className="absolute right-0 -top-2 mt-2 w-24 bg-muted border rounded shadow-md z-10"
                  ref={dropdownRef}
                >
                  <button
                    className="w-full px-4 py-2 text-left hover:opacity-50"
                    onClick={() => startEditing(index)}
                    type="button"
                  >
                    Edit
                  </button>
                  <div
                    className="w-full px-4 py-2 text-left text-red-500 hover:opacity-50 cursor-pointer"
                    onClick={() => removeEnv(index)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        removeEnv(index);
                      }
                    }}
                  >
                    Remove
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Also provide a default export for backward compatibility
export default SecretPanel;
