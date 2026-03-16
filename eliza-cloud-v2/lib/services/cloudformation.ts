/**
 * AWS CloudFormation Service - Production Ready
 *
 * Provisions and manages per-user CloudFormation stacks with:
 * - ALB priority management
 * - Retry logic
 * - Better error handling
 * - Cost tracking
 */

import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  UpdateStackCommand,
  DescribeStacksCommand,
  DescribeStackEventsCommand,
  type Stack,
  type StackStatus,
} from "@aws-sdk/client-cloudformation";
import { logger } from "@/lib/utils/logger";
import * as fs from "node:fs";
import * as path from "node:path";
import { dbPriorityManager } from "./alb-priority-manager";

/**
 * Configuration for a user's CloudFormation stack.
 */
export interface UserStackConfig {
  userId: string;
  projectName: string; // Project name for multi-project support
  userEmail: string;
  containerImage: string;
  containerPort: number;
  containerCpu: number;
  containerMemory: number;
  architecture?: "arm64" | "x86_64"; // CPU architecture for instance type selection
  keyName?: string;
  environmentVars?: Record<string, string>;
}

/**
 * Outputs from a CloudFormation stack.
 */
export interface StackOutputs {
  clusterName: string;
  clusterArn: string;
  instanceId: string;
  instancePublicIp: string;
  instancePublicDns: string;
  directAccessUrl: string;
  serviceArn: string;
  taskDefinitionArn: string;
  targetGroupArn: string;
  containerUrl: string;
}

/**
 * CloudFormation Stack Manager for Per-User Deployments - Production Ready
 */
export class CloudFormationService {
  private client: CloudFormationClient;
  private region: string;
  private environment: string;
  private templatePath: string;

