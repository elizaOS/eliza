export const INVESTOR_INSIGHT_TEMPLATES = {
  establishedWalletHistory: {
    title: "Established Wallet History",

    whyItMatters:
      "A longer blockchain history provides more evidence for understanding how a wallet typically behaves.",
  },

  exchangeFunding: {
    title: "Exchange-Linked Funding",

    whyItMatters:
      "Funding originating from a centralized exchange can help explain how the wallet first entered the blockchain ecosystem.",
  },

  lowRisk: {
    title: "Low Risk Indicators",

    whyItMatters:
      "Lower observed risk indicators increase confidence in the overall assessment, although they do not eliminate future risk.",
  },

  noKnownExposure: {
    title: "No Known Exposure",

    whyItMatters:
      "No known scam, rug-pull or suspicious exposure was identified in the currently connected intelligence sources.",
  },
} as const;
