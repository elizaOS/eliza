import { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { UUID } from "@elizaos/core";
import { TEST_DEFINITIONS } from "../../../shared/test-definitions";

interface TestOption {
  id: string;
  label: string;
  description: string;
  steps: number;
}

// Convert test definitions to frontend options
const testOptions: TestOption[] = TEST_DEFINITIONS.tests.map((test: any) => ({
  id: test.testId,
  label: test.name,
  description: `${test.steps.length} step${test.steps.length > 1 ? "s" : ""}: ${test.steps.map((step: any, i: number) => `${i + 1}) ${step.userMessage}`).join(" → ")}`,
  steps: test.steps.length,
}));

const TestSelector: React.FC = () => {
  const [selectedTest, setSelectedTest] = useState<string>(testOptions[0].id);
  const [isLoading, setIsLoading] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);

  const selectedOption = testOptions.find(
    (option) => option.id === selectedTest,
  );

  // Generate a unique client ID (similar to how the main client does it)
  const generateClientId = () => {
    const USER_ID_KEY = "elizaos-client-user-id";
    const existingUserId = localStorage.getItem(USER_ID_KEY);

    if (existingUserId) {
      return existingUserId as UUID;
    }

    const newUserId = uuidv4() as UUID;
    localStorage.setItem(USER_ID_KEY, newUserId);

    return newUserId;
  };

  // Extract channel ID from parent window URL
  const getChannelIdFromParentUrl = (): string | null => {
    try {
      const parentUrl = window.parent.location.href;
      console.log("🔗 Parent URL:", parentUrl);

      // Extract channel ID from URL pattern: /chat/{roomId}/{channelId}
      const match = parentUrl.match(/\/chat\/[^/]+\/([^/?]+)/);
      if (match && match[1]) {
        const channelId = match[1];
        console.log("📋 Extracted channel ID:", channelId);
        return channelId;
      }

      console.warn("⚠️ Could not extract channel ID from parent URL");
      return null;
    } catch (error) {
      console.error("❌ Error accessing parent URL:", error);
      return null;
    }
  };

  // Run test with channel ID from parent URL
  const runTest = async (testType: string) => {
    try {
      const channelId = getChannelIdFromParentUrl();

      if (!channelId) {
        throw new Error("Could not extract channel ID from parent URL");
      }

      const clientId = generateClientId();

      console.log(`🚀 Running test: ${testType} with channel ID: ${channelId}`);

      const requestBody = {
        testType,
        clientId,
        channelId,
        baseUrl: window.location.origin,
      };
      console.log(
        "📤 Test request body:",
        requestBody,
        channelId,
        window.location.origin,
      );

      // Plugin routes are prefixed with plugin name by the runtime
      const pluginRoute = "/plugin-action-bench/action-bench/test";
      console.log("🎯 Using plugin route:", pluginRoute);

      const response = await fetch(pluginRoute, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      console.log("📨 Test response status:", response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Test error response:", errorText);
        throw new Error(
          `Test execution failed: ${response.statusText} - ${errorText}`,
        );
      }

      const responseText = await response.text();
      console.log("📨 Raw response:", responseText);

      let result;
      try {
        result = JSON.parse(responseText);
      } catch (parseError) {
        console.error("❌ JSON parse error:", parseError);
        console.error(
          "❌ Response content:",
          responseText.substring(0, 200) + "...",
        );
        throw new Error(
          `Invalid JSON response: ${responseText.substring(0, 100)}...`,
        );
      }
      console.log("✅ Test completed:", result);

      setLastResult({
        success: result.success,
        message: result.message,
        testResult: result.data?.testResult,
        channelId: result.data?.channelId,
        testType: result.data?.testType,
        timestamp: result.data?.timestamp,
      });
    } catch (error) {
      console.error("❌ Test execution failed:", error);

      setLastResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <section className="bg-card border border-border rounded-lg p-6 mb-8">
      <h2 className="text-2xl font-semibold text-primary mb-6">
        🎯 Benchmark Test
      </h2>

      <div className="space-y-4">
        {/* Dropdown */}
        <div>
          <label
            htmlFor="test-select"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Select Test Scenario
          </label>
          <select
            id="test-select"
            value={selectedTest}
            onChange={(e) => {
              console.log(
                "🔄 Test selection changed, clearing previous results",
              );
              setSelectedTest(e.target.value);
              setLastResult(null); // Clear previous results when changing test
            }}
            className="w-full px-3 py-2 bg-secondary border border-border rounded-md text-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-colors"
          >
            {testOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* Description */}
        {selectedOption && (
          <div className="bg-secondary/50 border border-primary/20 rounded-lg p-4">
            <h3 className="text-primary font-medium mb-2">
              📝 Test Description
            </h3>
            <div className="text-muted-foreground text-sm leading-relaxed space-y-2">
              <p>
                <strong>Steps:</strong> {selectedOption.steps}
              </p>
              <p>
                <strong>Flow:</strong> {selectedOption.description}
              </p>

              {/* Show detailed step breakdown */}
              {(() => {
                const testDef = TEST_DEFINITIONS.tests.find(
                  (t: any) => t.testId === selectedOption.id,
                );
                if (!testDef) return null;

                return (
                  <div className="mt-3 space-y-1">
                    <p className="font-medium text-foreground">Step Details:</p>
                    {testDef.steps.map((step: any, i: number) => (
                      <div
                        key={i}
                        className="text-xs bg-secondary/30 rounded p-2"
                      >
                        <p>
                          <strong>Step {step.stepId}:</strong>{" "}
                          {step.userMessage}
                        </p>
                        <p className="text-muted-foreground mt-1">
                          Actions: [{step.expectedActions.join(", ")}]
                          {step.responseEvaluation.enabled &&
                            " + Response Evaluation"}
                        </p>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Test Result Display */}
        {lastResult && (
          <div
            className={`border rounded-lg p-4 mb-4 ${lastResult.success ? "border-green-500/20 bg-green-500/10" : "border-red-500/20 bg-red-500/10"}`}
          >
            <h4 className="font-medium mb-3">
              {lastResult.success ? "✅ Test Passed" : "❌ Test Failed"}
            </h4>

            <div className="text-sm text-muted-foreground space-y-2">
              <p>
                <strong>Result:</strong> {lastResult.message}
              </p>

              {lastResult.testResult && (
                <div className="bg-secondary/30 rounded p-3 mt-3">
                  <h5 className="font-medium text-foreground mb-2">
                    📊 Test Details
                  </h5>
                  <div className="space-y-1">
                    <p>
                      <strong>Test:</strong> {lastResult.testResult.testName}
                    </p>
                    <p>
                      <strong>Steps:</strong>{" "}
                      {lastResult.testResult.successfulSteps}/
                      {lastResult.testResult.totalSteps} passed (
                      {Math.round(lastResult.testResult.successRate * 100)}%)
                    </p>
                    <p>
                      <strong>Overall:</strong>{" "}
                      {lastResult.testResult.overallPassed
                        ? "PASSED ✅"
                        : "FAILED ❌"}
                    </p>
                  </div>

                  {/* Step-by-step breakdown */}
                  {lastResult.testResult.stepResults &&
                    lastResult.testResult.stepResults.length > 0 && (
                      <div className="mt-3">
                        <h6 className="font-medium text-foreground mb-2">
                          Step Results:
                        </h6>
                        <div className="space-y-2">
                          {lastResult.testResult.stepResults.map(
                            (step: any, index: number) => (
                              <div
                                key={index}
                                className={`text-xs p-2 rounded ${step.passed ? "bg-green-500/10 border border-green-500/20" : "bg-red-500/10 border border-red-500/20"}`}
                              >
                                <div className="flex justify-between items-start">
                                  <span>
                                    <strong>Step {step.stepId}:</strong>{" "}
                                    {step.passed ? "✅" : "❌"}
                                  </span>
                                </div>
                                <p className="mt-1 text-muted-foreground">
                                  Actions: [{step.collectedActions.join(", ")}]
                                </p>
                                <p className="text-muted-foreground">
                                  Result: {step.actionEvaluation.details}
                                </p>
                                {step.responseEvaluation && (
                                  <p className="text-muted-foreground">
                                    Response:{" "}
                                    {step.responseEvaluation.reasoning} (Score:{" "}
                                    {step.responseEvaluation.score})
                                  </p>
                                )}
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                </div>
              )}

              {lastResult.channelId && (
                <p>
                  <strong>Channel ID:</strong> {lastResult.channelId}
                </p>
              )}
              {lastResult.testType && (
                <p>
                  <strong>Test Type:</strong> {lastResult.testType}
                </p>
              )}
              {lastResult.timestamp && (
                <p>
                  <strong>Timestamp:</strong> {lastResult.timestamp}
                </p>
              )}
              {lastResult.error && (
                <p className="text-red-400">
                  <strong>Error:</strong> {lastResult.error}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Start Button */}
        <div className="pt-2">
          <button
            className={`btn-primary w-full sm:w-auto ${isLoading ? "opacity-50 cursor-not-allowed" : ""}`}
            disabled={isLoading}
            onClick={async () => {
              if (isLoading) return;

              setIsLoading(true);
              setLastResult(null);

              try {
                console.log(`🚀 Starting test: ${selectedTest}`);
                await runTest(selectedTest);
                console.log("✅ Test completed successfully!");
              } catch (error) {
                console.error("❌ Test execution failed:", error);
                // Error is already set in runTest function
              } finally {
                setIsLoading(false);
              }
            }}
          >
            {isLoading ? "⏳ Running Test..." : "🚀 Run Test"}
          </button>
        </div>
      </div>
    </section>
  );
};

export default TestSelector;
