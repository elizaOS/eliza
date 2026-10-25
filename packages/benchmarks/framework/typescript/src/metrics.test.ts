import { expect, test } from "bun:test";
import { PipelineTimer } from "./metrics.ts";

test("model wall time counts overlapping and nested calls only once", () => {
  const timer = new PipelineTimer();
  timer.recordInterval("model_call", 10, 30);
  timer.recordInterval("model_call", 20, 40);
  timer.recordInterval("model_call", 21, 25);
  timer.recordInterval("model_call", 50, 60);
  timer.recordInterval("compose_state", 0, 65);
  const result = timer.getBreakdown();
  expect(result.model_time_total_ms).toBe(40);
  expect(result.model_call_avg_ms).toBe(13.5);
  expect(result.compose_state_avg_ms).toBe(65);
  expect(result.provider_execution_avg_ms).toBeNull();
  timer.reset();
  expect(timer.getBreakdown().model_time_total_ms).toBe(0);
});
