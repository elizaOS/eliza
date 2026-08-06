/**
 * Maps Ink/ANSI color values to CSS color strings.
 *
 * Ink Color types:
 *   RGBColor   = `rgb(${number},${number},${number})`
 *   HexColor   = `#${string}`
 *   Ansi256Color = `ansi256(${number})`
 *   AnsiColor  = `ansi:black` | `ansi:red` | ...
 */

// Standard ANSI 16-color palette mapped to CSS hex values
const ANSI_COLORS: Record<string, string> = {
  black: '#000000',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#c4a000',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#06989a',
  white: '#d3d7cf',
  blackBright: '#555753',
  redBright: '#ef2929',
  greenBright: '#8ae234',
  yellowBright: '#fce94f',
  blueBright: '#729fcf',
  magentaBright: '#ad7fa8',
  cyanBright: '#34e2e2',
  whiteBright: '#eeeeec',
}

/**
 * Convert an index in the xterm 256-color palette to a CSS hex color string.
 */
function ansi256ToHex(index: number): string {
  // 0–15: standard palette
  if (index < 16) {
    const names = [
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'blackBright', 'redBright', 'greenBright', 'yellowBright',
      'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
    ]
    return ANSI_COLORS[names[index]!] ?? '#000000'
  }

  // 232–255: grayscale ramp
  if (index >= 232) {
    const level = (index - 232) * 10 + 8
    const hex = level.toString(16).padStart(2, '0')
    return `#${hex}${hex}${hex}`
  }

  // 16–231: 6×6×6 color cube
  const i = index - 16
  const b = i % 6
  const g = Math.floor(i / 6) % 6
  const r = Math.floor(i / 36)
  const toChannel = (v: number) => (v === 0 ? 0 : v * 40 + 55)
  const rh = toChannel(r).toString(16).padStart(2, '0')
  const gh = toChannel(g).toString(16).padStart(2, '0')
  const bh = toChannel(b).toString(16).padStart(2, '0')
  return `#${rh}${gh}${bh}`
}

/**
 * Convert an Ink Color string (or theme-resolved raw color) to a CSS color string.
 * Returns `undefined` if `color` is undefined/empty.
 */
export function inkColorToCSS(color: string | undefined): string | undefined {
  if (!color) return undefined

  // Pass through hex colors
  if (color.startsWith('#')) return color

  // Normalise `rgb(r,g,b)` → `rgb(r, g, b)` (browsers accept both, but clean)
  if (color.startsWith('rgb(')) {
    return color.replace(/\s+/g, '')
  }

  // ansi256(N)
  const ansi256Match = color.match(/^ansi256\((\d+)\)$/)
  if (ansi256Match) {
    return ansi256ToHex(parseInt(ansi256Match[1]!, 10))
  }

  // ansi:name
  if (color.startsWith('ansi:')) {
    const name = color.slice(5)
    return ANSI_COLORS[name] ?? color
  }

  // Unknown format — return as-is (browser may understand it)
  return color
}
