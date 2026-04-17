import { HyperscapeOperatorSurface } from "./HyperscapeOperatorSurface";
import type { AppDetailExtensionProps } from "@elizaos/app-core/components/apps/extensions/types";

export function HyperscapeDetailExtension({ app }: AppDetailExtensionProps) {
  return <HyperscapeOperatorSurface appName={app.name} variant="detail" />;
}
