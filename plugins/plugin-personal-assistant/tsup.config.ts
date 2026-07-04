/**
 * Build configuration for the plugin: extends the shared plugin-package tsup
 * preset and disables `clean` so incremental type and JS emit is preserved.
 */
import sharedConfig from "../tsup.plugin-packages.shared";

export default {
  ...sharedConfig,
  clean: false,
};
