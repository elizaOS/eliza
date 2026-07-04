// Mobile bundle stub for the E2B capability router registration path, which is
// unavailable in the on-device agent runtime.
module.exports = {
  registerE2BRemoteCapabilityRouterIfEnabled: async () => ({
    registered: false,
    reason: "mobile-bundle",
  }),
};
