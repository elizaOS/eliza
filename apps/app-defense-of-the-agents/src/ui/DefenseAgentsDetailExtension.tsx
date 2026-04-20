import { DefenseAgentsOperatorSurface } from "./DefenseAgentsOperatorSurface";
import type { AppDetailExtensionProps } from "@elizaos/app-core/components/apps/extensions/types";

export function DefenseAgentsDetailExtension({ app }: AppDetailExtensionProps) {
  return <DefenseAgentsOperatorSurface appName={app.name} variant="detail" />;
}
