import { Sun } from "lucide-react";
import type { LandingDemoHeatPlan } from "@/lib/landing-demo";

export function LandingHeatPlanAttachment({
  heatPlan,
}: {
  heatPlan: LandingDemoHeatPlan;
}) {
  return (
    <article
      className="landing-heat-plan-attachment"
      aria-label={`${heatPlan.title}: ${heatPlan.schedule.map((item) => item.task).join(", ")}`}
    >
      <header className="landing-heat-plan-head landing-attachment-head">
        <span
          className="landing-heat-plan-app-icon landing-attachment-icon"
          aria-hidden="true"
        >
          <Sun />
        </span>
        <strong>{heatPlan.title}</strong>
      </header>
      <ul className="landing-heat-plan-schedule">
        {heatPlan.schedule.map((item) => (
          <li key={`${item.day}-${item.task}`}>
            <strong>{item.day}</strong>
            <span>{item.task}</span>
            <small>{item.assignee}</small>
          </li>
        ))}
      </ul>
    </article>
  );
}
