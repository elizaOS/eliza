/** Default field registry (catalog wired to the default renderers) and the `useConfigValidation` hook that lets a parent form call `ConfigRenderer.validateAll()` before submitting. */
import { useCallback, useRef } from "react";
import type { FieldRegistry } from "../../config/config-catalog";
import { defaultCatalog, defineRegistry } from "../../config/config-catalog";
import { defaultRenderers } from "./config-field.helpers";
import type { ConfigRendererHandle } from "./config-renderer";

/** The default registry wiring defaultCatalog → defaultRenderers. */
export const defaultRegistry: FieldRegistry = defineRegistry(
  defaultCatalog,
  defaultRenderers,
);

/**
 * Convenience hook that creates a ref for ConfigRenderer and exposes
 * a `validateAll()` function the parent can call before submitting.
 *
 * @example
 * ```tsx
 * const { configRef, validateAll } = useConfigValidation();
 *
 * const handleSave = () => {
 *   if (!validateAll()) return; // form has errors
 *   // proceed with save
 * };
 *
 * return <ConfigRenderer ref={configRef} ... />;
 * ```
 */
export function useConfigValidation() {
  const configRef = useRef<ConfigRendererHandle>(null);

  const validateAll = useCallback((): boolean => {
    if (!configRef.current) return true;
    return configRef.current.validateAll();
  }, []);

  return { configRef, validateAll };
}
