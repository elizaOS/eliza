import type { AppDetailExtensionProps } from "@elizaos/app-core/ui-compat";
import { BabylonOperatorSurface } from "./BabylonOperatorSurface";

export function BabylonDetailExtension({ app }: AppDetailExtensionProps) {
  return <BabylonOperatorSurface appName={app.name} variant="detail" />;
}
