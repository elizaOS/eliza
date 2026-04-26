import type { AppDetailExtensionProps } from "@elizaos/app-core";
import { ClawvilleOperatorSurface } from "./ClawvilleOperatorSurface";

export function ClawvilleDetailExtension({ app }: AppDetailExtensionProps) {
  return <ClawvilleOperatorSurface appName={app.name} variant="detail" />;
}
