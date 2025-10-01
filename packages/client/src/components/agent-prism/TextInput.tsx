import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import {
  useRef,
  type ChangeEvent,
  type ComponentPropsWithRef,
  type ReactNode,
  type RefObject,
} from 'react';

export type TextInputProps = ComponentPropsWithRef<'input'> & {
  /**
   * Callback fired when the input value changes
   */
  onValueChange?: (value: string) => void;

  /**
   * Icon to display at the start of the input
   */
  startIcon?: ReactNode;

  /**
   * Callback fired when the clear button is clicked. If this callback is provided,
   * the clear button will be shown.
   */
  onClear?: () => void;

  /**
   * Ref to the input element
   */
  ref?: RefObject<HTMLInputElement | null>;

  /**
   * Optional className for the input element
   */
  inputClassName?: string;

  /**
   * Unique identifier for the input (required)
   */
  id: string;

  /**
   * Label text for the input
   */
  label?: string;

  /**
   * Whether to visually hide the label while keeping it for screen readers
   * @default false
   */
  hideLabel?: boolean;
};

const iconBaseClassName =
  'absolute top-1/2 -translate-y-1/2 flex items-center justify-center text-foreground';

export const TextInput = ({
  className,
  onChange,
  onValueChange,
  startIcon,
  onClear,
  ref,
  inputClassName,
  label,
  hideLabel = false,
  id,
  ...rest
}: TextInputProps) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange?.(e);
    onValueChange?.(e.target.value);
  };

  const handleClear = () => {
    onClear?.();

    if (ref) {
      ref.current?.focus();
      return;
    }

    inputRef.current?.focus();
  };

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label
          htmlFor={id}
          className={cn('block text-sm font-medium text-foreground ', hideLabel && 'sr-only')}
        >
          {label}
        </label>
      )}
      <div
        className={cn(
          'relative flex w-full items-center justify-center',
          label && !hideLabel && 'mt-1'
        )}
      >
        <input
          id={id}
          ref={ref || inputRef}
          onChange={handleChange}
          className={cn(
            inputClassName,
            'flex h-7 items-center truncate',
            'w-full px-2',
            !!startIcon && 'pl-8',
            !!onClear && 'pr-8',
            'rounded border border-border bg-transparent ',
            'text-foreground placeholder:text-muted-foreground ',
            'hover:border-border dark:hover:border-gray-700'
          )}
          {...rest}
        />
        {startIcon && (
          <div className={cn(iconBaseClassName, 'left-2')} aria-hidden>
            {startIcon}
          </div>
        )}
        {onClear && rest.value && (
          <button
            className={cn(iconBaseClassName, 'right-2')}
            aria-label="Clear input value"
            onClick={handleClear}
            type="button"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
};
