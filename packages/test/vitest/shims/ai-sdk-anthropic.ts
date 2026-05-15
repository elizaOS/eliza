type AnthropicModel = {
  readonly provider: string;
  readonly modelId: string;
};

type AnthropicFactory = {
  (modelId: string): AnthropicModel;
  languageModel: (modelId: string) => AnthropicModel;
};

function createModel(modelId: string): AnthropicModel {
  return {
    provider: "anthropic:test-shim",
    modelId,
  };
}

export function createAnthropic(): AnthropicFactory {
  const factory = ((modelId: string) =>
    createModel(modelId)) as AnthropicFactory;
  factory.languageModel = createModel;
  return factory;
}

export const anthropic = createAnthropic();
export const VERSION = "test-shim";

export function forwardAnthropicContainerIdFromLastStep() {
  return undefined;
}
