import type { AppDetailExtensionProps } from "@elizaos/app-core/ui-compat";
import { TwoThousandFourScapeOperatorSurface } from "./TwoThousandFourScapeOperatorSurface";

export function TwoThousandFourScapeDetailExtension({
  app,
}: AppDetailExtensionProps) {
  return (
    <TwoThousandFourScapeOperatorSurface appName={app.name} variant="detail" />
  );
}
