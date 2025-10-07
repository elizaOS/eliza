'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  variant?: 'user' | 'agent';
}

interface CodeBlockCodeProps {
  code: string;
  language?: string;
  className?: string;
  variant?: 'user' | 'agent';
}

interface CodeBlockGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

const CodeBlock = React.forwardRef<HTMLDivElement, CodeBlockProps>(
  ({ className, children, variant = 'agent', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'not-prose relative overflow-hidden rounded-lg border border-border',
          className
        )}
        style={{ backgroundColor: '#0f172a', color: 'white' }}
        {...props}
      >
        {children}
      </div>
    );
  }
);
CodeBlock.displayName = 'CodeBlock';

const CodeBlockGroup = React.forwardRef<HTMLDivElement, CodeBlockGroupProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center justify-between border-b border-border px-4 py-2 text-sm text-muted-foreground bg-muted/30 dark:bg-slate-800/50',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
CodeBlockGroup.displayName = 'CodeBlockGroup';

const CodeBlockCode = React.forwardRef<HTMLDivElement, CodeBlockCodeProps>(
  ({ code, language = 'text', className, variant = 'agent', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('overflow-x-auto p-4', className)}
        style={{ backgroundColor: 'transparent' }}
        {...props}
      >
        <pre className="text-sm whitespace-pre-wrap" style={{ color: 'white' }}>
          <code className="font-mono" style={{ color: 'white' }}>
            {code}
          </code>
        </pre>
      </div>
    );
  }
);
CodeBlockCode.displayName = 'CodeBlockCode';

export { CodeBlock, CodeBlockCode, CodeBlockGroup };
