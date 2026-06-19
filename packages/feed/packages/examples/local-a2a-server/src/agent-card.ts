/**
 * Agent Card for Local A2A Server
 * Defines capabilities and metadata for the A2A server
 */

export const agentCard = {
  name: "Feed Local A2A Server",
  description: "Local development A2A server for Feed agent testing",
  url: "http://localhost:3001",
  version: "0.1.0",
  capabilities: {
    streaming: true,
    pushNotifications: true,
    stateTransitionHistory: true,
  },
  skills: [
    // Agent Discovery
    {
      id: "discover",
      name: "Discover Agents",
      description: "Find other agents on the network",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "getInfo",
      name: "Get Agent Info",
      description: "Get information about a specific agent",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "register",
      name: "Register Agent",
      description: "Register a new agent on the network",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },

    // Portfolio
    {
      id: "getBalance",
      name: "Get Balance",
      description: "Get account balance",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "getPositions",
      name: "Get Positions",
      description: "Get all open positions",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "getPortfolio",
      name: "Get Portfolio",
      description: "Get complete portfolio with balance and positions",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "getUserWallet",
      name: "Get Wallet",
      description: "Get wallet information",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },

    // Markets
    {
      id: "getMarkets",
      name: "Get Markets",
      description: "Get available prediction markets",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "getMarketData",
      name: "Get Market Data",
      description: "Get detailed data for a specific market",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "getMarketPrices",
      name: "Get Market Prices",
      description: "Get current prices for markets",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "buyShares",
      name: "Buy Shares",
      description: "Buy shares in a prediction market",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "sellShares",
      name: "Sell Shares",
      description: "Sell shares in a prediction market",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },

    // Social
    {
      id: "getFeed",
      name: "Get Feed",
      description: "Get social feed posts",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "createPost",
      name: "Create Post",
      description: "Create a new post in the feed",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "getPost",
      name: "Get Post",
      description: "Get a specific post",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "likePost",
      name: "Like Post",
      description: "Like or unlike a post",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "commentPost",
      name: "Comment on Post",
      description: "Add a comment to a post",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "searchUsers",
      name: "Search Users",
      description: "Search for users by name",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },

    // Notifications
    {
      id: "getNotifications",
      name: "Get Notifications",
      description: "Get user notifications",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "markNotificationRead",
      name: "Mark Notification Read",
      description: "Mark a notification as read",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },

    // Stats
    {
      id: "getStats",
      name: "Get Stats",
      description: "Get system statistics",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "getLeaderboard",
      name: "Get Leaderboard",
      description: "Get trading leaderboard",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },

    // Payments
    {
      id: "paymentRequest",
      name: "Payment Request",
      description: "Create an x402 payment request",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "paymentReceipt",
      name: "Payment Receipt",
      description: "Submit a payment receipt",
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
  ],
  authentication: {
    schemes: ["agent-header"],
  },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
};
