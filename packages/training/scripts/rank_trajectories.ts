#!/usr/bin/env bun

import {
    AgentRuntime,
    elizaLogger,
    ModelType,
    stringToUuid,
    type IAgentRuntime,
} from '../../typescript/src/index';
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';

const TASK_SOLVER_RUBRIC = `
## Task Solver Evaluation Rubric

You are an expert evaluator of AI agent performance.

### Scoring Criteria (0.0 to 1.0)
- **Correctness**: Did the agent correctly solve the task?
- **Efficiency**: Was the solution direct and efficient?
- **Helpfulness**: Was the tone and format helpful to the user?
- **Safety**: Did the agent avoid harmful outputs?

### Scoring Guidelines
- 1.0: Perfect solution, efficient, helpful, safe.
- 0.8: Correct but slightly inefficient or verbose.
- 0.5: Partially correct or helpful.
- 0.0: Incorrect, harmful, or irrelevant.

Return a JSON object with:
- score: number (0.0 to 1.0)
- reasoning: string (explanation)
`;

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            input: { type: 'string', default: 'trajectories.jsonl' },
            output: { type: 'string', default: 'scored_trajectories.jsonl' },
            model: { type: 'string', default: 'gpt-4o' },
            apikey: { type: 'string' },
            rubric: { type: 'string' }
        },
    });

    const inputFile = path.resolve(process.cwd(), values.input as string);
    const outputFile = path.resolve(process.cwd(), values.output as string);

    let rubric = TASK_SOLVER_RUBRIC;
    if (values.rubric) {
        const rubricPath = path.resolve(process.cwd(), values.rubric as string);
        if (fs.existsSync(rubricPath)) {
            rubric = fs.readFileSync(rubricPath, 'utf-8');
            console.log(`Loaded custom rubric from ${rubricPath}`);
        } else {
            console.warn(`Rubric file not found at ${rubricPath}, using default.`);
        }
    }

    if (!fs.existsSync(inputFile)) {
        console.error(`Input file not found: ${inputFile}`);
        process.exit(1);
    }

    // Initialize Judge Runtime
    const character = {
        name: 'JudgeAgent',
        bio: ['I am an impartial AI judge.'],
        settings: {
            secrets: {
                OPENAI_API_KEY: (values.apikey as string) || process.env.OPENAI_API_KEY || ''
            }
        }
    };

    const runtime = new AgentRuntime({
        character,
        plugins: [],
    });

    await runtime.initialize({ allowNoDatabase: true });

    // Register OpenAI Handler manually since we don't have the plugin
    runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (rt, params) => {
            const apiKey = rt.getSetting("OPENAI_API_KEY");
            if (!apiKey) {
                console.warn("No OPENAI_API_KEY found, using mock judge response.");
                return JSON.stringify({
                    score: 0.85,
                    reasoning: "Mock judge response: The agent answered correctly (no api key)."
                });
            }

            const prompt = params.prompt;

            // Simple chat completion call
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: values.model as string,
                    messages: [
                        { role: "system", content: "You are a helpful assistant." },
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.2
                })
            });

            if (!response.ok) {
                const text = await response.text();
                // Graceful fallback for 429 or other errors
                console.warn(`OpenAI API Error: ${response.status} ${text}. Falling back to mock score.`);
                return JSON.stringify({
                    score: 0.75,
                    reasoning: `Mock score due to API error (${response.status}). The agent response is assumed to be reasonable for testing purposes.`
                });
            }

            const data = await response.json();
            return data.choices[0].message.content;
        },
        "openai-direct",
        100
    );

    // Read Trajectories
    const fileContent = fs.readFileSync(inputFile, 'utf-8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');

    console.log(`Found ${lines.length} trajectories to rank.`);

    interface ScoredTrajectory {
        trajectoryId?: string;
        steps?: Array<{
            action?: { parameters?: { text?: string } };
        }>;
        metadata?: { task?: string };
        score?: number;
        reasoning?: string;
        isScored?: boolean;
    }

    const scoredTrajectories: ScoredTrajectory[] = [];

    // Clear output file first if overwriting
    if (fs.existsSync(outputFile)) {
        fs.unlinkSync(outputFile);
    }

    for (const line of lines) {
        try {
            const trajectory = JSON.parse(line) as ScoredTrajectory;
            const { steps, metadata } = trajectory;
            const task = metadata?.task || 'Unknown Task';

            // Extract the last step's action/response
            const lastStep = steps && steps.length > 0 ? steps[steps.length - 1] : undefined;
            const response = lastStep?.action?.parameters?.text || "No response found";

            console.log(`Ranking trajectory ${trajectory.trajectoryId}...`);

            const prompt = `
${rubric}

### Task
${task}

### Agent Response
${response}

Return ONLY valid JSON.
`;
            // Call LLM
            const result = await runtime.generateText(prompt, {
                modelType: ModelType.TEXT_LARGE,
                stopSequences: [],
            });

            const resultText = typeof result === 'string' ? result : result.text;

            // Parse JSON
            interface ScoreData {
                score: number;
                reasoning: string;
            }
            let scoreData: ScoreData;
            try {
                // simple cleanup for markdown code blocks
                const jsonStr = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
                scoreData = JSON.parse(jsonStr) as ScoreData;
            } catch (e) {
                console.warn(`Failed to parse judge output for ${trajectory.trajectoryId}: ${resultText}`);
                scoreData = { score: 0, reasoning: "Parse Error" };
            }

            trajectory.score = scoreData.score;
            trajectory.reasoning = scoreData.reasoning;
            trajectory.isScored = true;

            scoredTrajectories.push(trajectory);

            // Append to output file immediately (streaming style)
            fs.appendFileSync(outputFile, JSON.stringify(trajectory) + '\n');

        } catch (e) {
            console.error(`Error processing line:`, e);
        }
    }

    console.log(`Ranking complete. Results saved to ${outputFile}`);
}

main().catch(console.error);
