import {
  AGENT_PRICING,
  formatHourlyRate,
} from "@elizaos/cloud-sdk/browser-contracts";
import {
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { useCloudT } from "../../shell/CloudI18nProvider";

export function AgentDeactivationDetails() {
  const t = useCloudT();
  return (
    <AlertDialogHeader>
      <AlertDialogTitle className="text-txt-strong">
        {t("cloud.containers.agentActions.deactivateTitle", {
          defaultValue: "Deactivate this agent?",
        })}
      </AlertDialogTitle>
      <AlertDialogDescription className="text-muted">
        <span className="block">
          {t("cloud.containers.agentActions.deactivateBody1", {
            defaultValue:
              "Your agent stops running and stops consuming hourly credits (currently {{rate}} while running).",
            rate: formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE),
          })}
        </span>
        <span className="block mt-2">
          {t("cloud.containers.agentActions.deactivateBody2", {
            defaultValue:
              "Eliza retains your agent data during deactivation. If deactivation cannot complete, the agent stays running and billing continues.",
          })}
        </span>
        <span className="block mt-2">
          {t("cloud.containers.agentActions.deactivateMinimum", {
            defaultValue:
              "Any remaining activation minimum is charged when you stop.",
          })}
        </span>
        <span className="block mt-2">
          {t("cloud.containers.agentActions.deactivateBody3", {
            defaultValue:
              "Reactivation restores the agent's retained data and can take a few minutes; it requires available credits.",
          })}
        </span>
      </AlertDialogDescription>
    </AlertDialogHeader>
  );
}