  constructor() {
    this.region = process.env.AWS_REGION || "us-east-1";
    this.environment = process.env.ENVIRONMENT || "production";

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    // Allow instantiation without credentials for build time
    // Credentials will be validated on first use
    if (accessKeyId && secretAccessKey) {
      this.client = new CloudFormationClient({
        region: this.region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    } else {
      // Placeholder client for build time - will fail at runtime if used
      this.client = new CloudFormationClient({ region: this.region });
    }

    // Use production template with monitoring
    // Try multiple paths for better compatibility across environments
    const possiblePaths = [
      // Vercel deployment (relative to project root)
      path.join(process.cwd(), "scripts/cloudformation/per-user-stack.json"),
      // Local development (from lib/services/)
      path.join(__dirname, "../../scripts/cloudformation/per-user-stack.json"),
      // Build output (from .next/server/)
      path.join(
        __dirname,
        "../../../scripts/cloudformation/per-user-stack.json",
      ),
    ];

    // Find the first path that exists
    this.templatePath =
      possiblePaths.find((p) => fs.existsSync(p)) || possiblePaths[0];
  }

  /**
   * Validate that the CloudFormation template file exists
   */
  private validateTemplateExists(): void {
    if (!fs.existsSync(this.templatePath)) {
      throw new Error(
        `CloudFormation template not found at: ${this.templatePath}. ` +
          `Expected location: scripts/cloudformation/per-user-stack.json from project root. ` +
          `Current working directory: ${process.cwd()}`,
      );
    }
  }

  /**
   * Ensure AWS credentials are configured before making API calls
   */
  private ensureCredentials(): void {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
      );
    }

    // Re-initialize client if it was created without credentials
    if (!this.client.config.credentials) {
      this.client = new CloudFormationClient({
        region: this.region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    }
  }

  /**
   * Get stack name for a user and project
   * Supports multiple projects per user by including projectName
   */
  getStackName(userId: string, projectName: string): string {
    // Sanitize project name for CloudFormation stack naming
    const sanitizedProject = projectName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 30); // Limit length for stack name constraints

    return `elizaos-${userId}-${sanitizedProject}`;
  }

  /**
   * Retry helper for CloudFormation operations
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 1000,
  ): Promise<T> {
    logger.info(
      `[CloudFormation withRetry] Starting operation with ${maxRetries} max retries`,
    );
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(
          `[CloudFormation withRetry] Attempt ${attempt}/${maxRetries}`,
        );
        const result = await operation();
        logger.info(`[CloudFormation withRetry] Attempt ${attempt} succeeded`);
        return result;
      } catch (error: unknown) {
        // Don't retry validation errors
        if (error instanceof Error && error.name === "ValidationError") {
          logger.error(
            `[CloudFormation withRetry] ValidationError, not retrying:`,
            error.message,
          );
          throw error;
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `[CloudFormation withRetry] Attempt ${attempt}/${maxRetries} failed:`,
          errorMessage,
        );

        if (attempt === maxRetries) {
          logger.error(
            `[CloudFormation withRetry] All ${maxRetries} attempts failed, throwing error`,
          );
          throw error;
        }

        const backoffDelay = delayMs * Math.pow(2, attempt - 1);
        console.warn(
          `CloudFormation operation failed (attempt ${attempt}/${maxRetries}), retrying in ${backoffDelay}ms...`,
          errorMessage,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
      }
    }
    throw new Error("Max retries exceeded");
  }

  /**
   * Create a new CloudFormation stack for a user with ALB priority management
   */
  async createUserStack(config: UserStackConfig): Promise<string> {
    this.ensureCredentials();
    this.validateTemplateExists();

    return this.withRetry(async () => {
      const stackName = this.getStackName(config.userId, config.projectName);

      // Allocate unique ALB priority per user+project combination
      const albPriority = await dbPriorityManager.allocatePriority(
        config.userId,
        config.projectName,
      );
      logger.info(
        `Allocated ALB priority ${albPriority} for ${config.userId}/${config.projectName}`,
      );

      // Load template and parse as JSON for dynamic modification
      const templateJson = JSON.parse(
        fs.readFileSync(this.templatePath, "utf-8"),
      );

      // Inject environment variables into container definition if provided
      if (
        config.environmentVars &&
        Object.keys(config.environmentVars).length > 0
      ) {
        const envArray = Object.entries(config.environmentVars).map(
          ([name, value]) => ({
            Name: name,
            Value: value,
          }),
        );

        // Find the TaskDefinition resource and inject environment variables
        if (
          templateJson.Resources?.TaskDefinition?.Properties
            ?.ContainerDefinitions?.[0]
        ) {
          templateJson.Resources.TaskDefinition.Properties.ContainerDefinitions[0].Environment =
            envArray;
          logger.info(
            `Injected ${envArray.length} environment variables into task definition`,
          );
        }
      }

      // Convert modified template back to string
      const templateBody = JSON.stringify(templateJson);

      // Get shared infrastructure outputs
      const sharedOutputs = await this.getSharedInfrastructureOutputs();

      const command = new CreateStackCommand({
        StackName: stackName,
        TemplateBody: templateBody,
        Capabilities: ["CAPABILITY_NAMED_IAM"], // Required for IAM role creation
        Parameters: [
          { ParameterKey: "UserId", ParameterValue: config.userId },
          { ParameterKey: "ProjectName", ParameterValue: config.projectName },
          { ParameterKey: "UserEmail", ParameterValue: config.userEmail },
          {
            ParameterKey: "ContainerImage",
            ParameterValue: config.containerImage,
          },
          {
            ParameterKey: "ContainerPort",
            ParameterValue: config.containerPort.toString(),
          },
          {
            ParameterKey: "ContainerCpu",
            ParameterValue: config.containerCpu.toString(),
          },
          {
            ParameterKey: "ContainerMemory",
            ParameterValue: config.containerMemory.toString(),
          },
          {
            ParameterKey: "Architecture",
            // Translate x86_64 to amd64 for CloudFormation (underscores not allowed in mapping keys)
            ParameterValue:
              config.architecture === "x86_64"
                ? "amd64"
                : config.architecture || "arm64",
          },
          { ParameterKey: "SharedVPCId", ParameterValue: sharedOutputs.vpcId },
          {
            ParameterKey: "SharedSubnetId",
            ParameterValue: sharedOutputs.subnetId,
          },
          {
            ParameterKey: "SharedALBArn",
            ParameterValue: sharedOutputs.albArn,
          },
          {
            ParameterKey: "SharedListenerArn",
            ParameterValue: sharedOutputs.listenerArn,
          },
          {
            ParameterKey: "ECSExecutionRoleArn",
            ParameterValue: sharedOutputs.executionRoleArn,
          },
          {
            ParameterKey: "ECSTaskRoleArn",
            ParameterValue: sharedOutputs.taskRoleArn,
          },
          {
            ParameterKey: "SharedALBSecurityGroupId",
            ParameterValue: sharedOutputs.albSecurityGroupId,
          },
          { ParameterKey: "KeyName", ParameterValue: config.keyName || "" },
          {
            ParameterKey: "ListenerRulePriority",
            ParameterValue: albPriority.toString(),
          },
        ],
        Tags: [
          { Key: "UserId", Value: config.userId },
          { Key: "ProjectName", Value: config.projectName },
          { Key: "UserEmail", Value: config.userEmail },
          { Key: "ManagedBy", Value: "elizaOS" },
          { Key: "Environment", Value: this.environment },
          { Key: "BillingEntity", Value: "elizaOS" },
          { Key: "CostCenter", Value: config.userId },
        ],
        OnFailure: "ROLLBACK",
      });

      try {
        const response = await this.client.send(command);
        return response.StackId!;
      } catch (createError) {
        logger.error(`❌ [CloudFormation] CreateStack API call failed:`, {
          error:
            createError instanceof Error
              ? createError.message
              : String(createError),
          stack: createError instanceof Error ? createError.stack : undefined,
          name: createError instanceof Error ? createError.name : undefined,
        });
        throw createError;
      }
    });
  }

  /**
   * Update an existing CloudFormation stack for a user
   * This is used when re-deploying an existing project
   */
  async updateUserStack(config: UserStackConfig): Promise<string> {
    this.ensureCredentials();
    this.validateTemplateExists();

    return this.withRetry(async () => {
      const stackName = this.getStackName(config.userId, config.projectName);

      // Load template and parse as JSON for dynamic modification
      const templateJson = JSON.parse(
        fs.readFileSync(this.templatePath, "utf-8"),
      );

      // Inject environment variables into container definition if provided
      if (
        config.environmentVars &&
        Object.keys(config.environmentVars).length > 0
      ) {
        const envArray = Object.entries(config.environmentVars).map(
          ([name, value]) => ({
            Name: name,
            Value: value,
          }),
        );

        // Find the TaskDefinition resource and inject environment variables
        if (
          templateJson.Resources?.TaskDefinition?.Properties
            ?.ContainerDefinitions?.[0]
        ) {
          templateJson.Resources.TaskDefinition.Properties.ContainerDefinitions[0].Environment =
            envArray;
          logger.info(
            `Injected ${envArray.length} environment variables into task definition for update`,
          );
        }
      }

      // Convert modified template back to string
      const templateBody = JSON.stringify(templateJson);

      // Get shared infrastructure outputs
      const sharedOutputs = await this.getSharedInfrastructureOutputs();

      // Get current ALB priority for this stack (don't allocate a new one for updates)
      const currentStack = await this.getStack(
        config.userId,
        config.projectName,
      );
      let albPriority: number;

      if (!currentStack) {
        throw new Error(`Stack ${stackName} not found for update`);
      }

      // Extract ALB priority from existing stack parameters
      const priorityParam = currentStack.Parameters?.find(
        (p) => p.ParameterKey === "ListenerRulePriority",
      );
      if (priorityParam?.ParameterValue) {
        albPriority = parseInt(priorityParam.ParameterValue, 10);
      } else {
        throw new Error(
          `Unable to find existing ALB priority for stack ${stackName}`,
        );
      }

      const command = new UpdateStackCommand({
        StackName: stackName,
        TemplateBody: templateBody,
        Capabilities: ["CAPABILITY_NAMED_IAM"], // Required for IAM role creation
        Parameters: [
          { ParameterKey: "UserId", ParameterValue: config.userId },
          { ParameterKey: "ProjectName", ParameterValue: config.projectName },
          { ParameterKey: "UserEmail", ParameterValue: config.userEmail },
          {
            ParameterKey: "ContainerImage",
            ParameterValue: config.containerImage,
          },
          {
            ParameterKey: "ContainerPort",
            ParameterValue: config.containerPort.toString(),
          },
          {
            ParameterKey: "ContainerCpu",
            ParameterValue: config.containerCpu.toString(),
          },
          {
            ParameterKey: "ContainerMemory",
            ParameterValue: config.containerMemory.toString(),
          },
          {
            ParameterKey: "Architecture",
            // Translate x86_64 to amd64 for CloudFormation (underscores not allowed in mapping keys)
            ParameterValue:
              config.architecture === "x86_64"
                ? "amd64"
                : config.architecture || "arm64",
          },
          { ParameterKey: "SharedVPCId", ParameterValue: sharedOutputs.vpcId },
          {
            ParameterKey: "SharedSubnetId",
            ParameterValue: sharedOutputs.subnetId,
          },
          {
            ParameterKey: "SharedALBArn",
            ParameterValue: sharedOutputs.albArn,
          },
          {
            ParameterKey: "SharedListenerArn",
            ParameterValue: sharedOutputs.listenerArn,
          },
          {
            ParameterKey: "ECSExecutionRoleArn",
            ParameterValue: sharedOutputs.executionRoleArn,
          },
          {
            ParameterKey: "ECSTaskRoleArn",
            ParameterValue: sharedOutputs.taskRoleArn,
          },
          {
            ParameterKey: "SharedALBSecurityGroupId",
            ParameterValue: sharedOutputs.albSecurityGroupId,
          },
          { ParameterKey: "KeyName", ParameterValue: config.keyName || "" },
          {
            ParameterKey: "ListenerRulePriority",
            ParameterValue: albPriority.toString(),
          },
        ],
        Tags: [
          { Key: "UserId", Value: config.userId },
          { Key: "ProjectName", Value: config.projectName },
          { Key: "UserEmail", Value: config.userEmail },
          { Key: "ManagedBy", Value: "elizaOS" },
          { Key: "Environment", Value: this.environment },
          { Key: "BillingEntity", Value: "elizaOS" },
          { Key: "CostCenter", Value: config.userId },
        ],
      });

      const response = await this.client.send(command);
      logger.info(`✅ Stack update initiated for ${stackName}`);
      return response.StackId!;
    });
  }

  /**
   * Wait for stack to reach a complete state
   */
  async waitForStackComplete(
    userId: string,
    projectName: string,
    timeoutMinutes: number = 15,
  ): Promise<StackStatus> {
    const stackName = this.getStackName(userId, projectName);
    const startTime = Date.now();
    const timeoutMs = timeoutMinutes * 60 * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const stack = await this.getStack(userId, projectName);

      if (!stack) {
        throw new Error(`Stack ${stackName} not found`);
      }

      const status = stack.StackStatus;

      // Terminal success states
      if (status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE") {
        logger.info(`Stack ${stackName} completed successfully`);
        return status;
      }

      // Terminal failure states
      if (
        status === "CREATE_FAILED" ||
        status === "ROLLBACK_COMPLETE" ||
        status === "ROLLBACK_FAILED" ||
        status === "DELETE_COMPLETE" ||
        status === "DELETE_FAILED"
      ) {
        // Get detailed failure reason from stack events
        const failureDetails = await this.getStackFailureDetails(stackName);
        const failureReason = stack.StackStatusReason || "Unknown failure";

        logger.error(`❌ [CloudFormation] Stack ${stackName} failed:`, {
          status,
          reason: failureReason,
          failedResources: failureDetails,
        });

        const failureMessage =
          failureDetails.length > 0
            ? failureDetails
                .map((f) => `\n  • ${f.resource}: ${f.reason}`)
                .join("")
            : "\n  (No detailed failure events found - check AWS CloudFormation console)";

        throw new Error(
          `CloudFormation stack failed with status: ${status}\n` +
            `Stack reason: ${failureReason}\n` +
            `Failed resources:${failureMessage}`,
        );
      }

      // Still in progress, wait and retry
      logger.info(`Stack ${stackName} status: ${status}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
    }

    throw new Error(
      `Stack ${stackName} creation timeout after ${timeoutMinutes} minutes`,
    );
  }

  /**
   * Get detailed failure reasons from stack events
   */
  async getStackFailureDetails(
    stackName: string,
  ): Promise<Array<{ resource: string; reason: string; status: string }>> {
    try {
      const command = new DescribeStackEventsCommand({
        StackName: stackName,
      });

      const response = await this.client.send(command);
      const events = response.StackEvents || [];

      // Find CREATE_FAILED events (these are the actual failures, not rollback events)
      const failedEvents = events.filter((event) => {
        const isFailed = event.ResourceStatus === "CREATE_FAILED";
        const isNotStack = event.ResourceType !== "AWS::CloudFormation::Stack";
        return isFailed && isNotStack; // Only resource failures, not stack-level status
      });

      // If no CREATE_FAILED, also check for rollback events to get more context
      if (failedEvents.length === 0) {
        const rollbackEvents = events
          .filter(
            (event) =>
              event.ResourceStatus?.includes("ROLLBACK") &&
              event.ResourceType !== "AWS::CloudFormation::Stack",
          )
          .slice(0, 10);

        return rollbackEvents.map((event) => ({
          resource:
            `${event.LogicalResourceId} (${event.ResourceType})` || "Unknown",
          reason: event.ResourceStatusReason || "No reason provided",
          status: event.ResourceStatus || "Unknown",
        }));
      }

      return failedEvents
        .slice(0, 10) // Get top 10 failures
        .map((event) => ({
          resource:
            `${event.LogicalResourceId} (${event.ResourceType})` || "Unknown",
          reason: event.ResourceStatusReason || "No reason provided",
          status: event.ResourceStatus || "Unknown",
        }));
    } catch (error) {
      logger.error("Failed to get stack failure details", { stackName, error });
      return [];
    }
  }

  /**
   * Get stack details
   * Returns null if the stack doesn't exist
   */
  async getStack(userId: string, projectName: string): Promise<Stack | null> {
    this.ensureCredentials();

    const stackName = this.getStackName(userId, projectName);

    try {
      const command = new DescribeStacksCommand({
        StackName: stackName,
      });

      const response = await this.client.send(command);
      return response.Stacks?.[0] || null;
    } catch (error: unknown) {
      // AWS throws ValidationError if stack doesn't exist
      if (
        error instanceof Error &&
        (error.name === "ValidationError" ||
          error.message.includes("does not exist"))
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get stack outputs
   */
  async getStackOutputs(
    userId: string,
    projectName: string,
  ): Promise<StackOutputs | null> {
    const stack = await this.getStack(userId, projectName);

    if (!stack || !stack.Outputs) {
      return null;
    }

    const getOutput = (key: string): string => {
      const output = stack.Outputs!.find((o) => o.OutputKey === key);
      return output?.OutputValue || "";
    };

    return {
      clusterName: getOutput("ClusterName"),
      clusterArn: getOutput("ClusterArn"),
      instanceId: getOutput("EC2InstanceId"),
      instancePublicIp: getOutput("EC2InstancePublicIP"),
      instancePublicDns: getOutput("EC2InstancePublicDNS"),
      directAccessUrl: getOutput("DirectAccessUrl"),
      serviceArn: getOutput("ServiceArn"),
      taskDefinitionArn: getOutput("TaskDefinitionArn"),
      targetGroupArn: getOutput("TargetGroupArn"),
      containerUrl: getOutput("ContainerUrl"),
    };
  }

  /**
   * Delete a user's stack and release ALB priority
   */
  async deleteUserStack(userId: string, projectName: string): Promise<void> {
    this.ensureCredentials();

    return this.withRetry(async () => {
      const stackName = this.getStackName(userId, projectName);

      const command = new DeleteStackCommand({
        StackName: stackName,
      });

      await this.client.send(command);
      logger.info(`Stack deletion initiated: ${stackName}`);

      // Release ALB priority after stack deletion initiated
      // This will set expiry timestamp for cleanup
      await dbPriorityManager.releasePriority(userId, projectName);
    });
  }

  /**
   * Wait for stack deletion
   */
  async waitForStackDeletion(
    userId: string,
    projectName: string,
    timeoutMinutes: number = 15,
  ): Promise<void> {
    const stackName = this.getStackName(userId, projectName);
    const startTime = Date.now();
    const timeoutMs = timeoutMinutes * 60 * 1000;

    while (Date.now() - startTime < timeoutMs) {
      const stack = await this.getStack(userId, projectName);

      if (!stack) {
        logger.info(`Stack ${stackName} deleted successfully`);
        return;
      }

      const status = stack.StackStatus;

      if (status === "DELETE_FAILED") {
        const failureReason = stack.StackStatusReason || "Unknown failure";
        throw new Error(
          `Stack ${stackName} deletion failed. Reason: ${failureReason}`,
        );
      }

      logger.info(
        `Stack ${stackName} status: ${status}, waiting for deletion...`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    throw new Error(
      `Stack ${stackName} deletion timeout after ${timeoutMinutes} minutes`,
    );
  }

  /**
   * Get shared infrastructure outputs (VPC, ALB, IAM roles)
   */
  private async getSharedInfrastructureOutputs(): Promise<{
    vpcId: string;
    subnetId: string;
    albArn: string;
    listenerArn: string;
    executionRoleArn: string;
    taskRoleArn: string;
    albSecurityGroupId: string;
  }> {
    const sharedStackName = `${this.environment}-elizaos-shared`;

    try {
      const command = new DescribeStacksCommand({
        StackName: sharedStackName,
      });

      const response = await this.client.send(command);
      const stack = response.Stacks?.[0];

      if (!stack || !stack.Outputs) {
        throw new Error(
          `Shared infrastructure stack not found: ${sharedStackName}. Deploy it first using deploy-shared.sh`,
        );
      }

      const getOutput = (key: string): string => {
        const output = stack.Outputs!.find((o) => o.OutputKey === key);
        if (!output?.OutputValue) {
          throw new Error(
            `Missing output ${key} in shared infrastructure stack`,
          );
        }
        return output.OutputValue;
      };

      return {
        vpcId: getOutput("VPCId"),
        subnetId: getOutput("PublicSubnet1Id"),
        albArn: getOutput("SharedALBArn"),
        listenerArn: getOutput("HTTPSListenerArn"),
        executionRoleArn: getOutput("ECSTaskExecutionRoleArn"),
        taskRoleArn: getOutput("ECSTaskRoleArn"),
        albSecurityGroupId: getOutput("ALBSecurityGroupId"),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        "Failed to get shared infrastructure outputs:",
        errorMessage,
      );
      throw new Error(
        `Cannot provision user stack: shared infrastructure not deployed. Run deploy-shared.sh first.`,
      );
    }
  }

  /**
   * Check if shared infrastructure exists
   */
  async isSharedInfrastructureDeployed(): Promise<boolean> {
    await this.getSharedInfrastructureOutputs();
    return true;
  }

  /**
   * Wait for stack update to complete
   */
  async waitForStackUpdate(
    userId: string,
    projectName: string,
    timeoutMinutes: number = 15,
  ): Promise<StackStatus> {
    const stackName = this.getStackName(userId, projectName);
    const maxAttempts = (timeoutMinutes * 60) / 10; // Check every 10 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const stack = await this.getStack(userId, projectName);

      if (!stack) {
        throw new Error(`Stack ${stackName} not found during update`);
      }

      const status = stack.StackStatus;

      // Complete states
      if (status === "UPDATE_COMPLETE") {
        logger.info(`✅ Stack ${stackName} updated successfully`);
        return status;
      }

      // Failure states
      if (
        status === "UPDATE_ROLLBACK_COMPLETE" ||
        status === "UPDATE_ROLLBACK_FAILED" ||
        status === "UPDATE_FAILED"
      ) {
        const failureReason = stack.StackStatusReason || "Unknown failure";
        throw new Error(
          `Stack ${stackName} update failed. Status: ${status}. Reason: ${failureReason}`,
        );
      }

      // Still in progress
      logger.info(`Stack ${stackName} status: ${status}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    throw new Error(
      `Stack ${stackName} update timeout after ${timeoutMinutes} minutes`,
    );
  }
}

// Export singleton instance
export const cloudFormationService = new CloudFormationService();
