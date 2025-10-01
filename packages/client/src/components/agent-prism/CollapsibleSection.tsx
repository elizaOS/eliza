import * as Collapsible from '@radix-ui/react-collapsible';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';

export interface CollapsibleSectionProps {
  /**
   * The title text displayed in the trigger button
   */
  title: string;

  /**
   * The content to display on the right side of the title
   */
  rightContent?: React.ReactNode;

  /**
   * The content to display when the section is expanded
   */
  children: React.ReactNode;

  /**
   * Whether the section starts in an open state
   * @default false
   */
  defaultOpen?: boolean;

  /**
   * Optional className for the root container
   */
  className?: string;

  /**
   * Optional className for the trigger button
   */
  triggerClassName?: string;

  /**
   * Optional className for the content area
   */
  contentClassName?: string;

  /**
   * Optional callback fired when the section is expanded or collapsed
   */
  onOpenChange?: (open: boolean) => void;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  rightContent,
  children,
  defaultOpen = false,
  className = '',
  triggerClassName = '',
  contentClassName = '',
  onOpenChange,
}) => {
  const [open, setOpen] = React.useState(defaultOpen);

  const handleOpenChange = React.useCallback(
    (open: boolean): void => {
      setOpen(open);
      onOpenChange?.(open);
    },
    [onOpenChange]
  );

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleOpenChange(!open);
      }
    },
    [handleOpenChange, open]
  );

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={handleOpenChange}
      className={cn('rounded-lg', className)}
    >
      <Collapsible.Trigger asChild>
        <div
          tabIndex={0}
          role="button"
          className={cn(
            'mb-1 flex w-full items-center justify-between gap-2 rounded-lg px-1 py-3 text-left text-sm font-medium text-foreground',
            triggerClassName
          )}
          onKeyDown={handleKeyDown}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} content of "${title}" section`}
        >
          <div className="flex w-full items-center gap-2">
            <ChevronDown
              className={cn(
                'h-3 w-3 text-muted-foreground transition-transform duration-200',
                open && 'rotate-180'
              )}
            />
            <span className="truncate">{title}</span>
          </div>

          {rightContent}
        </div>
      </Collapsible.Trigger>

      <Collapsible.Content
        className={cn(
          'data-[state=closed]:animate-slideUp data-[state=open]:animate-slideDown',
          contentClassName
        )}
      >
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
};
