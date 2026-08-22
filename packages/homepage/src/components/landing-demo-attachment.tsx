import { LandingHandoffAttachment } from "@/components/landing-handoff-attachment";
import { LandingItineraryAttachment } from "@/components/landing-itinerary-attachment";
import { LandingPlaceAttachment } from "@/components/landing-place-attachment";
import { LandingTaskListAttachment } from "@/components/landing-task-list-attachment";
import type { LandingDemoStep } from "@/lib/landing-demo";

export type LandingDemoAttachmentStep = Exclude<
  LandingDemoStep,
  { kind: "eliza" | "member" | "user" }
>;

export function isLandingDemoAttachmentStep(
  step: LandingDemoStep,
): step is LandingDemoAttachmentStep {
  return (
    step.kind !== "eliza" && step.kind !== "member" && step.kind !== "user"
  );
}

export function LandingDemoAttachment({
  step,
}: {
  step: LandingDemoAttachmentStep;
}) {
  switch (step.kind) {
    case "place":
      return <LandingPlaceAttachment place={step.place} />;
    case "task-list":
      return <LandingTaskListAttachment taskList={step.taskList} />;
    case "handoff":
      return <LandingHandoffAttachment handoff={step.handoff} />;
    case "itinerary":
      return <LandingItineraryAttachment itinerary={step.itinerary} />;
  }
}
