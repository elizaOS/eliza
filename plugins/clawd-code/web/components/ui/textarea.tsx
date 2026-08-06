'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  helper?: string
  maxCount?: number
  autoGrow?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, helper, maxCount, autoGrow = false, id, onChange, value, ...props }, ref) => {
    const textareaId = id ?? React.useId()
    const errorId = `${textareaId}-error`
    const helperId = `${textareaId}-helper`
    const internalRef = React.useRef<HTMLTextAreaElement>(null)
    const resolvedRef = (ref as React.RefObject<HTMLTextAreaElement>) ?? internalRef

    const [charCount, setCharCount] = React.useState(
      typeof value === 'string' ? value.length : 0
    )

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setCharCount(e.target.value.length)
      if (autoGrow && resolvedRef.current) {
        resolvedRef.current.style.height = 'auto'
        resolvedRef.current.style.height = `${resolvedRef.current.scrollHeight}px`
      }
      onChange?.(e)
    }

    React.useEffect(() => {
      if (autoGrow && resolvedRef.current) {
        resolvedRef.current.style.height = 'auto'
        resolvedRef.current.style.height = `${resolvedRef.current.scrollHeight}px`
      }
    }, [value, autoGrow, resolvedRef])

    const describedBy = [error ? errorId : null, helper ? helperId : null]
      .filter(Boolean)
      .join(' ')

    const isOverLimit = maxCount !== undefined && charCount > maxCount

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={textareaId} className="text-sm font-medium text-surface-200">
            {label}
          </label>
        )}
        <textarea
          id={textareaId}
          ref={resolvedRef}
          value={value}
          onChange={handleChange}
          aria-describedby={describedBy || undefined}
          aria-invalid={error ? true : undefined}
          className={cn(
            'flex min-h-[80px] w-full rounded-md border bg-surface-900 px-3 py-2 text-sm text-surface-100',
            'border-surface-700 placeholder:text-surface-500',
            'transition-colors duration-[var(--transition-fast)] resize-none',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:border-transparent',
            'disabled:cursor-not-allowed disabled:opacity-50',
            autoGrow && 'overflow-hidden',
            error && 'border-red-500 focus-visible:ring-red-500',
            className
          )}
          {...props}
        />
        <div className="flex items-start justify-between gap-2">
          <div>
            {error && (
              <p id={errorId} className="text-xs text-red-400" role="alert">
                {error}
              </p>
            )}
            {helper && !error && (
              <p id={helperId} className="text-xs text-surface-500">
                {helper}
              </p>
            )}
          </div>
          {maxCount !== undefined && (
            <span
              className={cn(
                'text-xs tabular-nums ml-auto flex-shrink-0',
                isOverLimit ? 'text-red-400' : 'text-surface-500'
              )}
              aria-live="polite"
            >
              {charCount}/{maxCount}
            </span>
          )}
        </div>
      </div>
    )
  }
)
Textarea.displayName = 'Textarea'

export { Textarea }
