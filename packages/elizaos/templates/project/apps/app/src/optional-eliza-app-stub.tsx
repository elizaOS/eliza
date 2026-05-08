import type { ComponentType } from "react";
import * as THREE from "three";

const EmptyComponent: ComponentType = () => null;
const optionalPlugin = Object.freeze({
  name: "optional-elizaos-app-stub",
  routes: [],
});

export const CompanionShell = EmptyComponent;
export const GlobalEmoteOverlay = EmptyComponent;
export const InferenceCloudAlertButton = EmptyComponent;
export const LifeOpsActivitySignalsEffect = EmptyComponent;
export const AppBlockerSettingsCard = EmptyComponent;
export const LifeOpsBrowserSetupPanel = EmptyComponent;
export const LifeOpsPageView = EmptyComponent;
export const WebsiteBlockerSettingsCard = EmptyComponent;
export const ApprovalQueue = EmptyComponent;
export const StewardLogo = EmptyComponent;
export const TransactionHistory = EmptyComponent;
export const CodingAgentControlChip = EmptyComponent;
export const CodingAgentSettingsSection = EmptyComponent;
export const CodingAgentTasksPanel = EmptyComponent;
export const PtyConsoleDrawer = EmptyComponent;
export const FineTuningView = EmptyComponent;

export const EMOTE_BY_ID = Object.freeze({});
export const EMOTE_CATALOG = Object.freeze([]);
export const LIFEOPS_CONNECTOR_DEGRADATION_AXES = Object.freeze([]);
export const appPlugin = optionalPlugin;
export const defaultPlugin = optionalPlugin;
export const hyperliquidPlugin = optionalPlugin;
export const documentsPlugin = optionalPlugin;
export const lifeopsPlugin = optionalPlugin;
export const polymarketPlugin = optionalPlugin;
export const plugin = optionalPlugin;
export const shopifyPlugin = optionalPlugin;
export const stewardPlugin = optionalPlugin;
export const trainingPlugin = optionalPlugin;
export const vincentPlugin = optionalPlugin;

export const documentsRoutes = Object.freeze([]);
export const trainingRoutes = Object.freeze([]);

export function createVectorBrowserRenderer(): Promise<null> {
  return Promise.resolve(null);
}

export function prefetchVrmToCache(): Promise<void> {
  return Promise.resolve();
}

export function resolveCompanionInferenceNotice(): null {
  return null;
}

export function useCompanionSceneStatus() {
  return { avatarReady: false, teleportKey: "" };
}

export function useVincentState() {
  return {
    vincentConnected: false,
    vincentLoginBusy: false,
    vincentLoginError: null,
    vincentConnectedAt: null,
    handleVincentLogin: async () => {},
    handleVincentDisconnect: async () => {},
    pollVincentStatus: async () => false,
  };
}

export function clearBackendCache() {}
export async function detectAvailableBackends() {
  return { available: false, backends: [] };
}
export function dispatchQueuedLifeOpsGithubCallbackFromUrl(): void {}
export function getElizaMakerRegistryService() {
  return null;
}
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
export async function stewardEvmPostBoot() {}
export async function stewardEvmPreBoot() {}

export { THREE };
export default optionalPlugin;
