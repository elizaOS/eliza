import type { CSSProperties } from 'react'
import { inkColorToCSS } from './color-mapping'

// ---------------------------------------------------------------------------
// Dimension helpers
// ---------------------------------------------------------------------------

/**
 * Convert an Ink dimension (number = character cells, or `"50%"` percent string)
 * to a CSS value.  We use `ch` for character-width units so the layout
 * approximates the terminal in a monospace font.
 */
function toCSSSize(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value // already "50%" etc.
  return `${value}ch`
}

// ---------------------------------------------------------------------------
// Border style mapping
// ---------------------------------------------------------------------------

// Maps Ink/cli-boxes border style names to CSS border-style values.
const BORDER_STYLE_MAP: Record<string, CSSProperties['borderStyle']> = {
  single: 'solid',
  double: 'double',
  round: 'solid',     // approximated; borderRadius added below
  bold: 'solid',
  singleDouble: 'solid',
  doubleSingle: 'solid',
  classic: 'solid',
  arrow: 'solid',
  ascii: 'solid',
  dashed: 'dashed',
  // cli-boxes names
  none: 'none',
}

const BORDER_BOLD_STYLES = new Set(['bold'])
const BORDER_ROUND_STYLES = new Set(['round'])

// ---------------------------------------------------------------------------
// Main mapping function
// ---------------------------------------------------------------------------

export type InkStyleProps = {
  // Position
  position?: 'absolute' | 'relative'
  top?: number | string
  bottom?: number | string
  left?: number | string
  right?: number | string

  // Margin
  margin?: number
  marginX?: number
  marginY?: number
  marginTop?: number
  marginBottom?: number
  marginLeft?: number
  marginRight?: number

  // Padding
  padding?: number
  paddingX?: number
  paddingY?: number
  paddingTop?: number
  paddingBottom?: number
  paddingLeft?: number
  paddingRight?: number

  // Flex
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
  flexGrow?: number
  flexShrink?: number
  flexBasis?: number | string
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse'
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'
  alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'auto'
  justifyContent?: 'flex-start' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly' | 'center'

  // Gap
  gap?: number
  columnGap?: number
  rowGap?: number

  // Sizing
  width?: number | string
  height?: number | string
  minWidth?: number | string
  minHeight?: number | string
  maxWidth?: number | string
  maxHeight?: number | string

  // Display
  display?: 'flex' | 'none'

  // Overflow (Ink only has 'hidden')
  overflow?: 'hidden' | 'visible'
  overflowX?: 'hidden' | 'visible'
  overflowY?: 'hidden' | 'visible'

  // Border
  borderStyle?: string | { top: string; bottom: string; left: string; right: string; topLeft: string; topRight: string; bottomLeft: string; bottomRight: string }
  borderTop?: boolean
  borderBottom?: boolean
  borderLeft?: boolean
  borderRight?: boolean
  borderColor?: string
  borderTopColor?: string
  borderBottomColor?: string
  borderLeftColor?: string
  borderRightColor?: string
  borderDimColor?: boolean
  borderTopDimColor?: boolean
  borderBottomDimColor?: boolean
  borderLeftDimColor?: boolean
  borderRightDimColor?: boolean
}

export type InkTextStyleProps = {
  color?: string
  backgroundColor?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
  wrap?: string
}

/**
 * Convert Ink Box layout props to a React CSSProperties object.
 */
