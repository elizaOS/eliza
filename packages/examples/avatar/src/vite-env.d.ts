/// <reference types="vite/client" />

// Type declaration for @vitejs/plugin-react
declare module "@vitejs/plugin-react" {
  import type { Plugin } from "vite";
  export default function react(options?: any): Plugin;
}
