/**
 * Mobile computer-use surface — iOS and Android.
 *
 * Apple does not let third-party apps drive other apps. The exports here are
 * the small set of capabilities that *are* possible on iOS, plus the
 * AppIntent registry, the OCR provider chain, and the WS1 pressure-signal
 * contract. See `docs/IOS_CONSTRAINTS.md` for what is and isn't on the table.
 *
 * Android surfaces (WS8): AccessibilityService, MediaProjection, UsageStats,
 * Camera2, onTrimMemory pressure. See `docs/ANDROID_CONSTRAINTS.md`.
 */

export { ANDROID_BRIDGE_JS_NAME, ANDROID_DEFAULT_FPS } from "./android-bridge.js";
export {
  androidAxIdToSceneId,
  normalizeAndroidAxNode,
  parseAndroidAxTree,
  sceneAxToAndroidAxNode,
} from "./android-scene.js";
export {
  emitAndroidAction,
  emitAndroidAgentStep,
  type AndroidActionKind,
  type AndroidTrajectoryActionEvent,
  type AndroidTrajectoryStepEvent,
} from "./android-trajectory.js";
export {
  ANDROID_LOGICAL_DISPLAY_ID,
  MobileScreenCaptureSource,
  type MobileScreenCaptureSourceDeps,
} from "./mobile-screen-capture.js";
export {
  makeMobileComputerInterface,
  MobileComputerInterface,
  type MobileComputerInterfaceDeps,
} from "./mobile-computer-interface.js";
export type {
  AndroidAxNode,
  AndroidBridgeErrorCode,
  AndroidBridgeProbe,
  AndroidBridgeResult,
  AndroidCameraEntry,
  AndroidCameraFrameResult,
  AndroidCameraOpenOptions,
  AndroidCameraOpenResult,
  AndroidComputerUseBridge,
  AndroidMemoryPressureSnapshot,
  AndroidPressureLevel,
  AppUsageEntry,
  CapturedScreenFrame,
  EnumerateAppsResult,
  GestureArgs,
  GlobalAction,
  MediaProjectionHandle,
  MediaProjectionStartOptions,
  SwipeGestureArgs,
  TapGestureArgs,
} from "./android-bridge.js";
export {
  IOS_APP_INTENT_BUNDLE_IDS,
  IOS_APP_INTENT_REGISTRY,
  findIosAppIntent,
  findIosAppIntentsForBundle,
  listIosAppIntents,
} from "./ios-app-intent-registry.js";
export {
  IOS_LOGICAL_DISPLAY_ID,
  IosComputerInterface,
  type IosComputerInterfaceDeps,
  makeIosComputerInterface,
} from "./ios-computer-interface.js";
export {
  IOS_APP_GROUP_ID,
  IOS_BRIDGE_JS_NAME,
  REPLAYKIT_FOREGROUND_MAX_BUFFER,
  REPLAYKIT_FOREGROUND_MAX_SESSION_SEC,
} from "./ios-bridge.js";
export type {
  AccessibilitySnapshotNode,
  AccessibilitySnapshotResult,
  BroadcastHandshakeResult,
  FoundationModelOptions,
  FoundationModelResult,
  IPressureSignal,
  IntentInvocationRequest,
  IntentInvocationResult,
  IntentParameterSpec,
  IntentParameterValue,
  IntentSpec,
  IosBridgeErrorCode,
  IosBridgeProbe,
  IosBridgeResult,
  IosComputerUseBridge,
  MemoryPressureSample,
  ReplayKitForegroundFrame,
  ReplayKitForegroundHandle,
  ReplayKitForegroundOptions,
  VisionOcrLine,
  VisionOcrOptions,
  VisionOcrResult,
} from "./ios-bridge.js";
export {
  _resetOcrProvidersForTests,
  createIosVisionOcrProvider,
  listOcrProviders,
  type OcrInput,
  type OcrLine,
  type OcrProvider,
  type OcrRecognizeOptions,
  type OcrResult,
  registerOcrProvider,
  selectOcrProvider,
  unregisterOcrProvider,
} from "./ocr-provider.js";
