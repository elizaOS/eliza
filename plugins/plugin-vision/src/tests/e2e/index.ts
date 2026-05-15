import ScreenVisionE2ETestSuite from "./screen-vision";
import VisionBasicE2ETestSuite from "./vision-basic";
import VisionCaptureLogTestSuite from "./vision-capture-log";
import VisionRuntimeTestSuite from "./vision-runtime";
import VisionWorkerE2ETestSuite from "./vision-worker-tests";

export const testSuites = [
  VisionRuntimeTestSuite, // Real runtime tests first
  VisionBasicE2ETestSuite,
  VisionCaptureLogTestSuite,
  ScreenVisionE2ETestSuite,
  VisionWorkerE2ETestSuite, // Worker-based tests
];
