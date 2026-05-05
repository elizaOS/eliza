import {
  useModelSettings,
  useUpdateModelSettings,
} from "../hooks/useModelSettings";
import {
  isModelProvider,
  MODEL_PROVIDER_LABELS,
  type ModelProvider,
  type ModelSettings,
  type ProviderModelConfig,
} from "../runtime/modelSettings";

type ProviderConfigKey = keyof ProviderModelConfig;
type ConfigurableProvider = ModelProvider;

export default function ModelSettingsPanel() {
  const settings = useModelSettings();
  const updateSettings = useUpdateModelSettings();

  const updateProviderSetting = (
    provider: ConfigurableProvider,
    key: ProviderConfigKey,
    value: string,
  ) => {
    const nextSettings: ModelSettings = {
      ...settings,
      [provider]: {
        ...settings[provider],
        [key]: value,
      },
    };
    updateSettings(nextSettings);
  };

  const provider: ConfigurableProvider = settings.provider;
  const providerConfig: ProviderModelConfig = getProviderConfig(
    settings,
    provider,
  );
  const supportsApiKey = provider !== "local";
  const supportsBaseUrl =
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "groq" ||
    provider === "xai";

  return (
    <div className="box w-full">
      <h2 className="bg-brown-700 p-2 font-display text-2xl sm:text-3xl tracking-wider shadow-solid text-center">
        Settings
      </h2>
      <div className="flex flex-col gap-3 p-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider opacity-70">
            Provider
          </span>
          <select
            className="rounded bg-brown-900/60 px-3 py-2 text-brown-100"
            value={provider}
            onChange={(event) => {
              const nextProvider = event.target.value;
              if (!isModelProvider(nextProvider)) {
                return;
              }
              updateSettings({ ...settings, provider: nextProvider });
            }}
          >
            {(
              ["openai", "xai", "groq", "local", "google", "anthropic"] as const
            ).map((value) => (
              <option key={value} value={value}>
                {MODEL_PROVIDER_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        {supportsApiKey && (
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider opacity-70">
              {MODEL_PROVIDER_LABELS[provider]} API Key
            </span>
            <input
              type="password"
              className="rounded bg-brown-900/60 px-3 py-2 text-brown-100"
              value={providerConfig.apiKey}
              onChange={(event) =>
                updateProviderSetting(provider, "apiKey", event.target.value)
              }
              placeholder="Paste your API key"
            />
          </label>
        )}

        {supportsBaseUrl && (
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider opacity-70">
              Base URL
            </span>
            <input
              type="text"
              className="rounded bg-brown-900/60 px-3 py-2 text-brown-100"
              value={providerConfig.baseUrl ?? ""}
              onChange={(event) =>
                updateProviderSetting(provider, "baseUrl", event.target.value)
              }
              placeholder="https://api.openai.com/v1"
            />
          </label>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider opacity-70">
            Small Model
          </span>
          <input
            type="text"
            className="rounded bg-brown-900/60 px-3 py-2 text-brown-100"
            value={providerConfig.smallModel}
            onChange={(event) =>
              updateProviderSetting(provider, "smallModel", event.target.value)
            }
            placeholder="Small model"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider opacity-70">
            Large Model
          </span>
          <input
            type="text"
            className="rounded bg-brown-900/60 px-3 py-2 text-brown-100"
            value={providerConfig.largeModel}
            onChange={(event) =>
              updateProviderSetting(provider, "largeModel", event.target.value)
            }
            placeholder="Large model"
          />
        </label>

        {provider === "local" ? (
          <div className="text-xs opacity-70">
            Local models download and cache on first use.
          </div>
        ) : (
          <div className="text-xs opacity-70">
            API keys are stored locally in your browser storage.
          </div>
        )}
      </div>
    </div>
  );
}

function getProviderConfig(
  settings: ModelSettings,
  provider: ModelProvider,
): ProviderModelConfig {
  switch (provider) {
    case "openai":
      return settings.openai;
    case "anthropic":
      return settings.anthropic;
    case "google":
      return settings.google;
    case "groq":
      return settings.groq;
    case "xai":
      return settings.xai;
    case "local":
      return settings.local;
    default:
      return settings.openai;
  }
}
