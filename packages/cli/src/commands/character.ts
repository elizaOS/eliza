// src/commands/agent.ts
import { Database, SqliteDatabaseAdapter } from "@elizaos-plugins/sqlite";
import type { MessageExample, UUID } from "@elizaos/core";
import { MessageExampleSchema } from "@elizaos/core";
import { Command } from "commander";
import fs from "node:fs";
import prompts from "prompts";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { getConfig } from "../utils/get-config";
import { handleError } from "../utils/handle-error";
import { logger } from "../utils/logger";
import { resolveDatabasePath } from "../utils/resolve-database-path";

const characterSchema = z.object({
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

type CharacterFormData = z.infer<typeof characterSchema>

export const character = new Command()
  .name("character")
  .description("manage characters")

async function collectCharacterData(
  initialData?: Partial<CharacterFormData>
): Promise<CharacterFormData | null> {
  const formData: Partial<CharacterFormData> = { ...initialData };
  let currentStep = 0;
  const steps = ['name', 'bio', 'lore', 'adjectives', 'postExamples', 'messageExamples'];
  
  let response: { value?: string };

  while (currentStep < steps.length) {
    const field = steps[currentStep];

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

      case 'messageExamples': {
        const examples = response.value
          .split('\\n')
          .map(line => line.trim())
          .filter(Boolean);
        formData.messageExamples = examples.length > 0
          ? examples
          : [`{{user1}}: hey how are you?\n${formData.name}`];
        break;
      }

      case 'adjectives':
        formData.adjectives = response.value
          .split(',')
          .map(adj => adj.trim())
          .filter(Boolean);
        break;
    }
    currentStep++;
  }

  return formData as CharacterFormData;
}

character
  .command("list")
  .description("list all characters")
  .action(async () => {
    try {
      const dbPath = await resolveDatabasePath({ requiredConfig: false });
      
      const db = new Database(dbPath);
      const adapter = new SqliteDatabaseAdapter(db);
      await adapter.init();

      const characters = await adapter.listCharacters();

      if (characters.length === 0) {
        logger.info("No characters found");
      } else {
        logger.info("\nCharacters:");
        for (const character of characters) {
          logger.info(`  ${character.name} (${character.id})`);
        }
      }

      await adapter.close();
    } catch (error) {
      handleError(error);
    }
  })

character
  .command("create")
  .description("create a new character")
  .action(async () => {
    try {
      
      const formData = await collectCharacterData()
      if (!formData) {
        logger.info("Character creation cancelled")
        return
      }

      const dbPath = await resolveDatabasePath({ requiredConfig: true });
      const db = new Database(dbPath);
      const adapter = new SqliteDatabaseAdapter(db)
      await adapter.init()

      const characterData = {
        id: uuid() as UUID,
        name: formData.name,
        username: formData.name.toLowerCase().replace(/\s+/g, '_'),
        bio: formData.bio,
        lore: formData.lore,
        adjectives: formData.adjectives,
        postExamples: formData.postExamples,
        messageExamples: formData.messageExamples,
        topics: [],
        style: { // TODO: add style
          all: [], 
          chat: [],
          post: [],
        },
        plugins: [],
        settings: {},
      }

      const characterToCreate = {
        ...characterData,
        messageExamples: (characterData.messageExamples as MessageExample[][]).map(
          (msgArr: MessageExample[]): MessageExample[] => msgArr.map((msg: MessageExample) => ({
            user: msg.user || "unknown",
            content: msg.content
          }))
        )
      }

      await adapter.createCharacter({
        id: characterData.id,
        name: characterData.name,
        bio: characterData.bio || [],
        lore: characterData.lore || [],
        adjectives: characterData.adjectives || [],
        postExamples: characterData.postExamples || [],
        messageExamples: characterData.messageExamples as MessageExample[][],
        topics: characterData.topics || [],
        style: {
          all: characterData.style?.all || [],
          chat: characterData.style?.chat || [],
          post: characterData.style?.post || [],
        },
        plugins: characterData.plugins || [],
        settings: characterData.settings || {},
      })
      
      logger.success(`Created character ${formData.name} (${characterData.id})`)
      await adapter.close()
    } catch (error) {
      handleError(error)
    }
  })

character
  .command("edit")
  .description("edit a character")
  .argument("<character-id>", "character ID")
  .action(async (characterId) => {
    try {
      const dbPath = await resolveDatabasePath({ requiredConfig: true });
      const db = new Database(dbPath);
      const adapter = new SqliteDatabaseAdapter(db);
      await adapter.init();

      const existingCharacter = await adapter.getCharacter(characterId);
      if (!existingCharacter) {
        logger.error(`Character ${characterId} not found`);
        process.exit(1);
      }

      logger.info(`\nEditing character ${existingCharacter.name} (type 'back' or 'forward' to navigate)`)

      const formData = await collectCharacterData({
        name: existingCharacter.name,
        bio: Array.isArray(existingCharacter.bio) ? existingCharacter.bio : [existingCharacter.bio],
        lore: existingCharacter.lore || [],
        adjectives: existingCharacter.adjectives || [],
        postExamples: existingCharacter.postExamples || [],
        messageExamples: (existingCharacter.messageExamples || [] as MessageExample[][]).map(
          (msgArr: MessageExample[]): MessageExample[] => msgArr.map((msg: MessageExample) => ({ 
            user: msg.user ?? "unknown", 
            content: msg.content 
          }))
        ),
      })

      if (!formData) {
        logger.info("Character editing cancelled")
        return
      }

      const updatedCharacter = {
        ...existingCharacter,
        name: formData.name,
        bio: formData.bio || [],
        lore: formData.lore || [],
        adjectives: formData.adjectives || [],
        postExamples: formData.postExamples || [],
        messageExamples: formData.messageExamples as MessageExample[][],
        topics: existingCharacter.topics || [],
        style: {
          all: existingCharacter.style?.all || [],
          chat: existingCharacter.style?.chat || [],
          post: existingCharacter.style?.post || [],
        },
        plugins: existingCharacter.plugins || [],
        settings: existingCharacter.settings || {},
      }
      await adapter.updateCharacter(updatedCharacter)

      logger.success(`Updated character ${formData.name}`)
      await adapter.close()
    } catch (error) {
      handleError(error)
    }
  })

character
  .command("import")
  .description("import a character from file") 
  .argument("<file>", "JSON file path")
  .action(async (fileArg) => {
    try {
      // Use the provided argument if available; otherwise, prompt the user.
      const filePath: string = fileArg || (await prompts({
        type: "text",
        name: "file",
        message: "Enter the path to the Character JSON file",
      })).file;
      
      if (!filePath) {
        logger.info("Import cancelled")
        return
      }
      
      const characterData = JSON.parse(await fs.promises.readFile(filePath, "utf8"))
      const character = characterSchema.parse(characterData)
      
      // resolve database path
      const dbPath = await resolveDatabasePath({ requiredConfig: true })

      const db = new Database(dbPath)
      const adapter = new SqliteDatabaseAdapter(db)
      await adapter.init()

      await adapter.createCharacter({
        name: character.name,
        bio: character.bio || [],
        lore: character.lore || [],
        adjectives: character.adjectives || [],
        postExamples: character.postExamples || [],
        messageExamples: character.messageExamples as MessageExample[][],
        topics: character.topics || [],
        style: {
          all: character.style?.all || [],
          chat: character.style?.chat || [],
          post: character.style?.post || [],
        },
        plugins: character.plugins || [],
        settings: character.settings || {},
      })

      logger.success(`Imported character ${character.name}`)

      await adapter.close()
    } catch (error) {
      handleError(error)
    }
  })

character
  .command("export")
  .description("export a character to file")
  .argument("<character-id>", "character ID")
  .option("-o, --output <file>", "output file path")
  .action(async (characterId, opts) => {
    try {
      const cwd = process.cwd()
      const config = await getConfig(cwd)
      if (!config) {
        logger.error("No project.json found. Please run init first.")
        process.exit(1)
      }

      const db = new Database((config.database.config as { path: string }).path)
      const adapter = new SqliteDatabaseAdapter(db)
      await adapter.init()

      const character = await adapter.getCharacter(characterId)
      if (!character) {
        logger.error(`Character ${characterId} not found`)
        process.exit(1)
      }

      const outputPath = opts.output || `${character.name}.json`
      await fs.promises.writeFile(outputPath, JSON.stringify(character, null, 2))
      logger.success(`Exported character to ${outputPath}`)

      await adapter.close()
    } catch (error) {
      handleError(error)
    }
  })

character
  .command("remove")
  .description("remove a character")
  .argument("<character-id>", "character ID")
  .action(async (characterId) => {
    try {
      const dbPath = await resolveDatabasePath({ requiredConfig: true })
      const db = new Database(dbPath)
      const adapter = new SqliteDatabaseAdapter(db)
      await adapter.init()

      await adapter.removeCharacter(characterId)
      logger.success(`Removed character ${characterId}`)

      await adapter.close()
    } catch (error) {
      handleError(error)
    }
  })


  