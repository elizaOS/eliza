import ArrayInput from '@/components/array-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { AVATAR_IMAGE_MAX_SIZE, FIELD_REQUIREMENT, FIELD_REQUIREMENTS } from '@/constants';
import { useToast } from '@/hooks/use-toast';
import { compressImage } from '@/lib/utils';
import type { Agent } from '@elizaos/core';
import type React from 'react';
import { type FormEvent, type ReactNode, useState, useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getAllVoiceModels,
  getVoiceModelByValue,
  providerPluginMap,
  getAllRequiredPlugins,
} from '../config/voice-models';
import { useElevenLabsVoices } from '@/hooks/use-elevenlabs-voices';
import { HelpCircle, Trash, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

type FieldType = 'text' | 'textarea' | 'number' | 'checkbox' | 'select';

export type InputField = {
  name: string;
  title: string;
  description?: string;
  fieldType: 'text' | 'textarea' | 'email' | 'url' | 'checkbox' | 'select';
  getValue: (agent: Agent) => string;
  options?: { value: string; label: string }[];
  tooltip?: string;
};

export type ArrayField = {
  path: string;
  title: string;
  description?: string;
  getData: (agent: Agent) => string[];
  tooltip?: string;
};

enum SECTION_TYPE {
  INPUT = 'input',
  ARRAY = 'array',
}

type customComponent = {
  name: string;
  component: ReactNode;
};

export type CharacterFormProps = {
  title: string;
  description: string;
  onSubmit: (character: Agent) => Promise<void>;
  onDelete?: () => void;
  onReset?: () => void;
  stopAgentButton?: React.ReactNode;
  isAgent?: boolean;
  isDeleting?: boolean;
  customComponents?: customComponent[];
  characterValue: Agent;
  setCharacterValue: {
    updateField: <T>(path: string, value: T) => void;
    addArrayItem?: <T>(path: string, item: T) => void;
    removeArrayItem?: (path: string, index: number) => void;
    updateSetting?: (path: string, value: any) => void;
    importAgent?: (value: Agent) => void;
    [key: string]: any;
  };
};

export default function CharacterForm({
  characterValue,
  setCharacterValue,
  title,
  description,
  onSubmit,
  onDelete,
  onReset,
  stopAgentButton,
  isDeleting = false,
  customComponents = [],
}: CharacterFormProps) {
  const { toast } = useToast();
  const { data: elevenlabsVoices, isLoading: isLoadingVoices } = useElevenLabsVoices();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Get all voice models, using the dynamic ElevenLabs voices when available
  const allVoiceModels = useMemo(() => {
    const staticModels = getAllVoiceModels();

    // If we have dynamically loaded ElevenLabs voices, replace the static ones
    if (elevenlabsVoices && !isLoadingVoices) {
      // Filter out the static ElevenLabs voices
      const nonElevenLabsModels = staticModels.filter((model) => model.provider !== 'elevenlabs');
      // Return combined models with dynamic ElevenLabs voices
      return [...nonElevenLabsModels, ...elevenlabsVoices];
    }

    // Otherwise return the static models
    return staticModels;
  }, [elevenlabsVoices, isLoadingVoices]);

  // Define form schema with dynamic voice model options
  const AGENT_FORM_SCHEMA = useMemo(
    () => [
      {
        sectionTitle: 'Basic Info',
        sectionValue: 'basic',
        sectionType: SECTION_TYPE.INPUT,
        fields: [
          {
            title: 'Name',
            name: 'name',
            description: 'The primary identifier for this agent',
            fieldType: 'text',
            getValue: (char) => char.name || '',
            tooltip:
              'Display name that will be visible to users. Required for identification purposes.',
          },
          {
            title: 'Username',
            name: 'username',
            description: 'Used in URLs and API endpoints',
            fieldType: 'text',
            getValue: (char) => char.username || '',
            tooltip: 'Unique identifier for your agent. Used in APIs/URLs and Rooms.',
          },
          {
            title: 'System',
            name: 'system',
            description: 'System prompt defining agent behavior',
            fieldType: 'textarea',
            getValue: (char) => char.system || '',
            tooltip:
              'Instructions for the AI model that establish core behavior patterns and personality traits.',
          },
          {
            title: 'Voice Model',
            name: 'settings.voice.model',
            description: 'Voice model for audio synthesis',
            fieldType: 'select',
            getValue: (char) => char.settings?.voice?.model || '',
            options: allVoiceModels.map((model) => ({
              value: model.value,
              label: model.label,
            })),
            tooltip: "Select a voice that aligns with the agent's intended persona.",
          },
        ] as InputField[],
      },
      {
        sectionTitle: 'Content',
        sectionValue: 'content',
        sectionType: SECTION_TYPE.ARRAY,
        fields: [
          {
            title: 'Bio',
            description: 'Bio data for this agent',
            path: 'bio',
            getData: (char) => (Array.isArray(char.bio) ? char.bio : []),
            tooltip: "Biographical details that establish the agent's background and context.",
          },
          {
            title: 'Topics',
            description: 'Topics this agent can talk about',
            path: 'topics',
            getData: (char) => char.topics || [],
            tooltip: 'Subject domains the agent can discuss with confidence.',
          },
          {
            title: 'Adjectives',
            description: 'Descriptive personality traits',
            path: 'adjectives',
            getData: (char) => char.adjectives || [],
            tooltip: "Key personality attributes that define the agent's character.",
          },
        ] as ArrayField[],
      },
      {
        sectionTitle: 'Style',
        sectionValue: 'style',
        sectionType: SECTION_TYPE.ARRAY,
        fields: [
          {
            title: 'All Styles',
            description: 'Writing style for all content types',
            path: 'style.all',
            getData: (char) => char.style?.all || [],
            tooltip: 'Core writing style guidelines applied across all content formats.',
          },
          {
            title: 'Chat Style',
            description: 'Style specific to chat interactions',
            path: 'style.chat',
            getData: (char) => char.style?.chat || [],
            tooltip: 'Writing style specific to conversational exchanges.',
          },
          {
            title: 'Post Style',
            description: 'Style for long-form content',
            path: 'style.post',
            getData: (char) => char.style?.post || [],
            tooltip: 'Writing style for structured content such as articles or posts.',
          },
        ] as ArrayField[],
      },
    ],
    [allVoiceModels]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;

    if (type === 'checkbox') {
      setCharacterValue.updateField(name, checked);
    } else if (name.startsWith('settings.')) {
      // Handle nested settings fields like settings.voice.model
      const path = name.substring(9); // Remove 'settings.' prefix

      if (setCharacterValue.updateSetting) {
        // Use the specialized method if available
        setCharacterValue.updateSetting(path, value);
      } else {
        // Fall back to generic updateField
        setCharacterValue.updateField(name, value);
      }
    } else {
      setCharacterValue.updateField(name, value);
    }
  };

  const handleVoiceModelChange = (value: string, name: string) => {
    if (name.startsWith('settings.')) {
      const path = name.substring(9); // Remove 'settings.' prefix

      if (setCharacterValue.updateSetting) {
        // Use the specialized method if available
        setCharacterValue.updateSetting(path, value);

        // Handle voice model change and required plugins
        if (path === 'voice.model' && value) {
          const voiceModel = getVoiceModelByValue(value);
          if (voiceModel) {
            const currentPlugins = Array.isArray(characterValue.plugins)
              ? [...characterValue.plugins]
              : [];
            const previousVoiceModel = getVoiceModelByValue(characterValue.settings?.voice?.model);

            // Get all voice-related plugins
            const voicePlugins = getAllRequiredPlugins();

            // Get the required plugin for the new voice model
            const requiredPlugin = providerPluginMap[voiceModel.provider];

            // Filter out all voice-related plugins
            const filteredPlugins = currentPlugins.filter(
              (plugin) => !voicePlugins.includes(plugin)
            );

            // Add the required plugin for the selected voice model
            const newPlugins = [...filteredPlugins];
            if (requiredPlugin && !filteredPlugins.includes(requiredPlugin)) {
              newPlugins.push(requiredPlugin);
            }

            // Update the plugins
            if (setCharacterValue.setPlugins) {
              setCharacterValue.setPlugins(newPlugins);
            } else if (setCharacterValue.updateField) {
              setCharacterValue.updateField('plugins', newPlugins);
            }

            // Show toast notification
            if (previousVoiceModel?.provider !== voiceModel.provider) {
              toast({
                title: 'Plugin Updated',
                description: `${requiredPlugin} plugin has been set for the selected voice model.`,
              });
            }
          }
        }
      } else {
        // Fall back to generic updateField
        setCharacterValue.updateField(name, value);
      }
    } else {
      setCharacterValue.updateField(name, value);
    }
  };

  const updateArray = (path: string, newData: string[]) => {
    // If the path is a simple field name
    if (!path.includes('.')) {
      setCharacterValue.updateField(path, newData);
      return;
    }

    // Handle nested paths (e.g. style.all)
    const parts = path.split('.');
    if (parts.length === 2 && parts[0] === 'style') {
      // For style arrays, use the setStyleArray method if available
      if (setCharacterValue.setStyleArray) {
        setCharacterValue.setStyleArray(parts[1] as 'all' | 'chat' | 'post', newData);
      } else {
        setCharacterValue.updateField(path, newData);
      }
      return;
    }

    // Default case - just update the field
    setCharacterValue.updateField(path, newData);
  };

  const ensureAvatarSize = async (char: Agent): Promise<Agent> => {
    if (char.settings?.avatar) {
      const img = new Image();
      img.src = char.settings.avatar;
      await new Promise((resolve) => (img.onload = resolve));

      if (img.width > AVATAR_IMAGE_MAX_SIZE || img.height > AVATAR_IMAGE_MAX_SIZE) {
        const response = await fetch(char.settings.avatar);
        const blob = await response.blob();
        const file = new File([blob], 'avatar.jpg', { type: blob.type });
        const compressedImage = await compressImage(file);
        return {
          ...char,
          settings: {
            ...char.settings,
            avatar: compressedImage,
          },
        };
      }
    }
    return char;
  };

  const handleFormSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const updatedCharacter = await ensureAvatarSize(characterValue);
      await onSubmit(updatedCharacter);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update agent',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderInputField = (field: InputField) => (
    <div key={field.name} className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={field.name} className="flex items-center gap-1">
          {field.title}
          {field.name in FIELD_REQUIREMENTS && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-1">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        (FIELD_REQUIREMENTS as Record<string, FIELD_REQUIREMENT>)[field.name] ===
                        FIELD_REQUIREMENT.REQUIRED
                          ? 'bg-red-500'
                          : 'bg-gray-400'
                      }`}
                    ></span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" align="start">
                  <p>
                    {(FIELD_REQUIREMENTS as Record<string, FIELD_REQUIREMENT>)[field.name] ===
                    FIELD_REQUIREMENT.REQUIRED
                      ? 'Required'
                      : 'Optional'}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </Label>
        {field.tooltip && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{field.tooltip}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {field.description && <p className="text-sm text-muted-foreground">{field.description}</p>}

      {field.fieldType === 'textarea' ? (
        <Textarea
          id={field.name}
          name={field.name}
          value={field.getValue(characterValue)}
          onChange={handleChange}
          className="min-h-[120px] resize-y"
        />
      ) : field.fieldType === 'checkbox' ? (
        <Input
          id={field.name}
          name={field.name}
          type="checkbox"
          checked={(characterValue as Record<string, any>)[field.name] === 'true'}
          onChange={handleChange}
        />
      ) : field.fieldType === 'select' ? (
        <Select
          name={field.name}
          value={field.getValue(characterValue)}
          onValueChange={(value) => handleVoiceModelChange(value, field.name)}
        >
          <SelectTrigger>
            <SelectValue
              placeholder={
                field.name.includes('voice.model') && isLoadingVoices
                  ? 'Loading voice models...'
                  : 'Select a voice model'
              }
            />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={field.name}
          name={field.name}
          type={field.fieldType}
          value={field.getValue(characterValue)}
          onChange={handleChange}
        />
      )}
    </div>
  );

  const renderArrayField = (field: ArrayField) => (
    <div key={field.path} className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={field.path} className="flex items-center gap-1">
          {field.title}
          {field.path in FIELD_REQUIREMENTS && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-1">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        (FIELD_REQUIREMENTS as Record<string, FIELD_REQUIREMENT>)[field.path] ===
                        FIELD_REQUIREMENT.REQUIRED
                          ? 'bg-red-500'
                          : 'bg-gray-400'
                      }`}
                    ></span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" align="start">
                  <p>
                    {(FIELD_REQUIREMENTS as Record<string, FIELD_REQUIREMENT>)[field.path] ===
                    FIELD_REQUIREMENT.REQUIRED
                      ? 'Required'
                      : 'Optional'}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </Label>
        {field.tooltip && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>
                <p>{field.tooltip}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {field.description && <p className="text-sm text-muted-foreground">{field.description}</p>}
      <ArrayInput
        data={field.getData(characterValue)}
        onChange={(newData) => updateArray(field.path, newData)}
      />
    </div>
  );

  const handleImportJSON = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const json: Agent = JSON.parse(text);

      if (setCharacterValue.importAgent) {
        setCharacterValue.importAgent(json);
      } else {
        console.warn('Missing importAgent method');
      }

      toast({
        title: 'Agent Imported',
        description: 'Agent data has been successfully loaded.',
      });
    } catch (error) {
      toast({
        title: 'Import Failed',
        description: error instanceof Error ? error.message : 'Invalid JSON file',
        variant: 'destructive',
      });
    } finally {
      event.target.value = '';
    }
  };

  return (
    <div className="container max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">{title || 'Agent Settings'}</h1>
          <p className="text-muted-foreground mt-1">
            {description || 'Configure your agent settings'}
          </p>
        </div>
      </div>

      <form onSubmit={handleFormSubmit}>
        <Tabs defaultValue="basic" className="w-full">
          <TabsList
            className={'grid w-full mb-6'}
            style={{
              gridTemplateColumns: `repeat(${customComponents.length + 3}, minmax(0, 1fr))`,
            }}
          >
            {AGENT_FORM_SCHEMA.map((section) => (
              <TabsTrigger key={section.sectionValue} value={section.sectionValue}>
                {section.sectionTitle}
              </TabsTrigger>
            ))}
            {customComponents.map((component) => (
              <TabsTrigger key={`custom-${component.name}`} value={`custom-${component.name}`}>
                {component.name}
              </TabsTrigger>
            ))}
          </TabsList>

          <Card>
            <CardContent className="p-6">
              {AGENT_FORM_SCHEMA.map((section) => (
                <TabsContent
                  key={section.sectionValue}
                  value={section.sectionValue}
                  className="space-y-6"
                >
                  {section.sectionType === SECTION_TYPE.INPUT
                    ? (section.fields as InputField[]).map(renderInputField)
                    : (section.fields as ArrayField[]).map(renderArrayField)}
                </TabsContent>
              ))}
              {customComponents.map((component) => (
                <TabsContent key={`custom-${component.name}`} value={`custom-${component.name}`}>
                  {component.component}
                </TabsContent>
              ))}
            </CardContent>
          </Card>
        </Tabs>

        <div className="flex justify-between gap-4 mt-6">
          <div className="flex gap-4">
            {onDelete && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onDelete?.();
                }}
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash className="mr-2 h-4 w-4" />
                    Delete Agent
                  </>
                )}
              </Button>
            )}
            {stopAgentButton}
          </div>

          <div className="flex gap-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onReset?.();
              }}
            >
              Reset Changes
            </Button>
            <div className="relative">
              <input
                type="file"
                accept=".json"
                onChange={handleImportJSON}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <Button type="button" variant="outline">
                Import JSON
              </Button>
            </div>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
