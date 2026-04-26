import type { AppDetailExtensionProps } from "@elizaos/app-core";
import { HyperscapeOperatorSurface } from "./HyperscapeOperatorSurface";

export function HyperscapeDetailExtension({ app }: AppDetailExtensionProps) {
  return <HyperscapeOperatorSurface appName={app.name} variant="detail" />;
}
