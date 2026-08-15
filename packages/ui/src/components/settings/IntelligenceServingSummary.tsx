/**
 * States the two independent serving axes above the Intelligence tiles: where
 * the agent process runs and where chat tokens are computed. The tiles answer
 * only the inference question, so a hosted-Cloud agent and a local agent using
 * Cloud models render identically there (#20045 follow-up). Presentational —
 * `resolveServingAxes` owns the classification.
 */

import { Cloud, Cpu, Server } from "lucide-react";
import type { ComponentType } from "react";
import type {
  ServingAxes,
  ServingInference,
  ServingRuntime,
} from "./resolveServingAxes";
import { SettingsRow } from "./settings-layout";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

const RUNTIME_ICON: Record<
  ServingRuntime,
  ComponentType<{ className?: string }>
> = {
  local: Cpu,
  cloud: Cloud,
  remote: Server,
};

function runtimeValue(runtime: ServingRuntime, t: Translate): string {
  switch (runtime) {
    case "local":
      return t("providerswitcher.servingRuntimeLocal", {
        defaultValue: "This device",
      });
    case "cloud":
      return t("providerswitcher.servingRuntimeCloud", {
        defaultValue: "Eliza Cloud",
      });
    case "remote":
      return t("providerswitcher.servingRuntimeRemote", {
        defaultValue: "Remote host",
      });
  }
}

function runtimeDescription(runtime: ServingRuntime, t: Translate): string {
  switch (runtime) {
    case "local":
      return t("providerswitcher.servingRuntimeLocalDescription", {
        defaultValue:
          "The agent process runs on this device, so it stops when the app does.",
      });
    case "cloud":
      return t("providerswitcher.servingRuntimeCloudDescription", {
        defaultValue:
          "The agent process is hosted on Eliza Cloud and stays online when this device sleeps.",
      });
    case "remote":
      return t("providerswitcher.servingRuntimeRemoteDescription", {
        defaultValue:
          "The agent process runs on a remote host you configured, not on Eliza Cloud.",
      });
  }
}

function inferenceValue(inference: ServingInference, t: Translate): string {
  return inference === "cloud"
    ? t("providerswitcher.servingInferenceCloud", {
        defaultValue: "Eliza Cloud",
      })
    : t("providerswitcher.servingInferenceLocal", {
        defaultValue: "This device",
      });
}

function inferenceDescription(axes: ServingAxes, t: Translate): string {
  if (axes.inferenceFallback) {
    return t("providerswitcher.servingInferenceFallbackDescription", {
      defaultValue:
        "Eliza Cloud is selected but not signed in, so chat replies are computed locally until you sign in.",
    });
  }
  return axes.inference === "cloud"
    ? t("providerswitcher.servingInferenceCloudDescription", {
        defaultValue: "Chat replies are computed by Eliza Cloud models.",
      })
    : t("providerswitcher.servingInferenceLocalDescription", {
        defaultValue: "Chat replies are computed by the on-device model.",
      });
}

/**
 * Two labeled facts rather than one clever sentence — "Cloud" alone cannot
 * distinguish a hosted agent from Cloud models, which is the whole point of
 * this row pair.
 */
export function IntelligenceServingSummary({
  axes,
  t,
}: {
  axes: ServingAxes;
  t: Translate;
}) {
  const RuntimeIcon = RUNTIME_ICON[axes.runtime];
  const InferenceIcon = axes.inference === "cloud" ? Cloud : Cpu;

  return (
    <>
      <SettingsRow
        icon={RuntimeIcon}
        label={t("providerswitcher.servingRuntimeLabel", {
          defaultValue: "Agent runtime",
        })}
        description={runtimeDescription(axes.runtime, t)}
        control={
          <span
            className="text-xs text-txt-strong"
            data-testid="serving-runtime-value"
          >
            {runtimeValue(axes.runtime, t)}
          </span>
        }
      />
      <SettingsRow
        icon={InferenceIcon}
        label={t("providerswitcher.servingInferenceLabel", {
          defaultValue: "Chat inference",
        })}
        description={inferenceDescription(axes, t)}
        control={
          <span
            className="text-xs text-txt-strong"
            data-testid="serving-inference-value"
          >
            {inferenceValue(axes.inference, t)}
          </span>
        }
      />
    </>
  );
}
