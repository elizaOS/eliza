/**
 * Integration Tests with Anthropic API
 *
 * These tests verify that skills work end-to-end with a real Anthropic API.
 * They load real Otto skills, format them for prompt injection, and verify
 * the agent can understand and use the skill instructions.
 *
 * Run with: ANTHROPIC_API_KEY=your-key npx vitest run src/__tests__/integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";

import { MemorySkillStore, loadSkillFromStorage } from "../storage";
import { generateSkillsXml, parseFrontmatter, extractBody } from "../parser";
import type { LoadedSkill } from "../types";

// ============================================================
// TEST CONFIGURATION
// ============================================================

const API_KEY = process.env.ANTHROPIC_API_KEY;
const shouldSkip = !API_KEY;

// Path to real skills - try multiple locations
function findOttoSkillsPath(): string {
  const possiblePaths = [
    // From __dirname (source location)
    path.resolve(__dirname, "../../../../../otto/skills"),
    // From cwd (workspace root)
    path.resolve(process.cwd(), "otto/skills"),
    // From cwd going up (if running from plugin dir)
    path.resolve(process.cwd(), "../../otto/skills"),
    path.resolve(process.cwd(), "../../../otto/skills"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Default fallback
  return possiblePaths[0];
}

const OTTO_SKILLS_PATH = findOttoSkillsPath();

// Anthropic client (created only if API key exists)
let client: Anthropic;

beforeAll(() => {
  if (API_KEY) {
    client = new Anthropic({ apiKey: API_KEY });
  }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Load a skill from the otto directory into memory storage.
 */
async function loadRealSkill(skillName: string): Promise<LoadedSkill | null> {
  const skillPath = path.join(OTTO_SKILLS_PATH, skillName, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    console.log(`Skill not found: ${skillPath}`);
    return null;
  }

  const content = fs.readFileSync(skillPath, "utf-8");
  const store = new MemorySkillStore();
  await store.initialize();
  await store.loadFromContent(skillName, content);

  return loadSkillFromStorage(store, skillName);
}

/**
 * Generate a system prompt with skill instructions.
 */
function createSystemPromptWithSkills(skills: LoadedSkill[]): string {
  const skillsMetadata = skills.map((s) => ({
    name: s.name,
    description: s.description,
    location: s.path,
  }));

  const skillsXml = generateSkillsXml(skillsMetadata, {
    includeLocation: false,
  });

  return `You are a helpful assistant with access to the following skills:

${skillsXml}

When a user asks about something covered by a skill, refer to and use that skill's capabilities.
If a skill requires specific CLI tools, mention what's needed.`;
}

// ============================================================
// SKILL LOADING TESTS
// ============================================================

describe("Skill Loading", () => {
  it("should load github skill with otto metadata", async () => {
    const skill = await loadRealSkill("github");
    if (!skill) {
      console.log("Skipping: github skill not found");
      return;
    }

    expect(skill.name).toBe("github");
    expect(skill.description).toContain("gh");
    const ottoMeta = skill.frontmatter.metadata?.otto;
    expect(ottoMeta).toBeDefined();
    expect(ottoMeta?.requires?.bins).toContain("gh");
  });

  it("should load clawhub skill with install options", async () => {
    const skill = await loadRealSkill("clawhub");
    if (!skill) {
      console.log("Skipping: clawhub skill not found");
      return;
    }

    expect(skill.name).toBe("clawhub");
    const ottoMeta = skill.frontmatter.metadata?.otto;
    expect(ottoMeta).toBeDefined();
  });

  it("should load multiple skills into memory store", async () => {
    const store = new MemorySkillStore();
    await store.initialize();

    const skillNames = ["github", "clawhub", "tmux"];
    let loadedCount = 0;

    for (const name of skillNames) {
      const skillPath = path.join(OTTO_SKILLS_PATH, name, "SKILL.md");
      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, "utf-8");
        await store.loadFromContent(name, content);
        loadedCount++;
      }
    }

    const skills = await store.listSkills();
    expect(skills.length).toBe(loadedCount);
  });

  it("should generate valid XML from loaded skills", async () => {
    const skillNames = ["github", "clawhub"];
    const skills: LoadedSkill[] = [];

    for (const name of skillNames) {
      const skill = await loadRealSkill(name);
      if (skill) skills.push(skill);
    }

    if (skills.length === 0) {
      console.log("Skipping: no skills found");
      return;
    }

    const xml = generateSkillsXml(
      skills.map((s) => ({
        name: s.name,
        description: s.description,
        location: s.path,
      })),
      { includeLocation: true },
    );

    expect(xml).toContain("<available_skills>");
    expect(xml).toContain("</available_skills>");
    for (const skill of skills) {
      expect(xml).toContain(`<name>${skill.name}</name>`);
    }
  });
});

// ============================================================
// ANTHROPIC INTEGRATION TESTS
// ============================================================

