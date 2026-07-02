/**
 * i18n shim for the Instances domain.
 *
 * Re-exports the shell's `useCloudT()` ({@link CloudI18nProvider}, mounted by
 * `CloudRouterShell` around every cloud route) under the `useT` name the
 * Instances page modules call.
 */

export { useCloudT as useT } from "../../shell/CloudI18nProvider";
