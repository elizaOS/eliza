// src/commands/agent.ts
import { MessageExampleSchema } from "@elizaos/core"
import prompts from "prompts"
import { z } from "zod"

const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  username: z.string(),
  description: z.string().optional(),
  settings: z.record(z.string(), z.any()).optional(),
  plugins: z.array(z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  bio: z.array(z.string()).optional(),
  lore: z.array(z.string()).optional(),
  adjectives: z.array(z.string()).optional(),
  postExamples: z.array(z.string()).optional(),
  messageExamples: z.array(z.array(MessageExampleSchema)).optional(),
  topics: z.array(z.string()).optional(),
  style: z.object({
    all: z.array(z.string()).optional(),
    chat: z.array(z.string()).optional(),
    post: z.array(z.string()).optional(),
  }).optional(),
})

type AgentFormData = {
  name: string;
  bio: string[];
  lore: string[];
  adjectives: string[];
  postExamples: z.infer<typeof MessageExampleSchema>[];
  messageExamples: z.infer<typeof MessageExampleSchema>[][];
}

async function collectAgentData(
  initialData?: Partial<AgentFormData>
): Promise<AgentFormData | null> {
  const formData: Partial<AgentFormData> = { ...initialData };
  let currentStep = 0;
  const steps = ['name', 'bio', 'lore', 'adjectives', 'postExamples', 'messageExamples'];
  
  while (currentStep < steps.length) {
    const field = steps[currentStep];
    let response;

    switch (field) {
      case 'name':
        response = await prompts({
          type: 'text',
          name: 'value',
          message: 'Enter agent name:',
          initial: formData.name,
        });
        break;

      case 'bio':
      case 'lore':
      case 'postExamples':
      case 'messageExamples':
        response = await prompts({
          type: 'text',
          name: 'value',
          message: `Enter ${field} (use \\n for new lines):`,
          initial: formData[field]?.join('\\n'),
        });
        break;

      case 'adjectives':
        response = await prompts({
          type: 'text',
          name: 'value',
          message: 'Enter adjectives (comma separated):',
          initial: formData.adjectives?.join(', '),
        });
        break;
    }

    if (!response.value) {
      return null;
    }

    // Navigation commands
    if (response.value === 'back') {
      currentStep = Math.max(0, currentStep - 1);
      continue;
    }
    if (response.value === 'forward') {
      currentStep++;
      continue;
    }

    // Process and store the response
    switch (field) {
      case 'name':
        formData.name = response.value;
        break;

      case 'bio':
      case 'lore':
      case 'postExamples':
        formData[field] = response.value
          .split('\\n')
          .map(line => line.trim())
          .filter(Boolean);
        break;

      case 'messageExamples':
        const examples = response.value
          .split('\\n')
          .map(line => line.trim())
          .filter(Boolean);
        formData.messageExamples = examples.length > 0 ? examples : [`{{user1}}: hey how are you?\n${formData.name}`];
        break;

      case 'adjectives':
        formData.adjectives = response.value
          .split(',')
          .map(adj => adj.trim())
          .filter(Boolean);
        break;
    }

    currentStep++;
  }

  return formData as AgentFormData;
}

// export const agent = new Command()
//   .name("agent")
//   .description("manage agents")

// agent
//   .command("list")
//   .description("list all agents")
//   .action(async () => {
//     try {
//       const cwd = process.cwd()
//       const config = await getConfig(cwd)
//       if (!config) {
//         logger.error("No project.json found. Please run init first.")
//         process.exit(1)
//       }

//       const db = new Database((config.database.config as { path: string }).path)
//       const adapter = new SqliteDatabaseAdapter(db)
//       await adapter.init()

//       const agents = await adapter.listAgents()

//       if (agents.length === 0) {
//         logger.info("No agents found")
//       } else {
//         logger.info("\nAgents:")
//         for (const agent of agents) {
//           logger.info(`  ${agent.name} (${agent.id})`)
//         }
//       }

//       await adapter.close()
//     } catch (error) {
//       handleError(error)
//     }
//   })

// agent
//   .command("create")
//   .description("create a new agent")
//   .action(async () => {
//     try {
//       const cwd = process.cwd()
//       const config = await getConfig(cwd)
//       if (!config) {
//         logger.error("No project.json found. Please run init first.")
//         process.exit(1)
//       }

//       logger.info("\nCreating new agent (type 'back' or 'forward' to navigate)")
      
//       const formData = await collectAgentData()
//       if (!formData) {
//         logger.info("Agent creation cancelled")
//         return
//       }

//       const db = new Database((config.database.config as { path: string }).path)
//       const adapter = new SqliteDatabaseAdapter(db)
//       await adapter.init()

//       const agentData = {
//         id: uuid() as UUID,
//         name: formData.name,
//         username: formData.name.toLowerCase().replace(/\s+/g, '_'),
//         bio: formData.bio,
//         lore: formData.lore,
//         adjectives: formData.adjectives,
//         postExamples: formData.postExamples,
//         messageExamples: formData.messageExamples,
//         topics: [],
//         style: { // TODO: add style
//           all: [], 
//           chat: [],
//           post: [],
//         },
//         plugins: [],
//         settings: {},
//       }

