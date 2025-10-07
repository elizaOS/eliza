import { baseConfig, testOverrides, standardIgnores } from './eslint.config.base.js';

/**
 * ESLint configuration for ElizaOS frontend packages (React/JSX)
 * Extends the base config with frontend-specific rules
 */
export default [
  ...baseConfig,
  {
    files: ['**/*.{jsx,tsx}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        // DOM globals for React components
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTableElement: 'readonly',
        HTMLTableSectionElement: 'readonly',
        HTMLTableRowElement: 'readonly',
        HTMLTableCellElement: 'readonly',
        HTMLTableCaptionElement: 'readonly',
        Element: 'readonly',
        Document: 'readonly',
        // Event types
        PointerEvent: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        // Canvas and WebGL
        CanvasRenderingContext2D: 'readonly',
        WebGLRenderingContext: 'readonly',
        WebGL2RenderingContext: 'readonly',
        // SVG
        SVGElement: 'readonly',
        SVGSVGElement: 'readonly',
        // Other DOM APIs
        ScrollBehavior: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        // Media APIs
        ImageData: 'readonly',
        DOMRect: 'readonly',
        FileReader: 'readonly',
        // Browser APIs
        navigator: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        React: 'readonly',
      },
    },
    rules: {
      // JSX/TSX specific rules
      'jsx-quotes': ['error', 'prefer-double'],
      'no-undef': 'off', // TypeScript handles this for JSX
    },
  },
  testOverrides,
  {
    ignores: standardIgnores,
  },
];
