import ArrayInput from "@/components/array-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import type { Character } from "@elizaos/core";
import React, { useState, type FormEvent, type ReactNode } from "react";

type FieldType = "text" | "textarea" | "number" | "checkbox" | "select";

type InputField = {
  title: string;
  name: string;
  description?: string;
  getValue: (char: Character) => string;
  fieldType: FieldType
};

type ArrayField = {
  title: string;
  description?: string;
  path: string;
  getData: (char: Character) => string[];
};

enum SECTION_TYPE {
  INPUT = "input",
  ARRAY = "array"
}

const CHARACTER_FORM_SCHEMA = [
  {
    sectionTitle: "Basic Info",
    sectionValue: "basic",
    sectionType: SECTION_TYPE.INPUT,
    fields: [
      {
        title: "Name",
        name: "name",
        description: "The display name of your character",
        fieldType: "text",
        getValue: (char) => char.name || '',
      },
      {
        title: "Username",
        name: "username",
        description: "Unique identifier for your character",
        fieldType: "text",
        getValue: (char) => char.username || '',
      },
      {
        title: "System",
        name: "system",
        description: "System prompt for character behavior",
        fieldType: "textarea",
        getValue: (char) => char.system || '',
      },
      {
        title: "Voice Model",
        name: "settings.voice.model",
        description: "Voice model used for speech synthesis",
        fieldType: "text",
        getValue: (char) => char.settings?.voice?.model || '',
      },
    ] as InputField[]
  },
  {
    sectionTitle: "Content",
    sectionValue: "content",
    sectionType: SECTION_TYPE.ARRAY,
    fields: [
      {
        title: "Bio",
        description: "Key information about your character",
        path: "bio",
        getData: (char) => Array.isArray(char.bio) ? char.bio : [],
      },
      {
        title: "Topics",
        description: "Topics your character is knowledgeable about",
        path: "topics",
        getData: (char) => char.topics || [],
      },
      {
        title: "Adjectives",
        description: "Words that describe your character's personality",
        path: "adjectives",
        getData: (char) => char.adjectives || [],
      },
    ] as ArrayField[]
  },
  {
    sectionTitle: "Style",
    sectionValue: "style",
    sectionType: SECTION_TYPE.ARRAY,
    fields: [
      {
        title: "All",
        description: "Style rules applied to all interactions",
        path: "style.all",
        getData: (char) => char.style?.all || [],
      },
      {
        title: "Chat",
        description: "Style rules for chat interactions",
        path: "style.chat",
        getData: (char) => char.style?.chat || [],
      },
      {
        title: "Post",
        description: "Style rules for social media posts",
        path: "style.post",
        getData: (char) => char.style?.post || [],
      },
    ] as ArrayField[]
  }
]

type customComponent = {
  name: string,
  component: ReactNode
}

export type CharacterFormProps = {
  title: string;
  description: string;
  onSubmit: (character: Character) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel?: () => void;
  onReset?: () => void;
  submitButtonText?: string;
  deleteButtonText?: string;
  deleteButtonVariant?: "destructive" | "default" | "outline" | "secondary" | "ghost" | "link" | "primary";
  isAgent?: boolean;
  customComponents?: customComponent[];
  characterValue: Character;
  setCharacterValue: (value: (prev: Character) => Character) => void;
};

export default function CharacterForm({
  characterValue, 
  setCharacterValue,
  title,
  description,
  onSubmit,
  onDelete,
  onCancel,
  onReset,
  submitButtonText = "Save Changes",
  deleteButtonText = "Delete",
  deleteButtonVariant = "destructive",
  customComponents = []
}: CharacterFormProps) {
  const { toast } = useToast();

  // const [characterValue, setCharacterValue] = useState<Character>(character);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;
    
    if (name.includes('.')) {
      const parts = name.split('.');
      setCharacterValue(prev => {
        const newValue = { ...prev };
        let current: Record<string, any> = newValue;
        
        for (let i = 0; i < parts.length - 1; i++) {
          if (!current[parts[i]]) {
            current[parts[i]] = {};
          }
          current = current[parts[i]];
        }
        
        current[parts[parts.length - 1]] = type === 'checkbox' ? checked : value;
        return newValue;
      });
    } else {
      setCharacterValue(prev => ({
        ...prev,
        [name]: type === 'checkbox' ? checked : value
      }));
    }
  };

  const updateArray = (path: string, newData: string[]) => {
    setCharacterValue(prev => {
      const newValue = { ...prev };
      const keys = path.split(".");
      let current: any = newValue;
  
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
  
        if (!current[key] || typeof current[key] !== "object") {
          current[key] = {}; // Ensure path exists
        }
        current = current[key];
      }
  
      current[keys[keys.length - 1]] = newData; // Update array
  
      return newValue;
    });
  };
  

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    
    try {
      await onSubmit(characterValue);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    
    setIsDeleting(true);
    
    try {
      await onDelete();
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };


  const renderInputField = (field: InputField) => (
    <div key={field.name} className="space-y-2">
      <Label htmlFor={field.name}>{field.title}</Label>
      {field.description && <p className="text-sm text-muted-foreground">{field.description}</p>}
      
      {field.fieldType === "textarea" ? (
        <Textarea
          id={field.name}
          name={field.name}
          value={field.getValue(characterValue)}
          onChange={handleChange}
          className="min-h-[120px] resize-y"
        />
      ) : field.fieldType === "checkbox" ? (
        <Input
          id={field.name}
          name={field.name}
          type="checkbox"
          checked={(characterValue as Record<string, any>)[field.name] === "true"}
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
      <ArrayInput data={field.getData(characterValue)} onChange={(newData) => updateArray(field.path, newData)} />
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

      <form onSubmit={handleSubmit}>
        <Tabs defaultValue="basic" className="w-full">
          <TabsList 
            className={`grid w-full mb-6`}
            style={{ gridTemplateColumns: `repeat(${customComponents.length + 3}, minmax(0, 1fr))` }}
          >
            {CHARACTER_FORM_SCHEMA.map((section) => (
              <TabsTrigger key={section.sectionValue} value={section.sectionValue}>{section.sectionTitle}</TabsTrigger>
            ))}
            {customComponents.map((component, index) => (
              <TabsTrigger key={`custom-${index}`} value={`custom-${index}`}>{component.name}</TabsTrigger>
            ))}
          </TabsList>
          
          <Card>
            <CardContent className="p-6">
              {CHARACTER_FORM_SCHEMA.map((section) => (
                <TabsContent key={section.sectionValue} value={section.sectionValue} className="space-y-6">
                  {section.sectionType === SECTION_TYPE.INPUT
                    ? (section.fields as InputField[]).map(renderInputField)
                    : (section.fields as ArrayField[]).map(renderArrayField)}
                </TabsContent>
              ))}
              {customComponents.map((component, index) => (
                <TabsContent key={`custom-${index}`} value={`custom-${index}`}>{component.component}</TabsContent>
              ))}
            </CardContent>
          </Card>
        </Tabs>

        <div className="flex justify-between gap-4 mt-6">
          <div className="flex gap-4">
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            )}
            
            {onDelete && (
              <Button
                type="button"
                variant={deleteButtonVariant as any}
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : deleteButtonText}
              </Button>
            )}
          </div>
          
          <div className="flex gap-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onReset && onReset();
                // setCharacterValue(character)
              }}
            >
              Reset Changes
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Saving...' : submitButtonText}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
} 