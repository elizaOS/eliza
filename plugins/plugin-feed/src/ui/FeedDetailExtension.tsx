import type { AppDetailExtensionProps } from "@elizaos/app-core/ui-compat";
import { FeedOperatorSurface } from "./FeedOperatorSurface";

export function FeedDetailExtension({ app }: AppDetailExtensionProps) {
  return <FeedOperatorSurface appName={app.name} variant="detail" />;
}
