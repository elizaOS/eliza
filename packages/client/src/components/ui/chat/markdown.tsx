'use client';

import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { CodeBlock, CodeBlockCode } from './code-block';

interface MarkdownProps {
  children: string;
  className?: string;
  components?: Record<string, React.ComponentType<any>>;
  variant?: 'user' | 'agent';
}

const createComponents = (variant: 'user' | 'agent' = 'agent') => ({
  // Code blocks
  pre: ({ children, className, ...props }: any) => {
    // Check if this contains a code element with a language class
    const hasCodeWithLanguage = React.Children.toArray(children).some((child: any) => {
      return (
        React.isValidElement(child) &&
        (child.props as any)?.className &&
        /language-\w+/.test((child.props as any).className)
      );
    });

    if (hasCodeWithLanguage) {
      // Find the code element
      const codeChild = React.Children.toArray(children).find((child: any) => {
        return (
          React.isValidElement(child) &&
          (child.props as any)?.className &&
          /language-\w+/.test((child.props as any).className)
        );
      }) as React.ReactElement;

      const codeClassName = (codeChild.props as any).className || '';
      const languageMatch = codeClassName.match(/language-(\w+)/);
      const language = languageMatch ? languageMatch[1] : 'text';
      const code = String((codeChild.props as any).children || '').trim();

      return (
        <CodeBlock>
          {language && language !== 'text' && (
            <div className="flex items-center justify-between px-4 py-2 text-xs bg-black/30 text-white border-b border-border">
              <span className="font-mono uppercase tracking-wide">{language}</span>
            </div>
          )}
          <CodeBlockCode code={code} language={language} />
        </CodeBlock>
      );
    }

    // Regular pre block (not code)
    return (
      <pre
        className={cn(
          'overflow-x-auto rounded-md bg-black dark:bg-black/50 border border-border p-4 text-sm font-mono text-white dark:text-white',
          className
        )}
        {...props}
      >
        {children}
      </pre>
    );
  },

  // Inline code
  code: ({ className, children, ...props }: any) => {
    // If this has a language class, it's likely part of a code block handled by pre above
    const hasLanguage = className && /language-\w+/.test(className);

    if (hasLanguage) {
      // Let the pre component handle this
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }

    // Regular inline code
    return (
      <code
        className={cn(
          'relative rounded bg-muted/60 dark:bg-slate-800/60 px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold text-foreground dark:text-slate-100 border border-border/50',
          className
        )}
        {...props}
      >
        {children}
      </code>
    );
  },

  // Headers
  h1: ({ className, ...props }: any) => (
    <h1 className={cn('mt-2 scroll-m-20 text-xl font-bold tracking-tight', className)} {...props} />
  ),
  h2: ({ className, ...props }: any) => (
    <h2
      className={cn('mt-2 scroll-m-20 text-lg font-semibold tracking-tight', className)}
      {...props}
    />
  ),
  h3: ({ className, ...props }: any) => (
    <h3
      className={cn('mt-2 scroll-m-20 text-base font-semibold tracking-tight', className)}
      {...props}
    />
  ),
  h4: ({ className, ...props }: any) => (
    <h4
      className={cn('mt-2 scroll-m-20 text-sm font-semibold tracking-tight', className)}
      {...props}
    />
  ),

  // Paragraphs
  p: ({ className, ...props }: any) => <p className={cn('leading-7', className)} {...props} />,

  // Lists
  ul: ({ className, ...props }: any) => (
    <ul className={cn('my-2 ml-6 list-disc [&>li]:mt-1', className)} {...props} />
  ),
  ol: ({ className, ...props }: any) => (
    <ol className={cn('my-2 ml-6 list-decimal [&>li]:mt-1', className)} {...props} />
  ),

  // Links
  a: ({ className, ...props }: any) => (
    <a
      className={cn('font-medium text-primary underline underline-offset-4', className)}
      {...props}
    />
  ),

  // Blockquotes
  blockquote: ({ className, ...props }: any) => (
    <blockquote
      className={cn('mt-2 border-l-2 border-muted-foreground/20 pl-6 italic', className)}
      {...props}
    />
  ),

  // Tables
  table: ({ className, ...props }: any) => (
    <div className="my-2 w-full overflow-y-auto">
      <table className={cn('w-full', className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }: any) => (
    <th
      className={cn(
        'border border-muted-foreground/20 px-4 py-2 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right',
        className
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }: any) => (
    <td
      className={cn(
        'border border-muted-foreground/20 px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right',
        className
      )}
      {...props}
    />
  ),

  // Images
  img: ({ className, alt, ...props }: any) => (
    <img className={cn('rounded-md', className)} alt={alt} {...props} />
  ),

  // Horizontal rule
  hr: ({ ...props }: any) => <hr className="my-4 border-muted-foreground/20" {...props} />,

  // Strong/Bold
  strong: ({ className, ...props }: any) => (
    <strong className={cn('font-semibold', className)} {...props} />
  ),

  // Emphasis/Italic
  em: ({ className, ...props }: any) => <em className={cn('italic', className)} {...props} />,
});

const Markdown = React.memo<MarkdownProps>(
  ({ children, className, components, variant = 'agent', ...props }) => {
    const defaultComponents = React.useMemo(() => createComponents(variant), [variant]);
    const mergedComponents = React.useMemo(
      () => ({ ...defaultComponents, ...components }),
      [defaultComponents, components]
    );

    return (
      <div className={cn('markdown-content', className)} {...props}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mergedComponents}>
          {children}
        </ReactMarkdown>
      </div>
    );
  }
);

Markdown.displayName = 'Markdown';

export { Markdown, type MarkdownProps };
