import type { AppDetailExtensionProps } from "@elizaos/app-core";
import { DefenseAgentsOperatorSurface } from "./DefenseAgentsOperatorSurface";

export function DefenseAgentsDetailExtension({ app }: AppDetailExtensionProps) {
  return <DefenseAgentsOperatorSurface appName={app.name} variant="detail" />;
}
