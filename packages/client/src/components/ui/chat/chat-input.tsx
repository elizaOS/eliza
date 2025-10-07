import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import * as React from 'react';

interface ChatInputProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const MAX_HEIGHT = 160;

const ChatInput = React.forwardRef<HTMLTextAreaElement, ChatInputProps>(
  ({ className, ...props }, ref) => {
    const internalRef = React.useRef<HTMLTextAreaElement | null>(null);

    const combinedRef = (node: HTMLTextAreaElement) => {
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
      internalRef.current = node;
    };

    const resizeTextarea = () => {
      const textarea = internalRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, MAX_HEIGHT) + 'px';
      }
    };

    React.useEffect(() => {
      resizeTextarea();
    }, [props.value]);

    return (
      <Textarea
        autoComplete="off"
        ref={combinedRef}
        name="message"
        className={cn(
          'px-4 py-3 bg-background text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring disabled:cursor-not-allowed disabled:opacity-50 w-full rounded-md flex items-center h-16 resize-none',
          className
        )}
        {...props}
      />
    );
  }
);
ChatInput.displayName = 'ChatInput';

export { ChatInput };
