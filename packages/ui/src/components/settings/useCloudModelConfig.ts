/**
 * State + save logic for the Eliza Cloud model tier dropdowns.
 *
 * Extracted from ProviderSwitcher so the orchestrator stays a thin
 * compositional shell. Persists tier picks via /api/config update +
 * agent restart, surfaces saving/success state, and exposes the
 * derived modelValues used by the cloud-tier ConfigRenderer.
 */
import {
  buildElizaCloudServiceRoute,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  type ModelOption,
  normalizeServiceRoutingConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import { useTimeout } from "@elizaos/ui";
import { useCallback, useMemo, useState } from "react";
import { client, type OnboardingOptions } from "../../api";
import {
  buildCloudModelSchema,
  type CloudModelSchema,
  DEFAULT_ACTION_PLANNER_MODEL,
  DEFAULT_RESPONSE_HANDLER_MODEL,
} from "./cloud-model-schema";

export interface CloudModelConfig {
  modelOptions: OnboardingOptions["models"] | null;
  setModelOptions: (options: OnboardingOptions["models"]) => void;
  initializeFromConfig: (
    cfg: Record<string, unknown>,
    elizaCloudEnabledCfg: boolean,
  ) => void;
  cloudModelSchema: CloudModelSchema | null;
  largeModelOptions: ModelOption[];
  currentLargeModel: string;
  modelValues: { values: Record<string, unknown>; setKeys: Set<string> };
  modelSaving: boolean;
  modelSaveSuccess: boolean;
  handleModelFieldChange: (key: string, value: unknown) => void;
}

function readConfigString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const value = source?.[key];
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function useCloudModelConfig(
  onSaveError: (prefix: string, err: unknown) => void,
): CloudModelConfig {
  const { setTimeout } = useTimeout();
  const [modelOptions, setModelOptionsState] = useState<
    OnboardingOptions["models"] | null
  >(null);
  const [currentNanoModel, setCurrentNanoModel] = useState("");
  const [currentSmallModel, setCurrentSmallModel] = useState("");
  const [currentMediumModel, setCurrentMediumModel] = useState("");
  const [currentLargeModel, setCurrentLargeModel] = useState("");
  const [currentMegaModel, setCurrentMegaModel] = useState("");
  const [currentResponseHandlerModel, setCurrentResponseHandlerModel] =
    useState(DEFAULT_RESPONSE_HANDLER_MODEL);
  const [currentActionPlannerModel, setCurrentActionPlannerModel] = useState(
    DEFAULT_ACTION_PLANNER_MODEL,
  );
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSaveSuccess, setModelSaveSuccess] = useState(false);

  const setModelOptions = useCallback(
    (options: OnboardingOptions["models"]) => {
      setModelOptionsState(options);
    },
    [],
  );

  const initializeFromConfig = useCallback(
    (cfg: Record<string, unknown>, elizaCloudEnabledCfg: boolean) => {
      const models = asRecord(cfg.models);
      const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
      const cloudDefault = elizaCloudEnabledCfg
        ? DEFAULT_ELIZA_CLOUD_TEXT_MODEL
        : "";
      const vars = asRecord(asRecord(cfg.env)?.vars);
      const envFor = (key: string) => readConfigString(vars, key);

      setCurrentNanoModel(
        readConfigString(models, "nano") ||
          llmText?.nanoModel ||
          envFor("NANO_MODEL") ||
          cloudDefault,
      );
      setCurrentSmallModel(
        readConfigString(models, "small") ||
          llmText?.smallModel ||
          envFor("SMALL_MODEL") ||
          cloudDefault,
      );
      setCurrentMediumModel(
        readConfigString(models, "medium") ||
          llmText?.mediumModel ||
          envFor("MEDIUM_MODEL") ||
          cloudDefault,
      );
      setCurrentLargeModel(
        readConfigString(models, "large") ||
          llmText?.largeModel ||
          envFor("LARGE_MODEL") ||
          cloudDefault,
      );
      setCurrentMegaModel(
        readConfigString(models, "mega") ||
          llmText?.megaModel ||
          envFor("MEGA_MODEL") ||
          cloudDefault,
      );
      setCurrentResponseHandlerModel(
        llmText?.responseHandlerModel || DEFAULT_RESPONSE_HANDLER_MODEL,
      );
      setCurrentActionPlannerModel(
        llmText?.actionPlannerModel || DEFAULT_ACTION_PLANNER_MODEL,
      );
    },
    [],
  );

  const cloudModelSchema = useMemo(
    () => (modelOptions ? buildCloudModelSchema(modelOptions) : null),
    [modelOptions],
  );

  const modelValues = useMemo(() => {
    const values: Record<string, unknown> = {};
    const setKeys = new Set<string>();
    const put = (key: string, value: string) => {
      if (value) {
        values[key] = value;
        setKeys.add(key);
      }
    };
    put("nano", currentNanoModel);
    put("small", currentSmallModel);
    put("medium", currentMediumModel);
    put("large", currentLargeModel);
    put("mega", currentMegaModel);
    put("responseHandler", currentResponseHandlerModel);
    put("actionPlanner", currentActionPlannerModel);
    return { values, setKeys };
  }, [
    currentActionPlannerModel,
    currentLargeModel,
    currentMediumModel,
    currentMegaModel,
    currentNanoModel,
    currentResponseHandlerModel,
    currentSmallModel,
  ]);

  const handleModelFieldChange = useCallback(
    (key: string, value: unknown) => {
      const val = String(value);
      const next = {
        nano: key === "nano" ? val : currentNanoModel,
        small: key === "small" ? val : currentSmallModel,
        medium: key === "medium" ? val : currentMediumModel,
        large: key === "large" ? val : currentLargeModel,
        mega: key === "mega" ? val : currentMegaModel,
        responseHandler:
          key === "responseHandler" ? val : currentResponseHandlerModel,
        actionPlanner:
          key === "actionPlanner" ? val : currentActionPlannerModel,
      };

      if (key === "nano") setCurrentNanoModel(val);
      if (key === "small") setCurrentSmallModel(val);
      if (key === "medium") setCurrentMediumModel(val);
      if (key === "large") setCurrentLargeModel(val);
      if (key === "mega") setCurrentMegaModel(val);
      if (key === "responseHandler") setCurrentResponseHandlerModel(val);
      if (key === "actionPlanner") setCurrentActionPlannerModel(val);

      void (async () => {
        setModelSaving(true);
        try {
          const cfg = await client.getConfig();
          const existingRouting = resolveServiceRoutingInConfig(cfg)?.llmText;
          const llmText = buildElizaCloudServiceRoute({
            nanoModel: next.nano,
            smallModel: next.small,
            mediumModel: next.medium,
            largeModel: next.large,
            megaModel: next.mega,
            ...(next.responseHandler !== DEFAULT_RESPONSE_HANDLER_MODEL
              ? { responseHandlerModel: next.responseHandler }
              : {}),
            ...(next.actionPlanner !== DEFAULT_ACTION_PLANNER_MODEL
              ? { actionPlannerModel: next.actionPlanner }
              : {}),
            ...(existingRouting?.shouldRespondModel
              ? { shouldRespondModel: existingRouting.shouldRespondModel }
              : {}),
            ...(existingRouting?.plannerModel
              ? { plannerModel: existingRouting.plannerModel }
              : {}),
            ...(existingRouting?.responseModel
              ? { responseModel: existingRouting.responseModel }
              : {}),
            ...(existingRouting?.mediaDescriptionModel
              ? {
                  mediaDescriptionModel: existingRouting.mediaDescriptionModel,
                }
              : {}),
          });
          await client.updateConfig({
            models: {
              nano: next.nano,
              small: next.small,
              medium: next.medium,
              large: next.large,
              mega: next.mega,
            },
            serviceRouting: {
              ...(normalizeServiceRoutingConfig(cfg.serviceRouting) ?? {}),
              llmText,
            },
          });
          setModelSaveSuccess(true);
          setTimeout(() => setModelSaveSuccess(false), 2000);
          await client.restartAgent();
        } catch (err) {
          onSaveError("Failed to save cloud model config", err);
        }
        setModelSaving(false);
      })();
    },
    [
      currentActionPlannerModel,
      currentLargeModel,
      currentMediumModel,
      currentMegaModel,
      currentNanoModel,
      currentResponseHandlerModel,
      currentSmallModel,
      onSaveError,
      setTimeout,
    ],
  );

  return {
    modelOptions,
    setModelOptions,
    initializeFromConfig,
    cloudModelSchema,
    largeModelOptions: modelOptions?.large ?? [],
    currentLargeModel,
    modelValues,
    modelSaving,
    modelSaveSuccess,
    handleModelFieldChange,
  };
}
