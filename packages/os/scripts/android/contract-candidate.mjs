/** Builder output is deliberately not an installation authorization. */
export function contractCandidate(bundle) {
  return {
    schemaVersion: 1,
    kind: "android-contract-candidate",
    authorized: false,
    target: bundle.target,
    sources: bundle.sources,
    artifacts: bundle.artifacts,
    hostValidation: bundle.hostValidation,
    physicalDevice: bundle.physicalDevice,
    productionBlockedReasons: [
      "No signed v2 release and independent qualification signatures.",
      "No exact-SKU, firmware/rollback/recovery and physical hardware qualification.",
      "Current grizzly userdebug/test-key images cannot authorize production installation or relocking.",
      "Vendor sepolicy version rewrite requires real mapping and boot evidence before production.",
    ],
  };
}
