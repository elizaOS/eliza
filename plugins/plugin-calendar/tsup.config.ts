/** tsup build config for the plugin; extends the shared plugin-packages preset and keeps existing dist between builds. */
import sharedConfig from "../tsup.plugin-packages.shared";

export default {
  ...sharedConfig,
  clean: false,
};
