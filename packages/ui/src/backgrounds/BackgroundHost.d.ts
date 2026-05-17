export interface BackgroundFallbackContext {
  moduleKind?: string;
  electrobunRuntime: boolean;
  reducedMotion: boolean;
}
export declare function shouldUseSolidBackgroundFallback({
  moduleKind,
  electrobunRuntime,
  reducedMotion,
}: BackgroundFallbackContext): boolean;
export interface BackgroundHostProps {
  moduleId?: string;
  className?: string;
}
export declare function BackgroundHost(
  props: BackgroundHostProps,
): React.JSX.Element;
//# sourceMappingURL=BackgroundHost.d.ts.map
