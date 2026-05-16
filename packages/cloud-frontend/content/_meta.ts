/**
 * elizaOS Cloud Documentation - Navigation Structure
 *
 * Organized to match the dashboard sidebar structure for consistency
 * and ease of navigation between docs and the platform.
 */
const meta = {
  index: {
    title: "Introduction",
    theme: {
      layout: "full",
      toc: false,
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // Getting Started
  // ─────────────────────────────────────────────────────────────────────
  "-- getting-started": {
    type: "separator",
    title: "Getting Started",
  },
  quickstart: {
    title: "Quickstart Guide",
  },
  installation: {
    title: "Installation",
  },
  authentication: {
    title: "Authentication",
  },
  "wallet-api": {
    title: "Wallet API",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Core Features - Agents
  // ─────────────────────────────────────────────────────────────────────
  "-- agents-section": {
    type: "separator",
    title: "Agents",
  },
  agents: {
    title: "AI Agents",
  },
  "agent-creator": {
    title: "Agent Creator",
  },
  "character-json": {
    title: "Character JSON",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Infrastructure
  // ─────────────────────────────────────────────────────────────────────
  "-- infrastructure-section": {
    type: "separator",
    title: "Runtime & Apps",
  },
  apps: {
    title: "App Devices",
  },
  "app-domains": {
    title: "App Domains",
  },
  containers: {
    title: "Containers",
  },
  mcps: {
    title: "MCP Integration",
  },
  documents: {
    title: "Knowledge Base",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Monetization
  // ─────────────────────────────────────────────────────────────────────
  "-- monetization-section": {
    type: "separator",
    title: "Monetization",
  },
  earnings: {
    title: "Earnings",
  },
  "monetized-apps": {
    title: "Monetized Apps",
  },
  billing: {
    title: "Billing & Credits",
  },

  // ─────────────────────────────────────────────────────────────────────
  // API Reference (Nested folder with sidebar)
  // ─────────────────────────────────────────────────────────────────────
  "-- api-section": {
    type: "separator",
    title: "API Reference",
  },
  api: {
    title: "REST API",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Protocols
  // ─────────────────────────────────────────────────────────────────────
  "-- protocols-section": {
    type: "separator",
    title: "Protocols",
  },
  a2a: {
    title: "A2A Protocol",
  },
  mcp: {
    title: "MCP Protocol",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Reference
  // ─────────────────────────────────────────────────────────────────────
  "-- reference-section": {
    type: "separator",
    title: "Reference",
  },
  "rate-limits": {
    title: "Rate Limits",
  },
  errors: {
    title: "Error Handling",
  },
  sdks: {
    title: "SDKs & Libraries",
  },
  changelog: {
    title: "Changelog",
  },
};

export default meta;
