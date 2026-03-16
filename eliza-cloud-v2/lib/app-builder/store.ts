/**
 * App Builder Zustand Store
 *
 * Consolidated state management for the app builder feature.
 * Uses isolated slices to prevent unnecessary re-renders.
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type {
  Message,
  SessionData,
  SessionStatus,
  ProgressStep,
  TemplateType,
  AppData,
  GitStatusInfo,
  CommitInfo,
  SnapshotInfo,
  AppSnapshotInfo,
  RestoreProgress,
  PreviewTab,
  MAX_CONSOLE_LOGS,
} from "./types";
import { DEFAULT_APP_BUILDER_MODEL } from "./types";

// ============================================
// CHAT INPUT SLICE - Isolated for fast typing
// ============================================

/** Image attachment for the chat input */
export interface ImageAttachment {
  id: string;
  file: File;
  previewUrl: string;      // Temporary blob URL for preview
  base64?: string;         // Base64 data for API
  blobUrl?: string;        // Persistent Vercel Blob URL
  uploadStatus: 'pending' | 'uploading' | 'uploaded' | 'error';
  uploadError?: string;
}

interface ChatInputSlice {
  input: string;
  images: ImageAttachment[];
  setInput: (input: string) => void;
  clearInput: () => void;
  addImage: (image: ImageAttachment) => void;
  removeImage: (id: string) => void;
  clearImages: () => void;
  setImageBase64: (id: string, base64: string) => void;
  setImageBlobUrl: (id: string, blobUrl: string) => void;
  setImageUploadStatus: (id: string, status: ImageAttachment['uploadStatus'], error?: string) => void;
}

export const useChatInput = create<ChatInputSlice>()((set) => ({
  input: "",
  images: [],
  setInput: (input) => set({ input }),
  addImage: (image) => set((state) => ({ images: [...state.images, image] })),
  removeImage: (id) => set((state) => ({ images: state.images.filter((img) => img.id !== id) })),
  clearImages: () => set({ images: [] }),
  setImageBase64: (id, base64) => set((state) => ({ 
    images: state.images.map((img) => img.id === id ? { ...img, base64 } : img) 
  })),
  setImageBlobUrl: (id, blobUrl) => set((state) => ({ 
    images: state.images.map((img) => img.id === id ? { ...img, blobUrl, uploadStatus: 'uploaded' } : img) 
  })),
  setImageUploadStatus: (id, status, error) => set((state) => ({ 
    images: state.images.map((img) => img.id === id ? { ...img, uploadStatus: status, uploadError: error } : img) 
  })),
  clearInput: () => set({ input: "", images: [] }),
}));

// ============================================
// MESSAGES SLICE - Only updates when messages change
// ============================================
interface MessagesSlice {
  messages: Message[];
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void;
  addMessage: (message: Message) => void;
  updateMessage: (
    thinkingId: number,
    updater: (msg: Message) => Message,
  ) => void;
  clearMessages: () => void;
}

export const useMessages = create<MessagesSlice>()((set) => ({
  messages: [],
  setMessages: (messagesOrUpdater) =>
    set((state) => ({
      messages:
        typeof messagesOrUpdater === "function"
          ? messagesOrUpdater(state.messages)
          : messagesOrUpdater,
    })),
  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  updateMessage: (thinkingId, updater) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m._thinkingId === thinkingId ? updater(m) : m,
      ),
    })),
  clearMessages: () => set({ messages: [] }),
}));

// ============================================
// SESSION SLICE - Core session state
// ============================================
interface SessionSlice {
  session: SessionData | null;
  status: SessionStatus;
  isLoading: boolean;
  errorMessage: string | null;
  progressStep: ProgressStep;
  expiresAt: Date | null;
  timeRemaining: string;

  setSession: (session: SessionData | null) => void;
  setStatus: (status: SessionStatus) => void;
  setIsLoading: (isLoading: boolean) => void;
  setErrorMessage: (errorMessage: string | null) => void;
  setProgressStep: (progressStep: ProgressStep) => void;
  setExpiresAt: (expiresAt: Date | null) => void;
  setTimeRemaining: (timeRemaining: string) => void;
  resetSession: () => void;
}

export const useSession = create<SessionSlice>()(
  subscribeWithSelector((set) => ({
    session: null,
    status: "idle",
    isLoading: false,
    errorMessage: null,
    progressStep: "creating",
    expiresAt: null,
    timeRemaining: "",

    setSession: (session) => set({ session }),
    setStatus: (status) => set({ status }),
    setIsLoading: (isLoading) => set({ isLoading }),
    setErrorMessage: (errorMessage) => set({ errorMessage }),
    setProgressStep: (progressStep) => set({ progressStep }),
    setExpiresAt: (expiresAt) => set({ expiresAt }),
    setTimeRemaining: (timeRemaining) => set({ timeRemaining }),
    resetSession: () =>
      set({
        session: null,
        status: "idle",
        isLoading: false,
        errorMessage: null,
        progressStep: "creating",
        expiresAt: null,
        timeRemaining: "",
      }),
  })),
);

