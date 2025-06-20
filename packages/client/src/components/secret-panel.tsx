import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Agent } from '@elizaos/core';
import { Check, CloudUpload, Eye, EyeOff, MoreVertical, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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

export function SecretPanel({ characterValue, onChange }: SecretPanelProps) {
  const [envs, setEnvs] = useState<EnvVariable[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedValue, setEditedValue] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [deletedKeys, setDeletedKeys] = useState<string[]>([]);
  const [changesPending, setChangesPending] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updatedSecrets = Object.entries(characterValue?.settings?.secrets || {}).map(
      ([name, value]) => ({
        name,
        value: String(value),
        isNew: false,
        isModified: false,
        isDeleted: false,
      })
    );
    setEnvs(updatedSecrets);
  }, [characterValue]);

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
        return Array.from(merged.entries()).map(([name, value]) => ({
          name,
          value,
          isNew: !prev.some((env) => env.name === name),
          isModified: prev.some((env) => env.name === name && env.value !== value),
        }));
      });

      if (deletedKeys.length > 0) {
        setDeletedKeys((prev) => prev.filter((key) => !Object.keys(newEnvs).includes(key)));
      }

      setChangesPending(true);
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
      const exists = envs.some((env) => env.name === name);
      if (!exists) {
        if (deletedKeys.includes(name)) {
          setDeletedKeys(deletedKeys.filter((key) => key !== name));
        }

        setEnvs([...envs, { name, value, isNew: true }]);
        setName('');
        setValue('');
        setChangesPending(true);
      } else {
        setEnvs(envs.map((env) => (env.name === name ? { ...env, value, isModified: true } : env)));
        setName('');
        setValue('');
        setChangesPending(true);
      }
    }
  };

  const startEditing = (index: number) => {
    setEditingIndex(index);
    setEditedValue(envs[index].value);
    setOpenIndex(null);
  };

  const saveEdit = (index: number) => {
    const updatedEnvs = [...envs];
    if (updatedEnvs[index].value !== editedValue) {
      updatedEnvs[index].value = editedValue;
      updatedEnvs[index].isModified = true;
      setChangesPending(true);
    }
    setEnvs(updatedEnvs);
    setEditingIndex(null);
  };

  const removeEnv = (index: number) => {
    const keyToRemove = envs[index].name;

    setDeletedKeys([...deletedKeys, keyToRemove]);

    setEnvs(envs.filter((_, i) => i !== index));
    setOpenIndex(null);
    setEditingIndex(null);
    setChangesPending(true);
  };

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
    if (changesPending) {
      const currentSecrets: Record<string, string | null> = {};

      envs.forEach(({ name, value }) => {
        currentSecrets[name] = value;
      });

      deletedKeys.forEach((key) => {
        currentSecrets[key] = null;
      });

      const updatedAgent: Partial<Agent> = {
        settings: {
          secrets: currentSecrets,
        },
      };

      onChange(updatedAgent as Agent);

      setEnvs((prevEnvs) => {
        return prevEnvs.map((env) => ({
          ...env,
          isNew: false,
          isModified: false,
        }));
      });

      setDeletedKeys([]);
      setChangesPending(false);
    }
  }, [envs, onChange, deletedKeys, changesPending]);

  return (
    <div className="rounded-lg w-full flex flex-col gap-3">
      <h2 className="text-xl font-bold mb-4 pb-5 ml-1">Environment Settings</h2>

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
                handleFile(file);
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
            >
              {showPassword ? <EyeOff /> : <Eye />}
            </div>
          </div>
        </div>
        <Button 
          className="shrink-0"
          onClick={(e) => {
            e.preventDefault();
            addEnv();
          }}
        >
          Add
        </Button>
      </div>

      {envs.length > 0 && (
        <div className="grid grid-cols-[1fr_2fr_auto] gap-4 mt-6 font-medium text-gray-400 border-b pb-2 ml-1">
          <div>Name</div>
          <div>Value</div>
          <div>Action</div>
        </div>
      )}

      <div className="mt-2 overflow-y-auto max-h-72">
        {envs.map((env, index) => (
          <div
            key={index}
            className="grid grid-cols-[1fr_2fr_auto] gap-4 items-center border-b py-2 ml-1 relative"
          >
            <div>{env.name}</div>
            <div>
              {editingIndex === index ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={editedValue}
                    onChange={(e) => setEditedValue(e.target.value)}
                    className="w-full"
                  />
                  <Button variant="ghost" onClick={() => saveEdit(index)}>
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
                onClick={(e) => {
                  e.preventDefault();
                  setOpenIndex(openIndex === index ? null : index);
                }}
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
