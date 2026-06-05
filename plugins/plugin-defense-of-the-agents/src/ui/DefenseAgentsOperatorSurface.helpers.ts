// Shared (non-component) constants for the Defense of the Agents operator
// surface. Kept out of DefenseAgentsOperatorSurface.tsx so that file exports only
// React components and stays Fast-Refresh-compatible. Used by both the view
// components and the view-bundle `interact` handler.

export const LANES = ["top", "mid", "bot"] as const;