// ============================================
// UI SLICE - UI-related state
// ============================================
interface UISlice {
  isFullscreen: boolean;
  previewTab: PreviewTab;
  consoleLogs: string[];
  copied: boolean;
  isExtending: boolean;
  isRestoring: boolean;
  restoreProgress: RestoreProgress | null;
  showCommitHistory: boolean;
  isInitializing: boolean;

  setIsFullscreen: (isFullscreen: boolean) => void;
  setPreviewTab: (previewTab: PreviewTab) => void;
  setConsoleLogs: (logs: string[] | ((prev: string[]) => string[])) => void;
  addConsoleLogs: (logs: string[]) => void;
  addLog: (message: string, level?: string) => void;
  clearConsoleLogs: () => void;
  setCopied: (copied: boolean) => void;
  setIsExtending: (isExtending: boolean) => void;
  setIsRestoring: (isRestoring: boolean) => void;
  setRestoreProgress: (restoreProgress: RestoreProgress | null) => void;
  setShowCommitHistory: (showCommitHistory: boolean) => void;
  setIsInitializing: (isInitializing: boolean) => void;
}

const MAX_LOGS = 500;

export const useUI = create<UISlice>()((set) => ({
  isFullscreen: false,
  previewTab: "preview",
  consoleLogs: [],
  copied: false,
  isExtending: false,
  isRestoring: false,
  restoreProgress: null,
  showCommitHistory: false,
  isInitializing: false,

  setIsFullscreen: (isFullscreen) => set({ isFullscreen }),
  setPreviewTab: (previewTab) => set({ previewTab }),
  setConsoleLogs: (logsOrUpdater) =>
    set((state) => {
      const newLogs =
        typeof logsOrUpdater === "function"
          ? logsOrUpdater(state.consoleLogs)
          : logsOrUpdater;
      // Limit logs to prevent memory issues
      return { consoleLogs: newLogs.slice(-MAX_LOGS) };
    }),
  addConsoleLogs: (logs) =>
    set((state) => ({
      consoleLogs: [...state.consoleLogs, ...logs].slice(-MAX_LOGS),
    })),
  addLog: (message, level = "info") =>
    set((state) => {
      const timestamp = new Date().toLocaleTimeString();
      return {
        consoleLogs: [
          ...state.consoleLogs,
          `[${timestamp}] [${level}] ${message}`,
        ].slice(-MAX_LOGS),
      };
    }),
  clearConsoleLogs: () => set({ consoleLogs: [] }),
  setCopied: (copied) => set({ copied }),
  setIsExtending: (isExtending) => set({ isExtending }),
  setIsRestoring: (isRestoring) => set({ isRestoring }),
  setRestoreProgress: (restoreProgress) => set({ restoreProgress }),
  setShowCommitHistory: (showCommitHistory) => set({ showCommitHistory }),
  setIsInitializing: (isInitializing) => set({ isInitializing }),
}));

// ============================================
// APP SLICE - App and setup state
// ============================================
interface AppSlice {
  step: "setup" | "building";
  setupStep: 1 | 2 | 3;
  appData: AppData | null;
  appName: string;
  appDescription: string;
  templateType: TemplateType;
  templatePage: number;
  includeMonetization: boolean;
  includeAnalytics: boolean;
  isGeneratingDescription: boolean;

  setStep: (step: "setup" | "building") => void;
  setSetupStep: (setupStep: 1 | 2 | 3) => void;
  setAppData: (appData: AppData | null) => void;
  setAppName: (appName: string) => void;
  setAppDescription: (appDescription: string) => void;
  setTemplateType: (templateType: TemplateType) => void;
  setTemplatePage: (templatePage: number) => void;
  setIncludeMonetization: (includeMonetization: boolean) => void;
  setIncludeAnalytics: (includeAnalytics: boolean) => void;
  setIsGeneratingDescription: (isGeneratingDescription: boolean) => void;
  resetApp: () => void;
}

