/** Compile-time and runtime lockstep checks for the public hosted-agent DTO mirrors. */

import { describe, expect, it } from "vitest";
import type {
  AgentDetailDto as UiAgentDetailDto,
  AgentHostingCostDto as UiAgentHostingCostDto,
  AgentHostingSummaryDto as UiAgentHostingSummaryDto,
  AgentListItemDto as UiAgentListItemDto,
  AgentResponse as UiAgentResponse,
  AgentsResponse as UiAgentsResponse,
} from "../../../../../ui/src/cloud-ui/types/cloud-api";
import type {
  AgentDetailDto as SdkAgentDetailDto,
  AgentHostingCostDto as SdkAgentHostingCostDto,
  AgentHostingSummaryDto as SdkAgentHostingSummaryDto,
  AgentListItemDto as SdkAgentListItemDto,
  AgentResponse as SdkAgentResponse,
  AgentsResponse as SdkAgentsResponse,
} from "../../../../sdk/src/types.cloud-api";
import type {
  AgentDetailDto,
  AgentHostingCostDto,
  AgentHostingSummaryDto,
  AgentListItemDto,
  AgentResponse,
  AgentsResponse,
} from "./cloud-api";

type Exact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

const sdkMirrors: [
  Exact<AgentHostingCostDto, SdkAgentHostingCostDto>,
  Exact<AgentHostingSummaryDto, SdkAgentHostingSummaryDto>,
  Exact<AgentListItemDto, SdkAgentListItemDto>,
  Exact<AgentDetailDto, SdkAgentDetailDto>,
  Exact<AgentsResponse, SdkAgentsResponse>,
  Exact<AgentResponse, SdkAgentResponse>,
] = [true, true, true, true, true, true];

const uiMirrors: [
  Exact<AgentHostingCostDto, UiAgentHostingCostDto>,
  Exact<AgentHostingSummaryDto, UiAgentHostingSummaryDto>,
  Exact<AgentListItemDto, UiAgentListItemDto>,
  Exact<AgentDetailDto, UiAgentDetailDto>,
  Exact<AgentsResponse, UiAgentsResponse>,
  Exact<AgentResponse, UiAgentResponse>,
] = [true, true, true, true, true, true];

describe("hosted-agent API DTO mirrors", () => {
  it("keeps the SDK and cloud-ui wire contracts exact", () => {
    expect(sdkMirrors).toEqual([true, true, true, true, true, true]);
    expect(uiMirrors).toEqual([true, true, true, true, true, true]);
  });
});
