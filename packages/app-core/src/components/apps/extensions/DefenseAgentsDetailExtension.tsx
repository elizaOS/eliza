import { DefenseAgentsOperatorSurface } from "../surfaces/DefenseAgentsOperatorSurface";
import type { AppDetailExtensionProps } from "./types";

export function DefenseAgentsDetailExtension({ app }: AppDetailExtensionProps) {
  return <DefenseAgentsOperatorSurface appName={app.name} variant="detail" />;
}
