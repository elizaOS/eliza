/**
 * Empty optional app-plugin exports so scaffolded projects can compile without
 * first-party optional feature packages installed.
 */

import type { ComponentType } from "react";

const EmptyComponent: ComponentType = () => null;
const optionalPlugin = Object.freeze({
  name: "optional-elizaos-app-stub",
  routes: [],
});

export const InferenceCloudAlertButton = EmptyComponent;
export const AppBlockerSettingsCard = EmptyComponent;
export const WebsiteBlockerSettingsCard = EmptyComponent;
export const CodingAgentControlChip = EmptyComponent;
export const CodingAgentSettingsSection = EmptyComponent;
export const CodingAgentTasksPanel = EmptyComponent;
export const PtyConsoleDrawer = EmptyComponent;
export const FineTuningView = EmptyComponent;

export const LIFEOPS_CONNECTOR_DEGRADATION_AXES = Object.freeze([]);
export const appPlugin = optionalPlugin;
export const defaultPlugin = optionalPlugin;
export const hyperliquidPlugin = optionalPlugin;
export const documentsPlugin = optionalPlugin;
export const personalAssistantPlugin = optionalPlugin;
export const polymarketPlugin = optionalPlugin;
export const plugin = optionalPlugin;
export const shopifyPlugin = optionalPlugin;
export const stewardPlugin = optionalPlugin;
export const trainingPlugin = optionalPlugin;

export const documentsRoutes = Object.freeze([]);
export const trainingRoutes = Object.freeze([]);

export function createVectorBrowserRenderer(): Promise<null> {
  return Promise.resolve(null);
}

export function clearBackendCache() {}
export async function detectAvailableBackends() {
  return { available: false, backends: [] };
}
export function dispatchQueuedLifeOpsGithubCallbackFromUrl(): void {}
export function getSelfControlPermissionState() {
  return { granted: false, status: "unavailable" };
}
export async function handleCloudFeaturesRoute() {
  return false;
}
export async function handleDocumentsRoutes() {
  return false;
}
export async function handleTrainingRoutes() {
  return false;
}
export async function handleTrajectoryRoute() {
  return false;
}
export async function handleTravelProviderRelayRoute() {
  return false;
}
export async function handleWalletCoreRoutes() {
  return false;
}
export async function initializeOGCode() {}
export async function loadTrainingConfig() {
  return {};
}
export function normalizePreflightAuth(auth: unknown) {
  return auth ?? null;
}
export async function openSelfControlPermissionLocation() {
  return false;
}
export async function requestSelfControlPermission() {
  return { granted: false, status: "unavailable" };
}
export async function registerTrainingRuntimeHooks() {}
export function sanitizeAuthResult(result: unknown) {
  return result ?? null;
}
export async function saveTrainingConfig() {}
export function setActiveTrainingService() {}

export default optionalPlugin;
