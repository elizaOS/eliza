import { BellRing, Sun } from "lucide-react";
import type { LandingDemoHeatPlan } from "@/lib/landing-demo";

export function LandingHeatPlanAttachment({
  heatPlan,
}: {
  heatPlan: LandingDemoHeatPlan;
}) {
  return (
    <article
      className="landing-heat-plan-attachment"
      aria-label={`${heatPlan.day} heat plan: ${heatPlan.alert}`}
    >
      <header className="landing-heat-plan-head">
        <span>
          <small>{heatPlan.day}</small>
          <strong>{heatPlan.title}</strong>
          <span>
            <BellRing aria-hidden="true" />
            {heatPlan.alert}
          </span>
        </span>
        <Sun aria-hidden="true" />
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
