import {
    type Action,
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    type State,
    type HandlerCallback,
    elizaLogger,
    composeContext,
    ModelClass,
    generateObjectDeprecated,
} from "@elizaos/core";
import { validateSpheronConfig } from "../environment.ts";
import {
    getDeployment,
    updateDeployment,
    closeDeployment,
    startDeployment,
} from "../utils/index.ts";
import type { DeploymentContent } from "../types/index.ts";
import { AVAILABLE_GPU_MODELS } from "../utils/constants.ts";
import { DEPLOYMENT_TEMPLATES } from "../utils/template.ts";

function isDeploymentContent(content: unknown): content is DeploymentContent {
    elizaLogger.debug("Content for deployment operation:", content);

    // First, check if content is an object
    if (typeof content !== 'object' || content === null) {
        return false;
    }

    // Type assertion to access properties safely
    const contentObj = content as Record<string, unknown>;

    // Check operation property
    if (
        typeof contentObj.operation !== "string" ||
        !["create", "update", "close"].includes(contentObj.operation)
    ) {
        return false;
    }

    // Check properties based on operation
    switch (contentObj.operation) {
        case "create":
            return (
                typeof contentObj.template === "string" &&
                typeof contentObj.customizations === "object"
            );
        case "update":
            return (
                typeof contentObj.leaseId === "string" &&
                typeof contentObj.template === "string" &&
                typeof contentObj.customizations === "object"
            );
        case "close":
            return typeof contentObj.leaseId === "string";
        default:
            return false;
    }
}
// function isDeploymentContent(content: any): content is DeploymentContent {
//     elizaLogger.debug("Content for deployment operation:", content);
//     if (
//         typeof content.operation !== "string" ||
//         !["create", "update", "close"].includes(content.operation)
//     ) {
//         return false;
//     }

//     switch (content.operation) {
//         case "create":
//             return (
//                 typeof content.template === "string" &&
//                 typeof content.customizations === "object"
//             );
//         case "update":
//             return (
//                 typeof content.leaseId === "string" &&
//                 typeof content.template === "string" &&
//                 typeof content.customizations === "object"
//             );
//         case "close":
//             return typeof content.leaseId === "string";
//         default:
//             return false;
//     }
// }

// Generate template descriptions dynamically
const templateDescriptions = Object.entries(DEPLOYMENT_TEMPLATES)
    .map(([key, template]) => `- ${key}: ${template.description}`)
    .join("\n");

