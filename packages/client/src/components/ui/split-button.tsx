import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SplitButtonAction {
  label: React.ReactNode;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  variant?: 'default' | 'destructive';
}

export interface SplitButtonProps {
  mainAction: SplitButtonAction;
  actions: SplitButtonAction[];
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'link' | 'destructive';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  disabled?: boolean;
  className?: string;
  mainButtonClassName?: string;
  dropdownButtonClassName?: string;
}

export const SplitButton = React.forwardRef<HTMLDivElement, SplitButtonProps>(
  (
    {
      mainAction,
      actions,
      variant = 'default',
      size = 'default',
      disabled,
      className,
      mainButtonClassName,
      dropdownButtonClassName,
    },
    ref
  ) => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [menuWidth, setMenuWidth] = React.useState<number>();

    React.useImperativeHandle(ref, () => containerRef.current, []);

    React.useLayoutEffect(() => {
      if (containerRef.current) {
        setMenuWidth(containerRef.current.offsetWidth);
      }
    }, [actions.length, mainAction.label]);

    return (
      <div ref={containerRef} className={cn('flex w-full', className)}>
        <Button
          type="button"
          variant={variant}
          size={size}
          onClick={mainAction.onClick}
          disabled={disabled || mainAction.disabled}
          className={cn(
            'rounded-r-none flex-1',
            variant === 'destructive' ? 'border-r border-red-700' : 'border-r-0',
            mainButtonClassName
          )}
        >
          {mainAction.icon && <span className="mr-2">{mainAction.icon}</span>}
          {mainAction.label}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant={variant}
              size={size}
              disabled={disabled}
              className={cn('rounded-l-none px-2 flex-shrink-0', dropdownButtonClassName)}
            >
              <ChevronDown className="h-4 w-4" />
              <span className="sr-only">More options</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" style={{ width: menuWidth }}>
            {actions.map((action, index) => (
              <React.Fragment key={index}>
                <DropdownMenuItem
                  onClick={action.onClick}
                  disabled={action.disabled}
                  className={cn(
                    action.variant === 'destructive' &&
                      'text-destructive focus:text-destructive hover:bg-red-50 dark:hover:bg-red-950/50'
                  )}
                >
                  {action.icon}
                  {action.label}
                </DropdownMenuItem>
                {index < actions.length - 1 && <DropdownMenuSeparator />}
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }
);

SplitButton.displayName = 'SplitButton';
