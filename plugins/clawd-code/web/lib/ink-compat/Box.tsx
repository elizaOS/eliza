import React, { type CSSProperties, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent, type PropsWithChildren, type Ref } from 'react'
import { inkBoxPropsToCSS, type InkStyleProps } from './prop-mapping'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Web-compat event shims that mirror the Ink event interface.
 * Components that only inspect `.stopImmediatePropagation()` or basic
 * event info will work without changes.
 */
export type WebClickEvent = {
  x: number
  y: number
  button: 'left' | 'right' | 'middle'
  stopImmediatePropagation(): void
}

export type WebFocusEvent = {
  stopImmediatePropagation(): void
}

export type WebKeyboardEvent = {
  key: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  stopImmediatePropagation(): void
}

export type BoxProps = PropsWithChildren<
  InkStyleProps & {
    ref?: Ref<HTMLDivElement>
    tabIndex?: number
    autoFocus?: boolean
    /** onClick receives a shim that mirrors the Ink ClickEvent interface. */
    onClick?: (event: WebClickEvent) => void
    onFocus?: (event: WebFocusEvent) => void
    onFocusCapture?: (event: WebFocusEvent) => void
    onBlur?: (event: WebFocusEvent) => void
    onBlurCapture?: (event: WebFocusEvent) => void
    onKeyDown?: (event: WebKeyboardEvent) => void
    onKeyDownCapture?: (event: WebKeyboardEvent) => void
    onMouseEnter?: () => void
    onMouseLeave?: () => void
    /** Pass-through className for web-specific styling. */
    className?: string
    /** Pass-through inline style overrides applied on top of Ink-mapped styles. */
    style?: CSSProperties
  }
>

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function adaptClickEvent(e: MouseEvent<HTMLDivElement>): WebClickEvent {
  let stopped = false
  const shim: WebClickEvent = {
    x: e.clientX,
    y: e.clientY,
    button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
    stopImmediatePropagation() {
      if (!stopped) {
        stopped = true
        e.stopPropagation()
      }
    },
  }
  return shim
}

function adaptFocusEvent(e: React.FocusEvent<HTMLDivElement>): WebFocusEvent {
  return {
    stopImmediatePropagation() {
      e.stopPropagation()
    },
  }
}

function adaptKeyboardEvent(e: ReactKeyboardEvent<HTMLDivElement>): WebKeyboardEvent {
  return {
    key: e.key,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    meta: e.metaKey || e.altKey,
    stopImmediatePropagation() {
      e.stopPropagation()
    },
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Web-compat `<Box>` — renders as a `<div>` with `display: flex` and maps
 * all Ink layout props to CSS.  Drop-in replacement for Ink's `<Box>`.
 */
export const Box = React.forwardRef<HTMLDivElement, BoxProps>(function Box(
  {
    children,
    className,
    style: styleProp,
    tabIndex,
    autoFocus,
    onClick,
    onFocus,
    onFocusCapture,
    onBlur,
    onBlurCapture,
    onKeyDown,
    onKeyDownCapture,
    onMouseEnter,
    onMouseLeave,
    // Ink style props — everything else
    ...inkProps
  },
  ref,
) {
  const inkCSS = inkBoxPropsToCSS(inkProps)
  const mergedStyle: CSSProperties = { ...inkCSS, ...styleProp }

  return (
    <div
      ref={ref}
      className={className}
      style={mergedStyle}
      tabIndex={tabIndex}
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={autoFocus}
      onClick={onClick ? (e) => onClick(adaptClickEvent(e)) : undefined}
      onFocus={onFocus ? (e) => onFocus(adaptFocusEvent(e)) : undefined}
      onFocusCapture={onFocusCapture ? (e) => onFocusCapture(adaptFocusEvent(e)) : undefined}
      onBlur={onBlur ? (e) => onBlur(adaptFocusEvent(e)) : undefined}
      onBlurCapture={onBlurCapture ? (e) => onBlurCapture(adaptFocusEvent(e)) : undefined}
      onKeyDown={onKeyDown ? (e) => onKeyDown(adaptKeyboardEvent(e)) : undefined}
      onKeyDownCapture={onKeyDownCapture ? (e) => onKeyDownCapture(adaptKeyboardEvent(e)) : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  )
})

Box.displayName = 'Box'

export default Box
