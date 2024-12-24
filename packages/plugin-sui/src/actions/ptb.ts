import { z } from "zod";
import {
    Action,
    ActionExample,
    composeContext,
    Content,
    elizaLogger,
    generateObject,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";

const ArgSchema = z.union([
    z.object({
        kind: z.literal("Input"),
        index: z.number(),
    }),
    z.object({
        kind: z.literal("Result"),
        index: z.number(),
    }),
]);

const InputArgSchema = z.object({
    kind: z.literal("Input"),
    index: z.number(),
});

const TransferObjectsSchema = z.object({
    TransferObjects: z.object({
        objects: z.array(ArgSchema),
        address: ArgSchema,
    }),
});

const SplitCoinsSchema = z.object({
    SplitCoins: z.object({
        coin: ArgSchema,
        amounts: z.array(ArgSchema),
    }),
});

const MergeCoinsSchema = z.object({
    MergeCoins: z.object({
        coin: ArgSchema,
        toMerge: z.array(ArgSchema),
    }),
});

const MakeMoveVecSchema = z.object({
    MakeMoveVec: z.object({
        args: z.array(InputArgSchema),
    }),
});

const MoveCallSchema = z.object({
    MoveCall: z.object({
        target: InputArgSchema,
        typeArgs: z.array(InputArgSchema),
        args: z.array(ArgSchema),
    }),
});

const PublishSchema = z.object({
    Publish: z.object({
        moduleBytes: z.array(InputArgSchema),
        transitiveDependencies: z.array(InputArgSchema),
    }),
});

const UpgradeSchema = z.object({
    Upgrade: z.object({
        moduleBytes: z.array(InputArgSchema),
        transitiveDependencies: z.array(InputArgSchema),
        package: InputArgSchema,
        upgradeTicket: InputArgSchema,
    }),
});

const CommandSchema = z.union([
    TransferObjectsSchema,
    SplitCoinsSchema,
    MergeCoinsSchema,
    MakeMoveVecSchema,
    MoveCallSchema,
    PublishSchema,
    UpgradeSchema,
]);

const ptbSchema = z.object({
    inputs: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    commands: z.array(CommandSchema),
});

export interface PTBContent extends Content {
    inputs: (string | number | boolean | null)[];
    commands: object[];
}

function isPTBContent(content: Content): content is PTBContent {
    return (
        content &&
        typeof content === "object" &&
        Array.isArray(content.inputs) &&
        content.inputs.every((input) =>
            ["string", "number", "boolean"].includes(typeof input)
        ) &&
        Array.isArray(content.commands) &&
        content.commands.every((command) => typeof command === "object")
    );
}

const ptbTemplate = `Respond with a JSON markdown block containing only the extracted commands and inputs. Use null for any commands and inputs that cannot be determined.
TransferObjects sends multiple (one or more) objects to a specified address.
SplitCoins splits off multiple (one or more) coins from a single coin.
MergeCoins merges multiple (one or more) coins into a single coin.
MakeMoveVec creates a vector (potentially empty) of Move values.
MoveCall invokes either an entry or a public Move function in a published package.
Publish creates a new package and calls the init function of each module in the package.
Upgrade upgrades an existing package.

Example responses:
\`\`\`json
{
  "inputs": ["0x1", 10, 20],
  "commands": [
    {
      "SplitCoins": {
        "coin": { "kind": "Input", "index": 0 },
        "amounts": [
          { "kind": "Input", "index": 1 },
          { "kind": "Input", "index": 2 }
        ]
      }
    }
  ]
}
\`\`\`

\`\`\`json
{
  "inputs": ["0x1", "0x2", "0x3"],
  "commands": [{
    "MakeMoveVec": {
      "args": [
        { "kind": "Input", "index": 0 },
        { "kind": "Input", "index": 1 },
        { "kind": "Input", "index": 2 }
      ]
    }
  }]
}
\`\`\`

\`\`\`json
{
  "inputs": ["0x1", "0x2", "0x3", "0x4"],
  "commands": [{
    "TransferObjects": {
      "objects": [
        { "kind": "Input", "index": 0 },
        { "kind": "Input", "index": 1 },
        { "kind": "Input", "index": 2 }
      ],
      "address": { "kind": "Input", "index": 3 }
    }
  }]
}
\`\`\`

\`\`\`json
{
  "inputs": ["0x1", "0x2", "0x3", "0x4"],
  "commands": [{
    "MergeCoins": {
      "coin": { "kind": "Input", "index": 0 },
      "toMerge": [
        { "kind": "Input", "index": 1 },
        { "kind": "Input", "index": 2 },
        { "kind": "Input", "index": 3 }
      ]
    }
  }]
}
\`\`\`

\`\`\`json
{
  "inputs": ["0x1", "0x2", "0x3", "0x4"],
  "commands": [{
    "MoveCall": {
      "target": { "kind": "Input", "index": 0 },
      "typeArgs": [],
      "args": [
        { "kind": "Input", "index": 1 },
        { "kind": "Input", "index": 2 },
        { "kind": "Input", "index": 3 }
      ]
    }
  }]
}
\`\`\`

\`\`\`json
{
  "inputs": ["0x1", "0x2", "0x3", "0x4", "0x5", "0x6"],
  "commands": [
    {
      "Publish": {
        "moduleBytes": [
          { "kind": "Input", "index": 0 },
          { "kind": "Input", "index": 1 },
          { "kind": "Input", "index": 2 }
        ],
        "transitiveDependencies": [
          { "kind": "Input", "index": 3 },
          { "kind": "Input", "index": 4 },
          { "kind": "Input", "index": 5 }
        ]
      }
    }
  ]
}
\`\`\`

{{recentMessages}}

Respond with a JSON markdown block containing only the extracted commands and inputs.`;

export default {
    name: "BUILD_PTB",
    similes: [
        "CONSTRUCT_PTB",
        "COMPOSE_PTB",
        "GENERATE_PTB",
        "PTB",
        "COMMAND",
        "TRANSACTION",
    ],
    description: "Build a PTB from inputs and commands",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        console.log("Validating PTB build from user:", message.userId);
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting BUILD_PTB handler...");

        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        const ptbContext = composeContext({
            state,
            template: ptbTemplate,
        });

        const content = await generateObject({
            runtime,
            context: ptbContext,
            schema: ptbSchema,
            modelClass: ModelClass.SMALL,
        });

        const ptbContent = content.object as PTBContent;

        if (!isPTBContent(ptbContent)) {
            console.error("Invalid PTB content:", ptbContent);
            if (callback) {
                await callback({
                    text: "Unable to process PTB request. Invalid content provided.",
                    content: { error: "Invalid PTB content" },
                });
            }
        }

        if (callback) {
            await callback({
                text: JSON.stringify(ptbContent),
                content: {
                    success: true,
                },
            });
        }

        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Transfer objects 0x1, 0x2, and 0x3 to address 0x4",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I will generate a PTB that transfers the objects 0x1, 0x2, 0x3 to the address 0x4",
                    action: "BUILD_PTB",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Split coin 0x1 into amounts 10 and 20",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I will generate a PTB that splits the coin 0x1 into amounts 10 and 20",
                    action: "BUILD_PTB",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Merge the coins 0x1, 0x2, and 0x3 into a single coin",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I will generate a PTB that merges the input coins 0x1, 0x2, into 0x3 coin",
                    action: "BUILD_PTB",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Construct a PTB that calls the target 0x883393ee444fb828aa0e977670cf233b0078b41d144e6208719557cb3888244d::hello_wolrd::hello_world with the argument 50",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I will generate a PTB that calls the input target 0x883393ee444fb828aa0e977670cf233b0078b41d144e6208719557cb3888244d::hello_wolrd::hello_world with the input argument 50",
                    action: "BUILD_PTB",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
