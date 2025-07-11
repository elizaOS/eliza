import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

type TagProps = {
  tag: string;
  onRemove: (tag: string) => void;
};

const Tag = ({ tag, onRemove }: TagProps) => (
  <Badge
    variant="outline"
    className="flex items-center gap-1.5 pr-1.5 text-sm py-1 px-2 transition-colors hover:bg-accent hover:text-accent-foreground"
  >
    {tag}
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => onRemove(tag)}
      className="hover:bg-accent/20 rounded-full p-0.5 transition-colors h-auto w-auto min-w-0 min-h-0"
    >
      <X className="h-3 w-3" />
      <span className="sr-only">Remove {tag}</span>
    </Button>
  </Badge>
);

type TagListProps = {
  tags: string[];
  onRemove: (tag: string) => void;
};

const TagList = ({ tags, onRemove }: TagListProps) => (
  <div className="flex flex-wrap gap-2 mb-2">
    {tags.map((tag) => (
      <Tag key={tag} tag={tag} onRemove={onRemove} />
    ))}
  </div>
);

type TagInputProps = {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onAdd: () => void;
};

const TagInput = ({ value, onChange, onKeyDown, onAdd }: TagInputProps) => (
  <div className="relative">
    <Input
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder="Type and press Enter or click Add..."
      className={cn('bg-background pr-16', !value && 'text-muted-foreground')}
    />
    {value.trim() && (
      <Button
        size="sm"
        onClick={onAdd}
        className="absolute top-1/2 -translate-y-1/2 right-2 h-7 px-3"
      >
        Add
      </Button>
    )}
  </div>
);

type ArrayInputProps = {
  title?: string;
  data: string[];
  onChange: (newData: string[]) => void;
};

export default function ArrayInput({ title, data, onChange }: ArrayInputProps) {
  const [inputValue, setInputValue] = useState('');

  const addTag = () => {
    const trimmedValue = inputValue.trim();
    if (trimmedValue && !data.includes(trimmedValue)) {
      onChange([...data, trimmedValue]);
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag();
    }
  };

  const removeTag = (tagToRemove: string) => {
    onChange(data.filter((tag) => tag !== tagToRemove));
  };

  return (
    <div className="space-y-2">
      <Label>{title}</Label>
      <div className="p-2 bg-card rounded border border-input">
        <TagList tags={data} onRemove={removeTag} />
        <TagInput
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onAdd={addTag}
        />
      </div>
    </div>
  );
}
