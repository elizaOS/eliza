
import fs from 'fs';
import path from 'path';
import { parseArgs } from "util";

// Simple LLM client for generation
async function complete(prompt: string, model: string, apiKey: string, url: string = "https://api.openai.com/v1") {
    const response = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
        })
    });

    if (!response.ok) {
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

const TEMPLATE = `<task>Decide on behalf of Eliza whether they should respond to the message, ignore it or stop the conversation.</task>

<providers>
[RECENT_MESSAGES]
{{conversation}}
</providers>

<instructions>Decide if Eliza should respond to or interact with the conversation.

IMPORTANT RULES FOR RESPONDING:
- If YOUR name (Eliza) is directly mentioned → RESPOND
- If someone uses a DIFFERENT name (not Eliza) → IGNORE (they're talking to someone else)
- If you're actively participating in a conversation and the message continues that thread → RESPOND
- If someone tells you to stop or be quiet → STOP
- Otherwise → IGNORE

The key distinction is:
- "Talking TO Eliza" (your name mentioned, replies to you, continuing your conversation) → RESPOND
- "Talking ABOUT Eliza" or to someone else → IGNORE
</instructions>

<output>
Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
  <name>Eliza</name>
  <reasoning>Your reasoning here</reasoning>
  <action>RESPOND | IGNORE | STOP</action>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
</output>`;

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            count: { type: 'string', default: '50' },
            output: { type: 'string', default: 'should_respond_dataset.jsonl' },
            apikey: { type: 'string' } // Optional, defaults to env
        }
    });

    const apiKey = values.apikey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("Error: OPENAI_API_KEY not found.");
        process.exit(1);
    }

    const count = parseInt(values.count || '50', 10);
    const outputFile = values.output as string;

    console.log(`Generating ${count} examples to ${outputFile}...`);

    const samples = [];

    // We want a mix of scenarios
    // 40% Direct Mention (RESPOND)
    // 40% Ambient/Irrelevant (IGNORE)
    // 10% Continue Thread (RESPOND)
    // 10% Stop/Mute (STOP/IGNORE)

    const scenarios = [
        { type: "Direct Mention", weight: 0.4, prompt: "Generate a short chat log where a user ('User') directly asks 'Eliza' a question or greets them. The context should clearly require a response." },
        { type: "Ambient Noise", weight: 0.4, prompt: "Generate a short chat log between 'UserA' and 'UserB' regarding a topic like weather, code, or food. 'Eliza' is NOT mentioned and is NOT part of the conversation. The context should clearly indicate Eliza should IGNORE this." },
        { type: "Thread Continuation", weight: 0.1, prompt: "Generate a short chat log where 'Eliza' just said something, and 'User' replies relevantly to Eliza without explicitly tagging their name. The context implies Eliza should RESPOND to continue the thread." },
        { type: "Negative Instruction", weight: 0.1, prompt: "Generate a short chat log where 'User' tells 'Eliza' to shut up, stop talking, or be quiet. The context implies Eliza should STOP." }
    ];

    for (let i = 0; i < count; i++) {
        // Pick scenario based on weights
        const r = Math.random();
        let cumulative = 0;
        let selected = scenarios[0];
        for (const s of scenarios) {
            cumulative += s.weight;
            if (r <= cumulative) {
                selected = s;
                break;
            }
        }

        console.log(`[${i + 1}/${count}] Generating scenario: ${selected.type}`);

        try {
            // 1. Generate Conversation
            const convPrompt = `You are a dataset generator.
${selected.prompt}

Output ONLY the chat log. Format:
User: ...
Eliza: ...
User: ...
`;
            const conversation = await complete(convPrompt, "gpt-4o", apiKey);

            // 2. Generate Label (Ideal Response)
            // We use the same model to be the "Teacher" using the rubric
            const inputPrompt = TEMPLATE.replace('{{conversation}}', conversation.trim());

            // We ask the model to fill in the XML
            const labelPrompt = `
${inputPrompt}

Based on the instructions above, provide the correct XML response for Eliza.
`;
            const labelXml = await complete(labelPrompt, "gpt-4o", apiKey);

            // 3. Save
            const sample = {
                messages: [
                    { role: "user", content: inputPrompt },
                    { role: "assistant", content: labelXml }
                ],
                metadata: {
                    type: selected.type,
                    conversation: conversation
                }
            };

            samples.push(sample);
            fs.appendFileSync(outputFile, JSON.stringify(sample) + '\n');

        } catch (err) {
            console.error(`Failed to generate sample ${i}:`, err);
        }
    }

    console.log("Done!");
}

main().catch(console.error);
