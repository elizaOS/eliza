import type { AppDetailExtensionProps } from "@elizaos/ui";
import { ClawvilleOperatorSurface } from "./ClawvilleOperatorSurface";

export function ClawvilleDetailExtension({ app }: AppDetailExtensionProps) {
  return <ClawvilleOperatorSurface appName={app.name} variant="detail" />;
}
