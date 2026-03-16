// Re-export from modelProvider for backwards compatibility
export {
  buildModelDefinition,
  type CopilotProxyModelDefinition,
  createCopilotProxyProvider,
  createModelInstance,
  createProvider,
  DEFAULT_MODELS,
  type DefaultModelId,
  getAvailableModels,
  getLargeModelInstance,
  getModelProviderConfig,
  getSmallModelInstance,
  isDefaultModel,
  type ModelProviderConfig,
} from "./modelProvider";
