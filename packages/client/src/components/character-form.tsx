import ArrayInput from '@/components/array-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { AVATAR_IMAGE_MAX_SIZE } from '@/constants';
import { useToast } from '@/hooks/use-toast';
import { compressImage } from '@/lib/utils';
import type { Agent } from '@elizaos/core';
import type React from 'react';
import { type FormEvent, type ReactNode, useState } from 'react';

type FieldType = 'text' | 'textarea' | 'number' | 'checkbox' | 'select';

type InputField = {
  title: string;
  name: string;
  description?: string;
  getValue: (char: Agent) => string;
  fieldType: FieldType;
};

type ArrayField = {
  title: string;
  description?: string;
  path: string;
  getData: (char: Agent) => string[];
};

enum SECTION_TYPE {
  INPUT = 'input',
  ARRAY = 'array',
}

const CHARACTER_FORM_SCHEMA = [
  {
    sectionTitle: 'Basic Info',
    sectionValue: 'basic',
    sectionType: SECTION_TYPE.INPUT,
    fields: [
      {
        title: 'Name',
        name: 'name',
        description: 'The display name of your character',
        fieldType: 'text',
        getValue: (char) => char.name || '',
      },
      {
        title: 'Username',
        name: 'username',
        description: 'Unique identifier for your character',
        fieldType: 'text',
        getValue: (char) => char.username || '',
      },
      {
        title: 'System',
        name: 'system',
        description: 'System prompt for character behavior',
        fieldType: 'textarea',
        getValue: (char) => char.system || '',
      },
      {
        title: 'Voice Model',
        name: 'settings.voice.model',
        description: 'Voice model used for speech synthesis',
        fieldType: 'text',
        getValue: (char) => char.settings?.voice?.model || '',
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
        description: 'Key information about your character',
        path: 'bio',
        getData: (char) => (Array.isArray(char.bio) ? char.bio : []),
      },
      {
        title: 'Topics',
        description: 'Topics your character is knowledgeable about',
        path: 'topics',
        getData: (char) => char.topics || [],
      },
      {
        title: 'Adjectives',
        description: "Words that describe your character's personality",
        path: 'adjectives',
        getData: (char) => char.adjectives || [],
      },
    ] as ArrayField[],
  },
  {
    sectionTitle: 'Style',
    sectionValue: 'style',
    sectionType: SECTION_TYPE.ARRAY,
    fields: [
      {
        title: 'All',
        description: 'Style rules applied to all interactions',
        path: 'style.all',
        getData: (char) => char.style?.all || [],
      },
      {
        title: 'Chat',
        description: 'Style rules for chat interactions',
        path: 'style.chat',
        getData: (char) => char.style?.chat || [],
      },
      {
        title: 'Post',
        description: 'Style rules for social media posts',
        path: 'style.post',
        getData: (char) => char.style?.post || [],
      },
    ] as ArrayField[],
  },
];

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
  isAgent?: boolean;
  customComponents?: customComponent[];
  characterValue: Agent;
  setCharacterValue: {
    updateField: <T>(path: string, value: T) => void;
    addArrayItem?: <T>(path: string, item: T) => void;
    removeArrayItem?: (path: string, index: number) => void;
    updateObject?: (newPartialValue: Partial<Agent>) => void;
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
  customComponents = [],
}: CharacterFormProps) {
  const { toast } = useToast();

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;

    if (type === 'checkbox') {
      setCharacterValue.updateField(name, checked);
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
        description: error instanceof Error ? error.message : 'Failed to update',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderInputField = (field: InputField) => (
    <div key={field.name} className="space-y-2">
      <Label htmlFor={field.name}>{field.title}</Label>
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
      <Label htmlFor={field.path}>{field.title}</Label>
      {field.description && <p className="text-sm text-muted-foreground">{field.description}</p>}
      <ArrayInput
        data={field.getData(characterValue)}
        onChange={(newData) => updateArray(field.path, newData)}
      />
    </div>
  );

  return (
    <div className="container max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">{title}</h1>
          <p className="text-muted-foreground mt-1">{description}</p>
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
            {CHARACTER_FORM_SCHEMA.map((section) => (
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
              {CHARACTER_FORM_SCHEMA.map((section) => (
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
          <div className="flex gap-4 text-red-500">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onDelete?.();
              }}
            >
              Delete Character
            </Button>
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
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
