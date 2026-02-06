/**
 * Container Metrics API
 * Fetches CloudWatch metrics for ECS containers
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getContainer } from "@/lib/services/containers";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";

export const dynamic = "force-dynamic";

interface ContainerMetrics {
  cpu_utilization: number;
  memory_utilization: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  task_count: number;
  healthy_task_count: number;
  timestamp: string;
}

/**
 * GET /api/v1/containers/[id]/metrics
 * Retrieves CloudWatch metrics for a container including CPU, memory, network, and task counts.
 *
 * @param request - Request with optional period query parameter (minutes, default: 60).
 * @param params - Route parameters containing the container ID.
 * @returns Container metrics with utilization data.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    // Verify container belongs to user's organization
    const container = await getContainer(id, user.organization_id!);

    if (!container) {
      return NextResponse.json(
        {
          success: false,
          error: "Container not found",
        },
        { status: 404 },
      );
    }

    // Check if container has been deployed
    if (!container.ecs_service_arn || !container.ecs_cluster_arn) {
      return NextResponse.json(
        {
          success: false,
          error: "Container has not been deployed to ECS yet",
        },
        { status: 400 },
      );
    }

    // Get query parameters
    const searchParams = request.nextUrl.searchParams;
    const periodMinutes = parseInt(searchParams.get("period") || "60");

    // Fetch metrics from CloudWatch
    const metrics = await getContainerMetrics(
      {
        id: container.id,
        name: container.name,
        user_id: container.user_id,
        ecs_cluster_arn: container.ecs_cluster_arn,
        ecs_service_arn: container.ecs_service_arn,
        desired_count: container.desired_count || 1,
      },
      periodMinutes,
    );

    return NextResponse.json({
      success: true,
      data: {
        container: {
          id: container.id,
          name: container.name,
          status: container.status,
        },
        metrics,
        period_minutes: periodMinutes,
      },
    });
  } catch (error) {
    logger.error("Error fetching container metrics:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch container metrics",
      },
      { status: 500 },
    );
  }
}

/**
 * Get CloudWatch metrics for a container
 */
async function getContainerMetrics(
  container: {
    id: string;
    name: string;
    user_id: string;
    ecs_cluster_arn: string;
    ecs_service_arn: string;
    desired_count: number;
  },
  periodMinutes: number,
): Promise<ContainerMetrics> {
  const region = process.env.AWS_REGION || "us-east-1";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS credentials not configured");
  }

  const client = new CloudWatchClient({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const now = new Date();
  const startTime = new Date(now.getTime() - periodMinutes * 60 * 1000);

  // Extract cluster and service names from ARNs
  const clusterName = container.ecs_cluster_arn.split("/").pop() || "";
  const serviceName = container.ecs_service_arn.split("/").pop() || "";

  // Fetch multiple metrics in parallel
  const [cpuData, memoryData, networkRxData, networkTxData] =
    await Promise.allSettled([
      fetchMetric(
        client,
        "CPUUtilization",
        clusterName,
        serviceName,
        startTime,
        now,
      ),
      fetchMetric(
        client,
        "MemoryUtilization",
        clusterName,
        serviceName,
        startTime,
        now,
      ),
      fetchMetric(
        client,
        "NetworkRxBytes",
        clusterName,
        serviceName,
        startTime,
        now,
      ),
      fetchMetric(
        client,
        "NetworkTxBytes",
        clusterName,
        serviceName,
        startTime,
        now,
      ),
    ]);

  // Extract values with fallbacks
  const cpu_utilization =
    cpuData.status === "fulfilled" && cpuData.value ? cpuData.value : 0;
  const memory_utilization =
    memoryData.status === "fulfilled" && memoryData.value
      ? memoryData.value
      : 0;
  const network_rx_bytes =
    networkRxData.status === "fulfilled" && networkRxData.value
      ? networkRxData.value
      : 0;
  const network_tx_bytes =
    networkTxData.status === "fulfilled" && networkTxData.value
      ? networkTxData.value
      : 0;

  return {
    cpu_utilization,
    memory_utilization,
    network_rx_bytes,
    network_tx_bytes,
    task_count: container.desired_count,
    // Healthy task count approximation: assumes all tasks are healthy if no CloudWatch alarms
    // For accurate health status, query ECS DescribeServices API or check ALB target health
    healthy_task_count: container.desired_count,
    timestamp: now.toISOString(),
  };
}

/**
 * Fetch a specific CloudWatch metric
 */
async function fetchMetric(
  client: CloudWatchClient,
  metricName: string,
  clusterName: string,
  serviceName: string,
  startTime: Date,
  endTime: Date,
): Promise<number> {
  try {
    const command = new GetMetricStatisticsCommand({
      Namespace: "AWS/ECS",
      MetricName: metricName,
      Dimensions: [
        {
          Name: "ServiceName",
          Value: serviceName,
        },
        {
          Name: "ClusterName",
          Value: clusterName,
        },
      ],
      StartTime: startTime,
      EndTime: endTime,
      Period: 300, // 5 minutes
      Statistics: ["Average"],
    });

    const response = await client.send(command);
    const datapoints = response.Datapoints || [];

    if (datapoints.length === 0) {
      return 0;
    }

    // Get the latest datapoint
    const latest = datapoints.reduce((prev, current) => {
      return (current.Timestamp || new Date(0)) >
        (prev.Timestamp || new Date(0))
        ? current
        : prev;
    });

    return latest.Average || 0;
  } catch (error) {
    logger.error(`Failed to fetch ${metricName}:`, error);
    return 0;
  }
}
