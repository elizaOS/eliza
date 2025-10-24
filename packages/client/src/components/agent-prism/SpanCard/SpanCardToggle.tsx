import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent } from 'react';

interface SpanCardToggleProps {
  isExpanded: boolean;
  title: string;
  onToggleClick: (e: MouseEvent | KeyboardEvent) => void;
}

export const SpanCardToggle = ({ isExpanded, title, onToggleClick }: SpanCardToggleProps) => (
  <Collapsible.Trigger asChild>
    <button
      className="flex h-4 w-5 shrink-0 items-center justify-center"
      onClick={onToggleClick}
      onKeyDown={onToggleClick}
      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${title} children`}
      aria-expanded={isExpanded}
      type="button"
    >
      {isExpanded ? (
        <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" />
      ) : (
        <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground" />
      )}
    </button>
  </Collapsible.Trigger>
);
