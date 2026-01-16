/// <reference types="vite/client" />

// Type declarations for modules with .mts type definitions
declare module "@tailwindcss/vite" {
  const tailwindcss: () => any;
  export default tailwindcss;
}
