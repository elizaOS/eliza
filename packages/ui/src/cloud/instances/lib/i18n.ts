/**
 * i18n shim for the Instances domain.
 *
 * The cloud-frontend pages call `useT()` from their own `I18nProvider`. In the
 * app the equivalent context is the shell's {@link CloudI18nProvider} (mounted
 * by `CloudRouterShell` around every cloud route), which exposes `useCloudT()`.
 * Re-export it here under the `useT` name so the lifted page modules keep their
 * translation call sites unchanged.
 */

export { useCloudT as useT } from "../../shell/CloudI18nProvider";