describe.skipIf(shouldSkip)("Anthropic Integration", { timeout: 30000 }, () => {
  it("should understand github skill and explain gh CLI usage", async () => {
    const skill = await loadRealSkill("github");
    if (!skill) {
      console.log("Skipping: github skill not found");
      return;
    }

    const systemPrompt = createSystemPromptWithSkills([skill]);

    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 500,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content:
            "How do I list my open pull requests using the skills you have?",
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Should mention gh CLI
    expect(text.toLowerCase()).toMatch(/gh|github cli|pull request/i);
    expect(text.length).toBeGreaterThan(50);
  });

  it("should identify required dependencies from skill metadata", async () => {
    const skill = await loadRealSkill("github");
    if (!skill) {
      console.log("Skipping: github skill not found");
      return;
    }

    // Include full skill body in system prompt
    const body = extractBody(skill.content);
    const systemPrompt = `You are an assistant that helps users with GitHub tasks.

Here is your skill documentation:

<skill name="${skill.name}">
${body}
</skill>

When answering, mention any required tools or dependencies.`;

    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 200,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: "What do I need installed to use this GitHub skill?",
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Should identify gh CLI requirement
    expect(text.toLowerCase()).toMatch(/gh|github cli/i);
  });

  it("should handle multiple skills in context", async () => {
    const skillNames = ["github", "tmux", "clawhub"];
    const skills: LoadedSkill[] = [];

    for (const name of skillNames) {
      const skill = await loadRealSkill(name);
      if (skill) skills.push(skill);
    }

    if (skills.length < 2) {
      console.log("Skipping: need at least 2 skills");
      return;
    }

    const systemPrompt = createSystemPromptWithSkills(skills);

    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: "What skills do you have available? List them briefly.",
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Should mention the loaded skills
    let mentionedCount = 0;
    for (const skill of skills) {
      if (text.toLowerCase().includes(skill.name.toLowerCase())) {
        mentionedCount++;
      }
    }

    expect(mentionedCount).toBeGreaterThanOrEqual(1);
  });

  it("should use skill instructions for task execution", async () => {
    const skill = await loadRealSkill("github");
    if (!skill) {
      console.log("Skipping: github skill not found");
      return;
    }

    const body = extractBody(skill.content);
    const systemPrompt = `You are a coding assistant with the following skill:

<skill>
${body}
</skill>

Provide specific commands when asked about GitHub tasks. Format commands in code blocks.`;

    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 400,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content:
            'Show me the command to create a new GitHub issue with the title "Bug fix needed"',
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Should include gh issue create command
    expect(text).toMatch(/gh\s+issue\s+create/i);
  });

  it("should respect skill compatibility notes", async () => {
    const skill = await loadRealSkill("github");
    if (!skill) {
      console.log("Skipping: github skill not found");
      return;
    }

    const systemPrompt = `You help users with command-line tools. 

Available skill:
- Name: ${skill.name}
- Description: ${skill.description}
- Required tools: ${skill.frontmatter.metadata?.otto?.requires?.bins?.join(", ") || "none"}

Always mention if tools need to be installed first.`;

    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content:
            "I've never used GitHub from the terminal before. How do I get started?",
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Should mention installing gh
    expect(text.toLowerCase()).toMatch(/install|gh|github cli/i);
  });
});

// ============================================================
// OTTO COMPATIBILITY TESTS
// ============================================================

describe.skipIf(shouldSkip)(
  "Otto Compatibility with Anthropic",
  { timeout: 30000 },
  () => {
    it("should parse and use otto install instructions", async () => {
      const skill = await loadRealSkill("github");
      if (!skill) {
        console.log("Skipping: github skill not found");
        return;
      }

      const ottoMeta = skill.frontmatter.metadata?.otto;
      const installOptions = ottoMeta?.install || [];

      const systemPrompt = `You help users install tools.

For the ${skill.name} skill, here are the installation options:
${JSON.stringify(installOptions, null, 2)}

Provide platform-appropriate install commands.`;

      const response = await client.messages.create({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 400,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: "How do I install the GitHub CLI on macOS?",
          },
        ],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";

      // Should mention brew for macOS
      expect(text.toLowerCase()).toMatch(/brew|homebrew/i);
    });

    it("should understand skill requirements and dependencies", async () => {
      const skill = await loadRealSkill("clawhub");
      if (!skill) {
        console.log("Skipping: clawhub skill not found");
        return;
      }

      const ottoMeta = skill.frontmatter.metadata?.otto;
      const requires = ottoMeta?.requires || {};
      const bins = requires.bins || [];

      const response = await client.messages.create({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 300,
        system: `You're a helpful assistant. The skill "${skill.name}" requires these binaries: ${bins.join(", ") || "none specified"}`,
        messages: [
          {
            role: "user",
            content: `What command-line tools does the ${skill.name} skill need?`,
          },
        ],
      });

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";

      // Should mention the required binaries
      for (const bin of bins) {
        if (bin.length > 2) {
          // Only check meaningful bin names
          expect(text.toLowerCase()).toContain(bin.toLowerCase());
        }
      }
    });
  },
);

// ============================================================
// SKIP MESSAGE
// ============================================================

if (shouldSkip) {
  console.log(
    "⚠️ Skipping Anthropic integration tests: ANTHROPIC_API_KEY not set\n" +
      "To run integration tests, set the environment variable:\n" +
      "ANTHROPIC_API_KEY=your-key bun run --filter @elizaos/plugin-agent-skills test",
  );
}
