/**
 * Keyless scenario asserting the agent-addressable surface of an active view:
 * the agent reaches a scenario ledger view's registered controls and produces a
 * trajectory over them. Runs on the pr-deterministic lane under the model provider.
 */
import {
  registerPluginViews,
  unregisterPluginViews,
} from "@elizaos/agent/api/views-registry";
import {
  handleViewsRoutes,
  type ViewsRouteContext,
} from "@elizaos/agent/api/views-routes";
import { installPromptOptimizations } from "@elizaos/agent/runtime/prompt-optimization";
import {
  clearActiveViewContext,
  setActiveViewContext,
  setActiveViewElements,
} from "@elizaos/agent/runtime/view-action-affinity";
import type { IAgentRuntime, ViewDeclaration } from "@elizaos/core";
import type { HttpPlugin as Plugin, Route, RouteRequest, RouteResponse } from "@elizaos/shared/api/http-plugin";
import { ModelType } from "@elizaos/core";
import type {
  DeterministicModelCall,
  DeterministicModelFixture,
} from "@elizaos/testing";
