/**
 * App permissions settings panel.
 *
 * Lists every registered app and lets the operator toggle which
 * declared permission namespaces are granted. Reads/writes:
 *   GET  /api/apps/permissions
 *   PUT  /api/apps/permissions/:slug   { namespaces: string[] }
 *
 * Per `eliza/packages/docs/architecture/app-permissions-granted-store.md`
 * grants are advisory in this slice — Phase 2 wires the runtime
 * enforcement that reads them. The UI surfaces this as a "not yet
 * enforced" badge so users aren't misled.
 */
export declare function AppPermissionsSection(): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=AppPermissionsSection.d.ts.map
