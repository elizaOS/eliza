import { TwoThousandFourScapeOperatorSurface } from "../surfaces/TwoThousandFourScapeOperatorSurface";
import type { AppDetailExtensionProps } from "./types";

export function TwoThousandFourScapeDetailExtension({
  app,
}: AppDetailExtensionProps) {
  return (
    <TwoThousandFourScapeOperatorSurface appName={app.name} variant="detail" />
  );
}