export function inkBoxPropsToCSS(props: InkStyleProps): CSSProperties {
  const css: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
  }

  // Display
  if (props.display === 'none') {
    css.display = 'none'
    return css
  }

  // Position
  if (props.position) css.position = props.position
  if (props.top !== undefined) css.top = toCSSSize(props.top)
  if (props.bottom !== undefined) css.bottom = toCSSSize(props.bottom)
  if (props.left !== undefined) css.left = toCSSSize(props.left)
  if (props.right !== undefined) css.right = toCSSSize(props.right)

  // Flex
  if (props.flexDirection) css.flexDirection = props.flexDirection
  if (props.flexGrow !== undefined) css.flexGrow = props.flexGrow
  if (props.flexShrink !== undefined) css.flexShrink = props.flexShrink
  if (props.flexBasis !== undefined) css.flexBasis = toCSSSize(props.flexBasis)
  if (props.flexWrap) css.flexWrap = props.flexWrap
  if (props.alignItems) css.alignItems = props.alignItems
  if (props.alignSelf) css.alignSelf = props.alignSelf
  if (props.justifyContent) css.justifyContent = props.justifyContent

  // Gap
  if (props.gap !== undefined) css.gap = `${props.gap}ch`
  if (props.columnGap !== undefined) css.columnGap = `${props.columnGap}ch`
  if (props.rowGap !== undefined) css.rowGap = `${props.rowGap}ch`

  // Sizing
  if (props.width !== undefined) css.width = toCSSSize(props.width)
  if (props.height !== undefined) css.height = toCSSSize(props.height)
  if (props.minWidth !== undefined) css.minWidth = toCSSSize(props.minWidth)
  if (props.minHeight !== undefined) css.minHeight = toCSSSize(props.minHeight)
  if (props.maxWidth !== undefined) css.maxWidth = toCSSSize(props.maxWidth)
  if (props.maxHeight !== undefined) css.maxHeight = toCSSSize(props.maxHeight)

  // Margin (shorthand resolution: margin → marginX/Y → individual sides)
  const mt = props.marginTop ?? props.marginY ?? props.margin
  const mb = props.marginBottom ?? props.marginY ?? props.margin
  const ml = props.marginLeft ?? props.marginX ?? props.margin
  const mr = props.marginRight ?? props.marginX ?? props.margin
  if (mt !== undefined) css.marginTop = toCSSSize(mt)
  if (mb !== undefined) css.marginBottom = toCSSSize(mb)
  if (ml !== undefined) css.marginLeft = toCSSSize(ml)
  if (mr !== undefined) css.marginRight = toCSSSize(mr)

  // Padding
  const pt = props.paddingTop ?? props.paddingY ?? props.padding
  const pb = props.paddingBottom ?? props.paddingY ?? props.padding
  const pl = props.paddingLeft ?? props.paddingX ?? props.padding
  const pr = props.paddingRight ?? props.paddingX ?? props.padding
  if (pt !== undefined) css.paddingTop = toCSSSize(pt)
  if (pb !== undefined) css.paddingBottom = toCSSSize(pb)
  if (pl !== undefined) css.paddingLeft = toCSSSize(pl)
  if (pr !== undefined) css.paddingRight = toCSSSize(pr)

  // Overflow
  if (props.overflow) css.overflow = props.overflow
  if (props.overflowX) css.overflowX = props.overflowX
  if (props.overflowY) css.overflowY = props.overflowY

  // Border
  if (props.borderStyle) {
    const styleName = typeof props.borderStyle === 'string' ? props.borderStyle : 'single'
    const cssBorderStyle = BORDER_STYLE_MAP[styleName] ?? 'solid'
    const isBold = BORDER_BOLD_STYLES.has(styleName)
    const borderWidth = isBold ? '2px' : '1px'

    const showTop = props.borderTop !== false
    const showBottom = props.borderBottom !== false
    const showLeft = props.borderLeft !== false
    const showRight = props.borderRight !== false

    const resolveColor = (side: string | undefined, fallback: string | undefined, dim: boolean | undefined) => {
      const raw = side ?? fallback
      const cssColor = inkColorToCSS(raw) ?? 'currentColor'
      return dim ? `color-mix(in srgb, ${cssColor} 60%, transparent)` : cssColor
    }

    const dimAll = props.borderDimColor

    if (showTop) {
      css.borderTopStyle = cssBorderStyle
      css.borderTopWidth = borderWidth
      css.borderTopColor = resolveColor(
        props.borderTopColor ?? props.borderColor,
        props.borderColor,
        props.borderTopDimColor ?? dimAll,
      )
    }
    if (showBottom) {
      css.borderBottomStyle = cssBorderStyle
      css.borderBottomWidth = borderWidth
      css.borderBottomColor = resolveColor(
        props.borderBottomColor ?? props.borderColor,
        props.borderColor,
        props.borderBottomDimColor ?? dimAll,
      )
    }
    if (showLeft) {
      css.borderLeftStyle = cssBorderStyle
      css.borderLeftWidth = borderWidth
      css.borderLeftColor = resolveColor(
        props.borderLeftColor ?? props.borderColor,
        props.borderColor,
        props.borderLeftDimColor ?? dimAll,
      )
    }
    if (showRight) {
      css.borderRightStyle = cssBorderStyle
      css.borderRightWidth = borderWidth
      css.borderRightColor = resolveColor(
        props.borderRightColor ?? props.borderColor,
        props.borderColor,
        props.borderRightDimColor ?? dimAll,
      )
    }

    if (BORDER_ROUND_STYLES.has(styleName)) {
      css.borderRadius = '4px'
    }
  }

  return css
}

/**
 * Convert Ink Text style props to a React CSSProperties object.
 */
export function inkTextPropsToCSS(props: InkTextStyleProps): CSSProperties {
  const css: CSSProperties = {}

  const fg = inkColorToCSS(props.color)
  const bg = inkColorToCSS(props.backgroundColor)

  if (props.inverse) {
    // Swap foreground and background
    if (fg) css.backgroundColor = fg
    if (bg) css.color = bg
    if (!fg) css.filter = 'invert(1)'
  } else {
    if (fg) css.color = fg
    if (bg) css.backgroundColor = bg
  }

  if (props.bold) css.fontWeight = 'bold'
  if (props.dim) css.opacity = 0.6
  if (props.italic) css.fontStyle = 'italic'

  const decorations: string[] = []
  if (props.underline) decorations.push('underline')
  if (props.strikethrough) decorations.push('line-through')
  if (decorations.length > 0) css.textDecoration = decorations.join(' ')

  if (props.wrap) {
    switch (props.wrap) {
      case 'wrap':
      case 'wrap-trim':
        css.whiteSpace = 'pre-wrap'
        css.overflowWrap = 'anywhere'
        break
      case 'truncate':
      case 'truncate-end':
      case 'end':
        css.overflow = 'hidden'
        css.textOverflow = 'ellipsis'
        css.whiteSpace = 'nowrap'
        break
      case 'truncate-middle':
      case 'middle':
        // CSS can't do mid-truncation; use ellipsis as fallback
        css.overflow = 'hidden'
        css.textOverflow = 'ellipsis'
        css.whiteSpace = 'nowrap'
        break
      case 'truncate-start':
        css.overflow = 'hidden'
        css.direction = 'rtl'
        css.textOverflow = 'ellipsis'
        css.whiteSpace = 'nowrap'
        break
    }
  }

  return css
}
