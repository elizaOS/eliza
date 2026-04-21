import { TwoThousandFourScapeOperatorSurface } from "./TwoThousandFourScapeOperatorSurface";
import type { AppDetailExtensionProps } from "@elizaos/app-core/components/apps/extensions/types";

export function TwoThousandFourScapeDetailExtension({
  app,
}: AppDetailExtensionProps) {
  return (
    <TwoThousandFourScapeOperatorSurface appName={app.name} variant="detail" />
  );
}
