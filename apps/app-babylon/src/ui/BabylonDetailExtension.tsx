import { BabylonOperatorSurface } from "./BabylonOperatorSurface";
import type { AppDetailExtensionProps } from "@elizaos/app-core/components/apps/extensions/types";

export function BabylonDetailExtension({ app }: AppDetailExtensionProps) {
  return <BabylonOperatorSurface appName={app.name} variant="detail" />;
}