//       await adapter.createAgent(agentData as any)
      
//       logger.success(`Created agent ${formData.name} (${agentData.id})`)
//       await adapter.close()
//     } catch (error) {
//       handleError(error)
//     }
//   })

// agent
//   .command("edit")
//   .description("edit an agent")
//   .argument("<agent-id>", "agent ID")
//   .action(async (agentId) => {
//     try {
//       const cwd = process.cwd()
//       const config = await getConfig(cwd)
//       if (!config) {
//         logger.error("No project.json found. Please run init first.")
//         process.exit(1)
//       }

//       const db = new Database((config.database.config as { path: string }).path)
//       const adapter = new SqliteDatabaseAdapter(db)
//       await adapter.init()

//       const existingAgent = await adapter.getAgent(agentId)
//       if (!existingAgent) {
//         logger.error(`Agent ${agentId} not found`)
//         process.exit(1)
//       }

//       logger.info(`\nEditing agent ${existingAgent.name} (type 'back' or 'forward' to navigate)`)

//       const formData = await collectAgentData({
//         name: existingAgent.name,
//         bio: Array.isArray(existingAgent.bio) ? existingAgent.bio : [existingAgent.bio],
//         lore: existingAgent.lore || [],
//         adjectives: existingAgent.adjectives || [],
//         postExamples: existingAgent.postExamples?.map(p => [{ user: "", content: { text: p } }]) || [],
//         messageExamples: existingAgent.messageExamples || [],
//       })

//       if (!formData) {
//         logger.info("Agent editing cancelled")
//         return
//       }

//       await adapter.updateAgent({
//         id: agentId,
//         name: formData.name,
//         bio: formData.bio,
//         lore: formData.lore,
//         adjectives: formData.adjectives,
//         postExamples: formData.postExamples,
//         messageExamples: formData.messageExamples,
//       })

//       logger.success(`Updated agent ${formData.name}`)
//       await adapter.close()
//     } catch (error) {
//       handleError(error)
//     }
//   })

// agent
//   .command("import")
//   .description("import an agent from file") 
//   .argument("<file>", "JSON file path")
//   .action(async (file) => {
//     try {
//       const cwd = process.cwd()
//       const config = await getConfig(cwd)
//       if (!config) {
//         logger.error("No project.json found. Please run init first.")
//         process.exit(1)
//       }

//       const agentData = JSON.parse(await fs.readFile(file, "utf8"))
//       const agent = agentSchema.parse(agentData)
      
//       const db = new Database((config.database.config as { path: string }).path)
//       const adapter = new SqliteDatabaseAdapter(db)
//       await adapter.init()

//       await adapter.createAgent({
//         name: agent.name,
//         bio: agent.bio || [],
//         lore: agent.lore || [],
//         messageExamples: agent.messageExamples || [],
//         topics: agent.topics || [],
//         style: {
//           all: agent.style?.all || [],
//           chat: agent.style?.chat || [], 
//           post: agent.style?.post || []
//         },
//         settings: agent.settings || {},
//         plugins: agent.plugins || [],
//         adjectives: agent.adjectives || [],
//         postExamples: agent.postExamples || [],
//         id: stringToUuid(agent.id)
//       })

//       logger.success(`Imported agent ${agent.name}`)

//       await adapter.close()
//     } catch (error) {
//       handleError(error)
//     }
//   })

// agent
//   .command("export")
//   .description("export an agent to file")
//   .argument("<agent-id>", "agent ID")
//   .option("-o, --output <file>", "output file path")
//   .action(async (agentId, opts) => {
//     try {
//       const cwd = process.cwd()
//       const config = await getConfig(cwd)
//       if (!config) {
//         logger.error("No project.json found. Please run init first.")
//         process.exit(1)
//       }

//       const db = new Database((config.database.config as { path: string }).path)
//       const adapter = new SqliteDatabaseAdapter(db)
//       await adapter.init()

//       const agent = await adapter.getAgent(agentId)
//       if (!agent) {
//         logger.error(`Agent ${agentId} not found`)
//         process.exit(1)
//       }

//       const outputPath = opts.output || `${agent.name}.json`
//       await fs.writeFile(outputPath, JSON.stringify(agent, null, 2))
//       logger.success(`Exported agent to ${outputPath}`)

//       await adapter.close()
//     } catch (error) {
//       handleError(error)
//     }
//   })

// agent
//   .command("remove")
//   .description("remove an agent")
//   .argument("<agent-id>", "agent ID")
//   .action(async (agentId) => {
//     try {
//       const cwd = process.cwd()
//       const config = await getConfig(cwd)
//       if (!config) {
//         logger.error("No project.json found. Please run init first.")
//         process.exit(1)
//       }

//       const db = new Database((config.database.config as { path: string }).path)
//       const adapter = new SqliteDatabaseAdapter(db)
//       await adapter.init()

//       await adapter.removeAgent(agentId)
//       logger.success(`Removed agent ${agentId}`)

//       await adapter.close()
//     } catch (error) {
//       handleError(error)
//     }
//   })