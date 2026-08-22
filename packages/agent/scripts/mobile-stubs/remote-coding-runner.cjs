// Mobile bundle stub for the remote coding router, which is unavailable in the
// on-device agent runtime.
module.exports = {
  registerRemoteCodingCapabilityRouterIfEnabled: async () => ({
    registered: false,
    reason: "mobile-bundle",
  }),
};