const deploymentTemplate = `Respond with a JSON markdown block containing only the extracted values for the requested deployment operation.

Example responses for different operations:

1. Creating a new deployment:
\`\`\`json
{
    "operation": "create",
    "template": "<template-name>",  // One of: jupyter-notebook, ollama-webui, vscode-pytorch
    "customizations": {
        "cpu": <true|false>,                // Extract CPU-only preference from context or put a default value of false. eg. no gpu needed or something like that
        "resources": {               // Extract resource requirements from context
            "cpu": "<requested-cpu>", // Extract cpu requirements from context or put a default value of 4
            "memory": "<requested-memory>", // Extract memory requirements from context or put a default value of 8Gi
            "storage": "<requested-storage>", // Extract storage requirements from context or put a default value of 100Gi
            "gpu": "<requested-gpu-count>", // Extract gpu requirements from context or put a default value of 1
            "gpu_model": "<requested-gpu-model>" // Extract gpu model requirements from context or put a default value of rtx4090
        },
        "duration": "<requested-duration>" // Extract duration requirements from context or put a default value of 1h
        "token": "<requested-token>" // Extract token requirements from context or put a default value of CST
        "template": {
            "heuristMinerAddress": "<requested-heurist-miner-address>" // Extract heurist miner address requirements from context
        }
    }
}
\`\`\`

2. Updating an existing deployment:
\`\`\`json
{
    "operation": "update",
    "leaseId": "existing-lease-id", // Extract lease ID from context
    "template": "<template-name>", // One of: jupyter-notebook, ollama-webui, vscode-pytorch
    "customizations": {
        "cpu": <true|false>,   // Extract cpu-only preference from context or put a default value of false. eg. no gpu needed or something like that
        "resources": {               // Extract updated resource requirements from context
            "cpu": "<requested-cpu>", // Extract cpu requirements from context or put a default value of 4
            "memory": "<requested-memory>", // Extract memory requirements from context or put a default value of 8Gi
            "storage": "<requested-storage>", // Extract storage requirements from context or put a default value of 100Gi
            "gpu": "<requested-gpu-count>", // Extract gpu requirements from context or put a default value of 1
            "gpu_model": "<requested-gpu-model>" // Extract gpu model requirements from context or put a default value of rtx4090
        },
        "duration": "<requested-duration>" // Extract duration requirements from context or put a default value of 1h
        "token": "<requested-token>" // Extract token requirements from context or put a default value of CST
    }
}
\`\`\`

3. Closing a deployment:
\`\`\`json
{
    "operation": "close",
    "leaseId": "lease-id-to-close"
}
\`\`\`

## Available Templates
${templateDescriptions}

## Available GPU Models
${AVAILABLE_GPU_MODELS.map((gpu) => `- ${gpu}`).join("\n")}

{{recentMessages}}

Given the recent messages, extract the following information about the requested deployment:
- Desired template name from the context
- CPU-only requirement (if specified) from the context
- Any customization requirements GPU model and it's count, cpu and memory resources properly from the context
- Token (if specified) from the context
- Duration (if specified) from the context
- Lease ID (if updating or closing) from the context
- Operation (create, update, close) from the context

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "DEPLOYMENT_OPERATION",
    similes: [
        "CREATE_DEPLOYMENT",
        "UPDATE_DEPLOYMENT",
        "GET_DEPLOYMENT",
        "CLOSE_DEPLOYMENT",
        "DEPLOY_SERVICE",
        "MANAGE_DEPLOYMENT",
        "LAUNCH_SERVICE",
        "START_DEPLOYMENT",
        "SETUP_DEPLOYMENT",
    ],
    description:
        "MUST use this action if the user requests to create, update, or manage a deployment. The request might vary, but it will always be related to deployment operations.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateSpheronConfig(runtime);
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting DEPLOYMENT_OPERATION handler...");

        // Create local variable for state manipulation
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        // Filter only "just now" and last couple of user messages
        state.recentMessages = state.recentMessages
            .split("\n")
            .filter(
                (line) => line.includes("(just now)") || line.includes("(user)")
            )
            .slice(-2)
            .join("\n");

        // Compose deployment context
        const deploymentContext = composeContext({
            state: currentState,
            template: deploymentTemplate,
        });

        // Generate deployment content
        const content = await generateObjectDeprecated({
            runtime,
            context: deploymentContext,
            modelClass: ModelClass.SMALL,
        });

        // Validate deployment content
        if (!isDeploymentContent(content)) {
            elizaLogger.error(
                "Invalid content for DEPLOYMENT_OPERATION action."
            );
            callback?.({
                text: "Unable to process deployment request. Invalid content provided.",
                content: { error: "Invalid deployment content" },
            });
            return false;
        }

        try {
            switch (content.operation) {
                case "create": {
                    if (
                        !content.template ||
                        !DEPLOYMENT_TEMPLATES[content.template]
                    ) {
                        throw new Error(
                            `Unsupported template: ${content.template}. Available templates are: ${Object.keys(DEPLOYMENT_TEMPLATES).join(", ")}`
                        );
                    }

                    const computeConfig = DEPLOYMENT_TEMPLATES[
                        content.template
                    ].config(content.customizations);
                    const result = await startDeployment(
                        runtime,
                        computeConfig
                    );

                    elizaLogger.log(
                        "Deployment created with lease ID:",
                        result.leaseId.toString()
                    );

                    const deploymentDetails = await getDeployment(
                        runtime,
                        result.leaseId.toString()
                    );
                    const service = Object.values(
                        deploymentDetails.services
                    )[0];

                    // Get forwarded ports information
                    const ports =
                        deploymentDetails.forwarded_ports[service.name] || [];
                    const portInfo = ports
                        .map(
                            (p) =>
                                `${p.host}:${p.externalPort} for Port ${p.port}`
                        )
                        .join(", ");

                    console.log("Final response:", {
                        text: `Deployment created and ready!\nLease ID: ${result.leaseId.toString()}\n${portInfo ? `Access URLs: ${portInfo}` : ""}`,
                        content: {
                            success: true,
                            leaseId: result.leaseId.toString(),
                            details: deploymentDetails,
                            ports: ports,
                        },
                    });

                    callback?.({
                        text: `Deployment created and ready!\nLease ID: ${result.leaseId.toString()}\n${portInfo ? `Access URLs: ${portInfo}` : ""}`,
                        content: {
                            success: true,
                            leaseId: result.leaseId.toString(),
                            details: deploymentDetails,
                            ports: ports,
                        },
                    });
                    break;
                }
                case "update": {
                    if (
                        !content.leaseId ||
                        !content.customizations ||
                        !content.template
                    ) {
                        throw new Error(
                            "Lease ID, template, and customizations are required for deployment update"
                        );
                    }

                    if (!DEPLOYMENT_TEMPLATES[content.template]) {
                        throw new Error(
                            `Unsupported template: ${content.template}`
                        );
                    }

                    const computeConfig = DEPLOYMENT_TEMPLATES[
                        content.template
                    ].config(content.customizations);
                    const result = await updateDeployment(
                        runtime,
                        content.leaseId.toString(),
                        computeConfig
                    );
                    elizaLogger.log(
                        "Deployment updated with lease ID:",
                        result.leaseId.toString()
                    );

                    const newDetails = await getDeployment(
                        runtime,
                        content.leaseId.toString()
                    );
                    callback?.({
                        text: `Deployment ${content.leaseId.toString()} updated successfully`,
                        content: {
                            success: true,
                            details: newDetails,
                        },
                    });
                    break;
                }
                case "close": {
                    if (!content.leaseId) {
                        throw new Error(
                            "Lease ID is required for deployment closure"
                        );
                    }
                    const result = await closeDeployment(
                        runtime,
                        content.leaseId.toString()
                    );
                    elizaLogger.log(
                        "Deployment closed with lease ID:",
                        content.leaseId.toString()
                    );

                    callback?.({
                        text: `Deployment ${content.leaseId.toString()} closed successfully`,
                        content: {
                            success: true,
                            transaction: result,
                        },
                    });
                    break;
                }
            }
            return true;
        } catch (error) {
            console.log("Error:", error);
            elizaLogger.error("Deployment operation failed:", error.message);
            callback?.({
                text: "Deployment operation failed",
                content: {
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                },
            });
            return false;
        }
    },
    examples: [
        // Create deployment examples with templates
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deploy a Jupyter notebook with GPU",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Setting up your Jupyter notebook deployment with GPU support...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Create a CPU-only Jupyter notebook deployment",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Setting up your CPU-only Jupyter notebook deployment...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deploy Jupyter notebook with A100 GPU and 32GB memory",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Setting up your Jupyter notebook deployment with A100 GPU and custom resources...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deploy Ollama WebUI with RTX 4090",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Setting up Ollama WebUI with RTX 4090 GPU support...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Create a VS Code deployment with PyTorch and T4 GPU",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Setting up VS Code PyTorch environment with T4 GPU...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deploy a Jupyter notebook with GPU and token USDT",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Setting up your Jupyter notebook deployment with GPU support and token USDT...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        // Update deployment examples
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Upgrade my deployment abc123 to use an A100 GPU",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Updating deployment abc123 to use A100 GPU...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Scale up the memory to 64GB for deployment xyz789",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Updating deployment resources...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Update my deployment abc123 to use an A100 GPU and token USDT",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Updating deployment abc123 to use A100 GPU and token USDT...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        // Close deployment examples
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Close deployment abc123",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Closing deployment abc123...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I want to stop my deployment abc123",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Closing deployment abc123...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Stop my Jupyter notebook deployment xyz789",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Terminating Jupyter notebook deployment xyz789...",
                    action: "DEPLOYMENT_OPERATION",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
