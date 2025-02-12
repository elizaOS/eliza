import { handleError } from "@/src/utils/handle-error"
import { logger } from "@/src/utils/logger"
import { Command } from "commander"
import fs from "node:fs"

const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL

export const agent = new Command()
  .name("agent")
  .description("manage ElizaOS agents")

async function getAgentIdFromIndex(index: number): Promise<string> {
  const listResponse = await fetch(`${AGENT_RUNTIME_URL}/agents`)
  const { agents } = await listResponse.json()
  
  const sortedAgents = agents.sort((a, b) => a.name.localeCompare(b.name))
  
  if (index < 0 || index >= sortedAgents.length) {
    throw new Error(`Invalid index: ${index}. Must be between 0 and ${sortedAgents.length - 1}`)
  }
  
  return sortedAgents[index].id
}

agent
  .command("list")
  .description("list available agents")
  .option("--json", "output as JSON")
  .action(async (opts) => {
    try {
      const response = await fetch(`${AGENT_RUNTIME_URL}/agents`)
      const { agents } = await response.json()

      // Sort agents by name
      const sortedAgents = agents.sort((a, b) => a.name.localeCompare(b.name))
      
      // Format data for table
      const tableData = sortedAgents.map(agent => ({
        Name: agent.name,
        ID: agent.id,
        Clients: agent.clients.join(", ")
      }))

      if (opts.json) {
        logger.info(JSON.stringify(tableData, null, 2))
      } else {
        logger.info("\nAvailable agents:")
        console.table(tableData)
        logger.info("")
      }
    } catch (error) {
      handleError(error)
    }
  })

agent
  .command("get")
  .description("get agent details")
  .argument("<agentId>", "agent id, name, or index number from list")
  .option("--json", "output as JSON")
  .action(async (agentIdOrIndex, opts) => {
    try {
      // If input is a number, get agent ID from index
      if (!isNaN(Number(agentIdOrIndex))) {
        agentIdOrIndex = await getAgentIdFromIndex(Number.parseInt(agentIdOrIndex))
      }

      const response = await fetch(`${AGENT_RUNTIME_URL}/agents/${agentIdOrIndex}`)
      if (!response.ok) {
        throw new Error(`Failed to get agent: ${response.statusText}`)
      }
      const agent = await response.json()
      
      if (opts.json) {
        logger.info(JSON.stringify(agent, null, 2))
      } else {
        console.table({
          Name: agent.name,
          ID: agent.id,
          Clients: agent.clients.join(", "),
          Status: agent.status,
          // Add other relevant fields here
        })
      }
    } catch (error) {
      handleError(error)
    }
  })

agent
  .command("start")
  .description("start an agent")
  .argument("[characterPath]", "path to character JSON file")
  .option("-j, --json <json>", "character JSON string")
  .action(async (characterPath, opts) => {
    try {
      const payload: any = {}
      if (characterPath) payload.characterPath = characterPath
      if (opts.json) payload.characterJson = JSON.parse(opts.json)

      const response = await fetch(`${AGENT_RUNTIME_URL}/agent/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        throw new Error(`Failed to start agent: ${response.statusText}`)
      }

      const result = await response.json()
      logger.success(`Successfully started agent ${result.character.name} (${result.id})`)
    } catch (error) {
      handleError(error)
    }
  })

agent
  .command("stop")
  .description("stop an agent")
  .argument("<agentId>", "agent id, name, or index number from list")
  .action(async (agentIdOrIndex) => {
    try {
      if (!isNaN(Number(agentIdOrIndex))) {
        agentIdOrIndex = await getAgentIdFromIndex(Number.parseInt(agentIdOrIndex))
      }

      const response = await fetch(`${AGENT_RUNTIME_URL}/agents/${agentIdOrIndex}/stop`, {
        method: 'POST'
      })

      if (!response.ok) {
        throw new Error(`Failed to stop agent: ${response.statusText}`)
      }

      logger.success(`Successfully stopped agent ${agentIdOrIndex}`)
    } catch (error) {
      handleError(error)
    }
  })

agent
  .command("remove")
  .description("remove an agent")
  .argument("<agentId>", "agent id, name, or index number from list")
  .action(async (agentIdOrIndex) => {
    try {
      if (!isNaN(Number(agentIdOrIndex))) {
        agentIdOrIndex = await getAgentIdFromIndex(Number.parseInt(agentIdOrIndex))
      }

      const response = await fetch(`${AGENT_RUNTIME_URL}/agents/${agentIdOrIndex}`, {
        method: 'DELETE'
      })

      if (!response.ok) {
        throw new Error(`Failed to remove agent: ${response.statusText}`)
      }

      logger.success(`Successfully removed agent ${agentIdOrIndex}`)
    } catch (error) {
      handleError(error)
    }
  })

agent
  .command("set")
  .description("update agent configuration")
  .argument("<agentId>", "agent id, name, or index number from list")
  .argument("<configPath>", "path to configuration JSON file")
  .action(async (agentIdOrIndex, configPath) => {
    try {
      if (!isNaN(Number(agentIdOrIndex))) {
        agentIdOrIndex = await getAgentIdFromIndex(Number.parseInt(agentIdOrIndex))
      }

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      const response = await fetch(`${AGENT_RUNTIME_URL}/agents/${agentIdOrIndex}/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      })

      if (!response.ok) {
        throw new Error(`Failed to update agent configuration: ${response.statusText}`)
      }

      const result = await response.json()
      logger.success(`Successfully updated configuration for agent ${result.id}`)
    } catch (error) {
      handleError(error)
    }
  })

agent
  .command("storage")
  .description("list files in character storage")
  .option("--json", "output as JSON")
  .action(async (opts) => {
    try {
      const response = await fetch(`${AGENT_RUNTIME_URL}/storage`)
      if (!response.ok) {
        throw new Error(`Failed to list storage: ${response.statusText}`)
      }
      const { files } = await response.json()
      
      // Sort files alphabetically
      const sortedFiles = files.sort()
      
      if (opts.json) {
        logger.info(JSON.stringify(sortedFiles, null, 2))
      } else {
        logger.info("\nCharacter files in storage:")
        console.table(sortedFiles.map((file, index) => ({
          Index: index,
          Filename: file
        })))
        logger.info("")
      }
    } catch (error) {
      handleError(error)
    }
  })
