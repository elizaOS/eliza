import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const avatarVariants = cva(
  'relative inline-flex items-center justify-center rounded-full overflow-hidden font-medium select-none flex-shrink-0',
  {
    variants: {
      size: {
        xs: 'h-6 w-6 text-[10px]',
        sm: 'h-8 w-8 text-xs',
        md: 'h-10 w-10 text-sm',
        lg: 'h-12 w-12 text-base',
        xl: 'h-16 w-16 text-lg',
      },
    },
    defaultVariants: { size: 'md' },
  }
)

export interface AvatarProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof avatarVariants> {
  src?: string
  alt?: string
  name?: string
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0].toUpperCase())
    .join('')
}

// Deterministic colour from name
function getAvatarColor(name: string): string {
  const colours = [
    'bg-brand-700 text-brand-200',
    'bg-violet-800 text-violet-200',
    'bg-indigo-800 text-indigo-200',
    'bg-blue-800 text-blue-200',
    'bg-cyan-800 text-cyan-200',
    'bg-teal-800 text-teal-200',
    'bg-emerald-800 text-emerald-200',
    'bg-amber-800 text-amber-200',
    'bg-rose-800 text-rose-200',
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff
  }
  return colours[Math.abs(hash) % colours.length]
}

function Avatar({ className, size, src, alt, name, ...props }: AvatarProps) {
  const [imgError, setImgError] = React.useState(false)
  const showImage = src && !imgError
  const initials = name ? getInitials(name) : '?'
  const colorClass = name ? getAvatarColor(name) : 'bg-surface-700 text-surface-300'

  return (
    <span className={cn(avatarVariants({ size, className }))} {...props}>
      {showImage ? (
        <img
          src={src}
          alt={alt ?? name ?? 'Avatar'}
          className="h-full w-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        <span className={cn('flex h-full w-full items-center justify-center', colorClass)} aria-label={name}>
          {initials}
        </span>
      )}
    </span>
  )
}

export { Avatar, avatarVariants }
