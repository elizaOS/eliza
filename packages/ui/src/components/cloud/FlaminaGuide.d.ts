import type { FlaminaGuideTopic } from "../../state/types";
export declare function FlaminaGuideCard({
  topic,
  className,
}: {
  topic: FlaminaGuideTopic;
  className?: string;
}): import("react/jsx-runtime").JSX.Element;
export declare function DeferredSetupChecklist({
  className,
  onOpenTask,
}: {
  className?: string;
  onOpenTask?: (task: FlaminaGuideTopic) => void;
}): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=FlaminaGuide.d.ts.map
