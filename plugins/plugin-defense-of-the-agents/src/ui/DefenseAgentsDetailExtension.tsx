import type { AppDetailExtensionProps } from "@elizaos/app-core/ui-compat";
import { DefenseAgentsOperatorSurface } from "./DefenseAgentsOperatorSurface";

export function DefenseAgentsDetailExtension({ app }: AppDetailExtensionProps) {
  return <DefenseAgentsOperatorSurface appName={app.name} variant="detail" />;
}
