import type { AppDetailExtensionProps } from "@elizaos/app-core/components/apps/extensions/types";
import { ClawvilleOperatorSurface } from "./ClawvilleOperatorSurface";

export function ClawvilleDetailExtension({ app }: AppDetailExtensionProps) {
  return <ClawvilleOperatorSurface appName={app.name} variant="detail" />;
}
