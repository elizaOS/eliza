import { HyperscapeOperatorSurface } from "../surfaces/HyperscapeOperatorSurface";
import type { AppDetailExtensionProps } from "./types";

export function HyperscapeDetailExtension({ app }: AppDetailExtensionProps) {
  return <HyperscapeOperatorSurface appName={app.name} variant="detail" />;
}
