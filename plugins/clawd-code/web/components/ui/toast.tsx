'use client'

import * as React from 'react'
import * as RadixToast from '@radix-ui/react-toast'
import { X, CheckCircle2, AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

export type ToastVariant = 'default' | 'success' | 'error' | 'warning' | 'info'

export interface ToastData {
  id: string
  title: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

// ── Store (singleton for imperative toasts) ───────────────────────────────────

type Listener = (toasts: ToastData[]) => void

let toastList: ToastData[] = []
const listeners = new Set<Listener>()

function emit() {
  listeners.forEach((fn) => fn([...toastList]))
}

export const toast = {
  show(data: Omit<ToastData, 'id'>) {
    const id = Math.random().toString(36).slice(2, 9)
    toastList = [...toastList, { id, ...data }]
    emit()
    return id
  },
  success(title: string, description?: string) {
    return this.show({ title, description, variant: 'success' })
  },
  error(title: string, description?: string) {
    return this.show({ title, description, variant: 'error' })
  },
  warning(title: string, description?: string) {
    return this.show({ title, description, variant: 'warning' })
  },
  info(title: string, description?: string) {
    return this.show({ title, description, variant: 'info' })
  },
  dismiss(id: string) {
    toastList = toastList.filter((t) => t.id !== id)
    emit()
  },
}

function useToastStore() {
  const [toasts, setToasts] = React.useState<ToastData[]>([])
  React.useEffect(() => {
    setToasts([...toastList])
    listeners.add(setToasts)
    return () => { listeners.delete(setToasts) }
  }, [])
  return toasts
}

// ── Style variants ────────────────────────────────────────────────────────────

const toastVariants = cva(
  [
    'group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden',
    'rounded-lg border p-4 shadow-lg transition-all',
    'data-[state=open]:animate-slide-up data-[state=closed]:animate-slide-down-out',
    'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]',
    'data-[swipe=cancel]:translate-x-0',
    'data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=end]:animate-fade-out',
  ].join(' '),
  {
    variants: {
      variant: {
        default: 'bg-surface-800 border-surface-700 text-surface-100',
        success: 'bg-surface-800 border-green-800/60 text-surface-100',
        error: 'bg-surface-800 border-red-800/60 text-surface-100',
        warning: 'bg-surface-800 border-yellow-800/60 text-surface-100',
        info: 'bg-surface-800 border-blue-800/60 text-surface-100',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

const variantIcons: Record<ToastVariant, React.ReactNode> = {
  default: null,
  success: <CheckCircle2 className="h-4 w-4 text-green-400 flex-shrink-0 mt-0.5" aria-hidden="true" />,
  error: <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" aria-hidden="true" />,
  warning: <AlertTriangle className="h-4 w-4 text-yellow-400 flex-shrink-0 mt-0.5" aria-hidden="true" />,
  info: <Info className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5" aria-hidden="true" />,
}

// ── Single toast item ─────────────────────────────────────────────────────────

interface ToastItemProps extends VariantProps<typeof toastVariants> {
  id: string
  title: string
  description?: string
  duration?: number
}

function ToastItem({ id, title, description, variant = 'default', duration = 5000 }: ToastItemProps) {
  const [open, setOpen] = React.useState(true)
  const icon = variantIcons[variant ?? 'default']

  return (
    <RadixToast.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setTimeout(() => toast.dismiss(id), 300)
      }}
      duration={duration}
      className={cn(toastVariants({ variant }))}
    >
      {icon}
      <div className="flex-1 min-w-0">
        <RadixToast.Title className="text-sm font-medium leading-snug">{title}</RadixToast.Title>
        {description && (
          <RadixToast.Description className="mt-0.5 text-xs text-surface-400 leading-relaxed">
            {description}
          </RadixToast.Description>
        )}
      </div>
      <RadixToast.Close
        className="flex-shrink-0 text-surface-500 hover:text-surface-200 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Dismiss notification"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </RadixToast.Close>
      {/* Progress bar */}
      <div
        className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-current opacity-20"
        style={{ animation: `progress ${duration}ms linear forwards` }}
        aria-hidden="true"
      />
    </RadixToast.Root>
  )
}

// ── Provider (mount once in layout) ──────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const toasts = useToastStore()

  return (
    <RadixToast.Provider swipeDirection="right">
      {children}
      {toasts.map((t) => (
        <ToastItem key={t.id} {...t} />
      ))}
      <RadixToast.Viewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 focus:outline-none" />
    </RadixToast.Provider>
  )
}

// ── Hook (alternative to imperative API) ─────────────────────────────────────

export function useToast() {
  return toast
}
