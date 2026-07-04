/**
 * Connector target-source registry.
 *
 * Public surface:
 * - `TargetSource` — a connector's addressable-target enumerator contract.
 * - `TargetGroup`, `TargetEntry` — the structured enumeration result.
 * - `TargetEnumerationContext` — host-supplied enumeration seams.
 * - `createTargetSourceRegistry()` — factory.
 * - `TargetSourceRegistry` — registry interface.
 * - `TargetSourceRegistryService` — runtime service (provided by basic-capabilities).
 * - `CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE` — service-type constant.
 */

export {
	CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
	createTargetSourceRegistry,
	type TargetEntry,
	type TargetEnumerationContext,
	type TargetGroup,
	type TargetSource,
	type TargetSourceLogger,
	type TargetSourceRegistry,
	TargetSourceRegistryService,
} from "./registry";
