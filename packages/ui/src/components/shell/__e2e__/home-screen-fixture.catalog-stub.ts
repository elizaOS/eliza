export function useViewCatalog() {
  return {
    entries: [
      {
        key: "app:weather",
        id: "weather",
        label: "Weather",
        icon: "CloudSun",
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
