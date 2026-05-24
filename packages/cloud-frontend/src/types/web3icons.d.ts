/**
 * Ambient declarations for @web3icons/react deep subpath imports.
 *
 * The package uses wildcard `exports` in its package.json
 * (`"./icons/networks/*"`, `"./icons/tokens/*"`) which TypeScript 6 +
 * `moduleResolution: "Bundler"` doesn't resolve reliably. Vite/Rolldown
 * handles the runtime resolution fine; this file silences the type errors.
 */

declare module "@web3icons/react/icons/networks/NetworkBase" {
  import type { ComponentType, SVGProps } from "react";
  const NetworkBase: ComponentType<SVGProps<SVGSVGElement> & { variant?: string; size?: number | string }>;
  export default NetworkBase;
}

declare module "@web3icons/react/icons/networks/NetworkBinanceSmartChain" {
  import type { ComponentType, SVGProps } from "react";
  const NetworkBinanceSmartChain: ComponentType<SVGProps<SVGSVGElement> & { variant?: string; size?: number | string }>;
  export default NetworkBinanceSmartChain;
}

declare module "@web3icons/react/icons/networks/NetworkEthereum" {
  import type { ComponentType, SVGProps } from "react";
  const NetworkEthereum: ComponentType<SVGProps<SVGSVGElement> & { variant?: string; size?: number | string }>;
  export default NetworkEthereum;
}

declare module "@web3icons/react/icons/tokens/TokenSOL" {
  import type { ComponentType, SVGProps } from "react";
  const TokenSOL: ComponentType<SVGProps<SVGSVGElement> & { variant?: string; size?: number | string }>;
  export default TokenSOL;
}
