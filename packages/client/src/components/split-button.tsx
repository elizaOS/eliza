import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface SplitButtonOption {
  label: string;
  description?: string;
  value?: string;
  onClick?: () => void;
}

export interface SplitButtonProps {
  options: SplitButtonOption[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  onClick?: (option: SplitButtonOption, value: string) => void;
  variant?: 'default' | 'destructive';
  className?: string;
  buttonClassName?: string;
  dropdownClassName?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

export default function SplitButton({
  options,
  defaultValue = '0',
  value,
  onValueChange,
  onClick,
  variant = 'default',
  className = '',
  buttonClassName = '',
  dropdownClassName = '',
  disabled = false,
  'aria-label': ariaLabel = 'Options',
}: SplitButtonProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);

  // Use controlled value if provided, otherwise use internal state
  const selectedValue = value !== undefined ? value : internalValue;

  const handleValueChange = (newValue: string) => {
    if (value === undefined) {
      setInternalValue(newValue);
    }
    onValueChange?.(newValue);

    // Find the selected option and call its onClick if it exists
    const selectedOption = options.find(
      (opt) => (opt.value || String(options.indexOf(opt))) === newValue
    );
    if (selectedOption?.onClick) {
      selectedOption.onClick();
    }
  };

  const handleMainButtonClick = () => {
    const selectedOption = options[Number(selectedValue)] || options[0];
    if (selectedOption) {
      // Call the option's specific onClick handler
      selectedOption.onClick?.();
      // Call the general onClick handler
      onClick?.(selectedOption, selectedValue);
    }
  };

  const selectedOption = options[Number(selectedValue)] || options[0];

  if (!options.length) {
    return null;
  }

  // Determine divider classes based on variant
  const dividerClasses =
    variant === 'destructive' ? 'divide-white/20' : 'divide-primary-foreground/30';

  return (
    <div
      className={cn(
        'inline-flex divide-x rounded-md shadow-xs rtl:space-x-reverse',
        dividerClasses,
        className
      )}
    >
      <Button
        className={cn(
          'rounded-none shadow-none first:rounded-s-md last:rounded-e-md focus-visible:z-10',
          buttonClassName
        )}
        variant={variant}
        disabled={disabled}
        onClick={handleMainButtonClick}
      >
        {selectedOption.label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={cn(
              'rounded-none shadow-none first:rounded-s-md last:rounded-e-md focus-visible:z-10',
              buttonClassName
            )}
            variant={variant}
            size="icon"
            aria-label={ariaLabel}
            disabled={disabled}
          >
            <ChevronDownIcon size={16} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={cn('max-w-64 md:max-w-xs', dropdownClassName)}
          side="bottom"
          sideOffset={4}
          align="end"
        >
          <DropdownMenuRadioGroup value={selectedValue} onValueChange={handleValueChange}>
            {options.map((option, index) => (
              <DropdownMenuRadioItem
                key={option.value || option.label}
                value={option.value || String(index)}
                className="items-start [&>span]:pt-1.5"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{option.label}</span>
                  {option.description && (
                    <span className="text-muted-foreground text-xs">{option.description}</span>
                  )}
                </div>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
