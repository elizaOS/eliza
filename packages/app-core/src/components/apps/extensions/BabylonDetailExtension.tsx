import { BabylonOperatorSurface } from "../surfaces/BabylonOperatorSurface";
import type { AppDetailExtensionProps } from "./types";

export function BabylonDetailExtension({ app }: AppDetailExtensionProps) {
  return <BabylonOperatorSurface appName={app.name} variant="detail" />;
}