export const useApp = create<AppSlice>()((set) => ({
  step: "setup",
  setupStep: 1,
  appData: null,
  appName: "",
  appDescription: "",
  templateType: "blank",
  templatePage: 0,
  includeMonetization: true,
  includeAnalytics: true,
  isGeneratingDescription: false,

  setStep: (step) => set({ step }),
  setSetupStep: (setupStep) => set({ setupStep }),
  setAppData: (appData) => set({ appData }),
  setAppName: (appName) => set({ appName }),
  setAppDescription: (appDescription) => set({ appDescription }),
  setTemplateType: (templateType) => set({ templateType }),
  setTemplatePage: (templatePage) => set({ templatePage }),
  setIncludeMonetization: (includeMonetization) => set({ includeMonetization }),
  setIncludeAnalytics: (includeAnalytics) => set({ includeAnalytics }),
  setIsGeneratingDescription: (isGeneratingDescription) =>
    set({ isGeneratingDescription }),
  resetApp: () =>
    set({
      step: "setup",
      setupStep: 1,
      appData: null,
      appName: "",
      appDescription: "",
      templateType: "blank",
      templatePage: 0,
      includeMonetization: true,
      includeAnalytics: true,
      isGeneratingDescription: false,
    }),
}));

// ============================================
// GIT SLICE - GitHub/Git state
// ============================================
interface GitSlice {
  gitStatus: GitStatusInfo | null;
  isSaving: boolean;
  isDeploying: boolean;
  lastSaveTime: Date | null;
  lastDeployTime: Date | null;
  productionUrl: string | null;
  commitHistory: CommitInfo[];
  snapshotInfo: SnapshotInfo | null;
  appSnapshotInfo: AppSnapshotInfo | null;

  setGitStatus: (gitStatus: GitStatusInfo | null) => void;
  setIsSaving: (isSaving: boolean) => void;
  setIsDeploying: (isDeploying: boolean) => void;
  setLastSaveTime: (lastSaveTime: Date | null) => void;
  setLastDeployTime: (lastDeployTime: Date | null) => void;
  setProductionUrl: (productionUrl: string | null) => void;
  setCommitHistory: (commitHistory: CommitInfo[]) => void;
  setSnapshotInfo: (snapshotInfo: SnapshotInfo | null) => void;
  setAppSnapshotInfo: (appSnapshotInfo: AppSnapshotInfo | null) => void;
  resetGit: () => void;
}

export const useGit = create<GitSlice>()((set) => ({
  gitStatus: null,
  isSaving: false,
  isDeploying: false,
  lastSaveTime: null,
  lastDeployTime: null,
  productionUrl: null,
  commitHistory: [],
  snapshotInfo: null,
  appSnapshotInfo: null,

  setGitStatus: (gitStatus) => set({ gitStatus }),
  setIsSaving: (isSaving) => set({ isSaving }),
  setIsDeploying: (isDeploying) => set({ isDeploying }),
  setLastSaveTime: (lastSaveTime) => set({ lastSaveTime }),
  setLastDeployTime: (lastDeployTime) => set({ lastDeployTime }),
  setProductionUrl: (productionUrl) => set({ productionUrl }),
  setCommitHistory: (commitHistory) => set({ commitHistory }),
  setSnapshotInfo: (snapshotInfo) => set({ snapshotInfo }),
  setAppSnapshotInfo: (appSnapshotInfo) => set({ appSnapshotInfo }),
  resetGit: () =>
    set({
      gitStatus: null,
      isSaving: false,
      isDeploying: false,
      lastSaveTime: null,
      lastDeployTime: null,
      productionUrl: null,
      commitHistory: [],
      snapshotInfo: null,
      appSnapshotInfo: null,
    }),
}));

// ============================================
// SANDBOX HEALTH SLICE - Separate to avoid re-renders
// ============================================
interface SandboxHealthSlice {
  sandboxHealthy: boolean;
  setSandboxHealthy: (healthy: boolean) => void;
}

export const useSandboxHealth = create<SandboxHealthSlice>()((set) => ({
  sandboxHealthy: true,
  setSandboxHealthy: (sandboxHealthy) => set({ sandboxHealthy }),
}));

// ============================================
// MODEL SELECTION SLICE - AI Model selection
// ============================================
interface ModelSelectionSlice {
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  resetModel: () => void;
}

export const useModelSelection = create<ModelSelectionSlice>()((set) => ({
  selectedModel: DEFAULT_APP_BUILDER_MODEL,
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  resetModel: () => set({ selectedModel: DEFAULT_APP_BUILDER_MODEL }),
}));

// ============================================
// COMBINED RESET ACTION
// ============================================
export function resetAllStores() {
  useChatInput.getState().clearInput();
  useMessages.getState().clearMessages();
  useSession.getState().resetSession();
  useUI.getState().clearConsoleLogs();
  useApp.getState().resetApp();
  useGit.getState().resetGit();
  useSandboxHealth.getState().setSandboxHealthy(true);
  useModelSelection.getState().resetModel();
}
