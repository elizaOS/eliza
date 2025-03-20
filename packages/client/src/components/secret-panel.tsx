import { useAgentUpdate } from '@/hooks/use-agent-update';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '@elizaos/core';
import { CloudUpload, Eye, EyeOff } from 'lucide-react';

type EnvVariable = {
  name: string;
  value: string;
};

interface SecretPanelProps {
  characterValue: Agent;
  onChange: (updatedAgent: Agent) => void;
}

export function SecretPanel({ characterValue, onChange }: SecretPanelProps) {
  console.log('[SecretPanel] Initializing with characterValue:', characterValue);
  const [editIndex, setEditIndex] = useState(-1);
  const [keyInput, setKeyInput] = useState('');
  const [valueInput, setValueInput] = useState('');
  const [envs, setEnvs] = useState<EnvVariable[]>([]);
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const { updateSecret, removeSecret } = useAgentUpdate(characterValue);
  const initialSecrets = useRef(characterValue?.settings?.secrets || {});
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  console.log('[SecretPanel] Initial secrets:', initialSecrets.current);

  // Create an array from the secrets object for easier rendering
  const secretsArray = Object.entries(characterValue?.settings?.secrets || {}).map(
    ([key, value]) => ({ key, value })
  );

  function handleAddSecret() {
    console.log('[SecretPanel] Adding secret:', keyInput, valueInput);
    if (keyInput && valueInput) {
      updateSecret(keyInput, valueInput);
      console.log('[SecretPanel] Secret added, new secrets:', characterValue?.settings?.secrets);
      setKeyInput('');
      setValueInput('');

      // After updating the secret, check if the changes should be sent to parent
      checkForChanges();
    }
  }

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

      setEnvs((prev) => {
        const merged = new Map(prev.map(({ name, value }) => [name, value]));
        for (const [key, val] of Object.entries(newEnvs)) {
          merged.set(key, val);
        }
        return Array.from(merged.entries()).map(([name, value]) => ({ name, value }));
      });
    };
    reader.readAsText(file);
  };

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

  const addEnv = () => {
    if (name && value) {
      setEnvs((prev) => {
        const updated = [...prev];
        const existingIndex = updated.findIndex((env) => env.name === name);
        if (existingIndex !== -1) {
          updated[existingIndex].value = value;
        } else {
          updated.push({ name, value });
        }
        return updated;
      });
      setName('');
      setValue('');
      
      // Also add to secrets
      updateSecret(name, value);
      checkForChanges();
    }
  };

  function handleEditSecret(index: number) {
    console.log('[SecretPanel] Editing secret at index:', index);
    const secretEntry = secretsArray[index];
    if (secretEntry) {
      setKeyInput(secretEntry.key);
      setValueInput(secretEntry.value as string);
      setEditIndex(index);
    }
  }

  function handleSaveEdit() {
    console.log('[SecretPanel] Saving edit for secret:', keyInput);
    if (keyInput && valueInput) {
      const oldKey = secretsArray[editIndex].key;

      // If key changed, remove the old one and add the new one
      if (oldKey !== keyInput) {
        console.log('[SecretPanel] Key changed from', oldKey, 'to', keyInput);
        removeSecret(oldKey);
        updateSecret(keyInput, valueInput);
      } else {
        // Just update the value
        updateSecret(keyInput, valueInput);
      }

      console.log('[SecretPanel] Edit saved, new secrets:', characterValue?.settings?.secrets);
      setKeyInput('');
      setValueInput('');
      setEditIndex(-1);

      // After updating the secret, check if the changes should be sent to parent
      checkForChanges();
    }
  }

  function handleRemoveSecret(key: string) {
    console.log('[SecretPanel] Removing secret:', key);
    removeSecret(key);

    console.log('[SecretPanel] Secret removed, new secrets:', characterValue?.settings?.secrets);

    // After removing the secret, check if the changes should be sent to parent
    checkForChanges();
  }

  function handleCancelEdit() {
    console.log('[SecretPanel] Canceling edit');
    setKeyInput('');
    setValueInput('');
    setEditIndex(-1);
  }

  // Check if secrets have changed and notify parent if needed
  function checkForChanges() {
    console.log('[SecretPanel] Checking for changes');
    console.log('[SecretPanel] Current secrets:', characterValue?.settings?.secrets);
    console.log('[SecretPanel] Initial secrets:', initialSecrets.current);

    // Use setTimeout to ensure we're checking after state updates are processed
    setTimeout(() => {
      // Check if secrets have changed
      const currentSecrets = characterValue?.settings?.secrets || {};
      const initialSecretsObj = initialSecrets.current;

      const initialKeys = Object.keys(initialSecretsObj);
      const currentKeys = Object.keys(currentSecrets);

      // Compare keys
      const keysChanged =
        initialKeys.length !== currentKeys.length ||
        initialKeys.some((key) => !currentKeys.includes(key)) ||
        currentKeys.some((key) => !initialKeys.includes(key));

      // Compare values for common keys
      const valuesChanged = currentKeys.some(
        (key) => initialKeys.includes(key) && initialSecretsObj[key] !== currentSecrets[key]
      );

      console.log('[SecretPanel] Keys changed:', keysChanged);
      console.log('[SecretPanel] Values changed:', valuesChanged);

      // If anything changed, notify the parent
      if (keysChanged || valuesChanged) {
        console.log('[SecretPanel] Secrets changed, notifying parent');
        onChange(characterValue);
      }
    }, 0);
  }

  return (
    <div className="rounded-lg w-full flex flex-col gap-4">
      <h2 className="text-xl font-bold mb-4 pb-2 ml-1">Environment Settings</h2>

      {/* Drag & Drop .env file section */}
      <div className="flex items-center justify-center w-full px-10 mb-6">
        <div
          ref={dropRef}
          className={`flex flex-col gap-2 items-center justify-center text-gray-500 w-full border-2 border-dashed border-muted rounded-lg p-12 text-center cursor-pointer transition ${
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
                handleFile(file);
              }
            }}
          />
        </div>
      </div>

      {/* Manual entry section */}
      <div className="grid gap-4 mb-6">
        <div className="grid grid-cols-[1fr_2fr_auto] gap-4 items-end w-full">
          <div className="flex flex-col gap-1">
            <Label htmlFor="secret-name" className="ml-2 text-xs font-medium text-gray-500">
              NAME
            </Label>
            <Input
              id="secret-name"
              placeholder="VARIABLE_NAME"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1 relative">
            <Label htmlFor="secret-value" className="ml-2 text-xs font-medium text-gray-500">
              VALUE
            </Label>
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
                tabIndex={0}
                role="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </div>
            </div>
          </div>
          <Button className="shrink-0" onClick={addEnv}>
            Add
          </Button>
        </div>

        {/* Advanced secret management */}
        <div className="grid gap-2">
          <Label htmlFor="secret-key">Secret Key</Label>
          <Input
            id="secret-key"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            disabled={editIndex !== -1 && secretsArray[editIndex]?.key === 'OPENAI_API_KEY'}
            placeholder="Enter secret key"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="secret-value">Secret Value</Label>
          <Input
            id="secret-value"
            value={valueInput}
            onChange={(e) => setValueInput(e.target.value)}
            placeholder="Enter secret value"
          />
        </div>
        <div className="flex gap-2">
          {editIndex === -1 ? (
            <Button type="button" onClick={handleAddSecret}>
              Add Secret
            </Button>
          ) : (
            <>
              <Button type="button" onClick={handleSaveEdit}>
                Save
              </Button>
              <Button type="button" variant="outline" onClick={handleCancelEdit}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      {/* List of secrets */}
      <div className="border rounded-md p-4 mt-2">
        <h3 className="font-medium mb-2">Secrets</h3>
        {secretsArray.length === 0 ? (
          <p className="text-sm text-muted-foreground">No secrets added yet</p>
        ) : (
          <ul className="space-y-2">
            {secretsArray.map((secret, index) => (
              <li key={secret.key} className="flex justify-between items-center text-sm">
                <span className="font-mono">{secret.key}</span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleEditSecret(index)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveSecret(secret.key)}
                    disabled={secret.key === 'OPENAI_API_KEY'}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
