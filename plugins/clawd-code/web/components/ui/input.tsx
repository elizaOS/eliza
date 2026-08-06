'use client'

import * as React from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  helper?: string
  variant?: 'default' | 'search'
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, helper, variant = 'default', id, ...props }, ref) => {
    const inputId = id ?? React.useId()
    const errorId = `${inputId}-error`
    const helperId = `${inputId}-helper`

    const describedBy = [
      error ? errorId : null,
      helper ? helperId : null,
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-surface-200"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {variant === 'search' && (
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-500 pointer-events-none"
              size={15}
              aria-hidden="true"
            />
          )}
          <input
            id={inputId}
            ref={ref}
            aria-describedby={describedBy || undefined}
            aria-invalid={error ? true : undefined}
            className={cn(
              'flex h-9 w-full rounded-md border bg-surface-900 px-3 py-1 text-sm text-surface-100',
              'border-surface-700 placeholder:text-surface-500',
              'transition-colors duration-[var(--transition-fast)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:border-transparent',
              'disabled:cursor-not-allowed disabled:opacity-50',
              variant === 'search' && 'pl-9',
              error && 'border-red-500 focus-visible:ring-red-500',
              className
            )}
            {...props}
          />
        </div>
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
    )
  }
)
Input.displayName = 'Input'

export { Input }
