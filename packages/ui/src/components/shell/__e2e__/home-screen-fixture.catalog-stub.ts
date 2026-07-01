import { generateViewHeroSvgFor } from "@elizaos/shared";

const WEATHER_HERO = `data:image/svg+xml,${encodeURIComponent(
  generateViewHeroSvgFor({
    id: "weather",
    label: "Weather",
    icon: "CloudSun",
  }),
)}`;

export function useViewCatalog() {
  return {
    entries: [
      {
        key: "app:weather",
        id: "weather",
        label: "Weather",
        icon: "CloudSun",
        imageUrl: WEATHER_HERO,
        fallbackImageUrl: WEATHER_HERO,
        hasHero: false,
        modality: "gui",
        state: "available",
        kind: "app",
        appName: "weather",
        pluginName: "weather",
        viewKind: "release",
      },
    ],
    loading: false,
    error: null,
    refresh: () => {},
    get: async () => {},
  };
}
