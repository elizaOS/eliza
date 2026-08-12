/**
 * Runtime schemas for the hosted-agent API DTOs. Browser query boundaries use
 * these strict schemas so a rolling server with an older or malformed contract
 * becomes an observable load error instead of healthy-looking empty state.
 */

import { z } from "zod";
import type {
  AgentDetailDto,
  AgentHostingCostDto,
  AgentHostingSummaryDto,
  AgentListItemDto,
  AgentResponse,
  AgentsResponse,
} from "./cloud-api";

const finiteNonNegativeNumberSchema = z.number().finite().nonnegative();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nullableStringSchema = z.string().nullable();

export const agentHostingCostSchema = z.discriminatedUnion("rateClass", [
  z
    .object({
      pricingState: z.literal("known"),
      rateClass: z.literal("shared-usage"),
      hourlyRateUsd: z.literal(0),
      monthlyEstimateUsd: z.literal(0),
    })
    .strict(),
  z
    .object({
      pricingState: z.literal("known"),
      rateClass: z.literal("deactivated"),
      hourlyRateUsd: z.literal(0),
      monthlyEstimateUsd: z.literal(0),
    })
    .strict(),
  z
    .object({
      pricingState: z.literal("known"),
      rateClass: z.literal("running"),
      hourlyRateUsd: finiteNonNegativeNumberSchema,
      monthlyEstimateUsd: finiteNonNegativeNumberSchema,
    })
    .strict(),
  z
    .object({
      pricingState: z.literal("known"),
      rateClass: z.literal("idle"),
      hourlyRateUsd: finiteNonNegativeNumberSchema,
      monthlyEstimateUsd: finiteNonNegativeNumberSchema,
    })
    .strict(),
  z
    .object({
      pricingState: z.literal("unavailable"),
      rateClass: z.literal("unavailable"),
      hourlyRateUsd: z.null(),
      monthlyEstimateUsd: z.null(),
    })
    .strict(),
]) satisfies z.ZodType<AgentHostingCostDto>;

const agentHostingSummaryBaseSchema = z
  .object({
    sharedCount: nonNegativeIntegerSchema,
    dedicatedRunningCount: nonNegativeIntegerSchema,
    dedicatedIdleCount: nonNegativeIntegerSchema,
    dedicatedDeactivatedCount: nonNegativeIntegerSchema,
    hasAgents: z.boolean(),
    hasDedicatedHosting: z.boolean(),
    creditBalanceUsd: z.number().finite(),
    dedicatedRunningHourlyRateUsd: finiteNonNegativeNumberSchema,
    dedicatedRunningMonthlyEstimateUsd: finiteNonNegativeNumberSchema,
    dedicatedIdleHourlyRateUsd: finiteNonNegativeNumberSchema,
    dedicatedIdleMonthlyEstimateUsd: finiteNonNegativeNumberSchema,
    minimumDepositUsd: finiteNonNegativeNumberSchema,
    lowCreditWarningUsd: finiteNonNegativeNumberSchema,
  })
  .strict();

export const agentHostingSummarySchema = z.discriminatedUnion("pricingState", [
  agentHostingSummaryBaseSchema
    .extend({
      pricingState: z.literal("complete"),
      unavailableDedicatedCount: z.literal(0),
      hourlyHostingCostUsd: finiteNonNegativeNumberSchema,
      monthlyHostingCostUsd: finiteNonNegativeNumberSchema,
      hoursRemaining: nonNegativeIntegerSchema.nullable(),
      lowBalance: z.boolean(),
    })
    .strict(),
  agentHostingSummaryBaseSchema
    .extend({
      pricingState: z.literal("incomplete"),
      unavailableDedicatedCount: z.number().int().positive(),
      hourlyHostingCostUsd: z.null(),
      monthlyHostingCostUsd: z.null(),
      hoursRemaining: z.null(),
      lowBalance: z.null(),
    })
    .strict(),
]) satisfies z.ZodType<AgentHostingSummaryDto>;

const agentListItemShape = {
  id: z.string().min(1),
  agentName: nullableStringSchema,
  status: z.enum([
    "pending",
    "provisioning",
    "running",
    "stopped",
    "sleeping",
    "disconnected",
    "error",
    "deletion_pending",
    "deletion_failed",
  ]),
  databaseStatus: z.enum(["none", "provisioning", "ready", "error"]),
  lastBackupAt: nullableStringSchema,
  lastHeartbeatAt: nullableStringSchema,
  errorMessage: nullableStringSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  token_address: nullableStringSchema,
  token_chain: nullableStringSchema,
  token_name: nullableStringSchema,
  token_ticker: nullableStringSchema,
  dockerImage: nullableStringSchema,
  executionTier: z.enum(["shared", "dedicated-lazy", "dedicated-always", "custom"]),
  hostingCost: agentHostingCostSchema,
  webUiUrl: nullableStringSchema,
} satisfies z.ZodRawShape;

export const agentListItemSchema = z
  .object(agentListItemShape)
  .strict() satisfies z.ZodType<AgentListItemDto>;

const agentAdminDetailsSchema = z
  .object({
    nodeId: nullableStringSchema,
    containerName: nullableStringSchema,
    headscaleIp: nullableStringSchema,
    bridgePort: z.number().int().nullable(),
    webUiPort: z.number().int().nullable(),
    dockerImage: nullableStringSchema,
    isDockerBacked: z.boolean(),
    webUiUrl: nullableStringSchema,
    sshCommand: nullableStringSchema,
  })
  .strict();

export const agentDetailSchema = z
  .object({
    ...agentListItemShape,
    bridgeUrl: nullableStringSchema,
    errorCount: nonNegativeIntegerSchema,
    walletAddress: nullableStringSchema,
    walletProvider: nullableStringSchema,
    walletStatus: z.enum(["active", "pending", "none", "error"]),
    adminDetails: agentAdminDetailsSchema.nullable(),
  })
  .strict() satisfies z.ZodType<AgentDetailDto>;

export const agentsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.array(agentListItemSchema),
    hostingSummary: agentHostingSummarySchema,
  })
  .strict() satisfies z.ZodType<AgentsResponse>;

export const agentResponseSchema = z
  .object({
    success: z.literal(true),
    data: agentDetailSchema,
  })
  .strict() satisfies z.ZodType<AgentResponse>;
