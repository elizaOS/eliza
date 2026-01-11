// @ts-nocheck
// Export all E2E test suites

export { default as ScreenVisionE2ETestSuite } from "./screen-vision";
export { default as VisionAutonomyE2ETestSuite } from "./vision-autonomy";
export { default as VisionBasicE2ETestSuite } from "./vision-basic";
export { default as VisionCaptureLogTestSuite } from "./vision-capture-log";
export { default as VisionRuntimeTestSuite } from "./vision-runtime";
export { default as VisionWorkerE2ETestSuite } from "./vision-worker-tests";

import ScreenVisionE2ETestSuite from "./screen-vision";
import VisionAutonomyE2ETestSuite from "./vision-autonomy";
// Export as array for convenience
import VisionBasicE2ETestSuite from "./vision-basic";
import VisionCaptureLogTestSuite from "./vision-capture-log";
import VisionRuntimeTestSuite from "./vision-runtime";
import VisionWorkerE2ETestSuite from "./vision-worker-tests";

export const testSuites = [
  VisionRuntimeTestSuite, // Real runtime tests first
  VisionBasicE2ETestSuite,
  VisionAutonomyE2ETestSuite,
  VisionCaptureLogTestSuite,
  ScreenVisionE2ETestSuite,
  VisionWorkerE2ETestSuite, // Worker-based tests
];

export default testSuites;
