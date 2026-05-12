/// <reference types="vite/client" />

declare module "*.css";

// Type declarations for modules with .mts type definitions
declare module "@tailwindcss/vite" {
  const tailwindcss: () => any;
  export default tailwindcss;
}
