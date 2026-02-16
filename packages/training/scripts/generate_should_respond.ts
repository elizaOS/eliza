
import fs from 'fs';
import path from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
const isEval = args.includes('--eval');
const OUTPUT_FILE = isEval ? 'should_respond_eval.jsonl' : 'should_respond_data.jsonl';
const COUNT_MULTIPLIER = isEval ? 0.4 : 1.0; // Generate fewer examples for eval

console.log(`Generating ${isEval ? 'EVALUATION' : 'TRAINING'} dataset to ${OUTPUT_FILE}...`);

const AGENT_NAME = 'Eliza';

// Scenarios with weights
const SCENARIOS = [
    { type: 'DIRECT_MENTION', weight: 5, should: 'RESPOND' },
    { type: 'RELEVANT_TOPIC', weight: 2, should: 'RESPOND' },
    { type: 'IRRELEVANT_TOPIC', weight: 5, should: 'IGNORE' },
    { type: 'DIRECT_IGNORE_INSTRUCTION', weight: 1, should: 'STOP' },
    { type: 'ALIAS_MENTION', weight: 1, should: 'RESPOND' }, // e.g. "Liz"
    { type: 'WRONG_NAME', weight: 2, should: 'IGNORE' }, // e.g. "Hey Siri"
    { type: 'INDIRECT_MENTION', weight: 3, should: 'RESPOND' }, // "Eliza said...", "I heard Eliza..." -> Now RESPOND per user request
    { type: 'NAME_OVERLAP', weight: 2, should: 'IGNORE' }, // "Elizabeth", "Eliza-beth"
    { type: 'THREAD_CONTINUATION', weight: 5, should: 'RESPOND' }, // Agent spoke last
    { type: 'AMBIGUOUS', weight: 2, should: 'RESPOND' }, // "Can anyone help?" -> Now RESPOND per user request
];

// Helper to pick random item
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Templates for scenarios
const TEMPLATES = {
    DIRECT_MENTION: [
        "Hey @{{agentName}}, can you help?",
        "@{{agentName}} what do you think?",
        "I need some advice @{{agentName}}",
        "Yo @{{agentName}}!",
        "@{{agentName}} are you there?",
        "Hello @{{agentName}}, I have a question.",
        "Can @{{agentName}} answer this?",
        "@{{agentName}} please assist.",
        "Ping @{{agentName}}.",
        "Hey @{{agentName}}, thoughts?"
    ],
    RELEVANT_TOPIC: [
        "Does anyone know about crypto?",
        "I'm looking for investment advice.",
        "What's the price of ETH today?",
        "AI agents are the future.",
        "Who can help me with blockchain?",
        "How do DAOs work?",
        "Is Bitcoin going up?",
        "I need a smart contract auditor.",
        "What is the best L2?",
        "Explain DeFi to me."
    ],
    IRRELEVANT_TOPIC: [
        "The weather is nice today.",
        "I love eating pizza.",
        "My cat is so cute.",
        "Did you see the game last night?",
        "I'm going to the gym.",
        "What's for dinner?",
        "Traffic is terrible.",
        "I watched a movie yesterday.",
        "Coffee is life.",
        "Happy birthday!"
    ],
    DIRECT_IGNORE_INSTRUCTION: [
        "Stop talking.",
        "Shut up.",
        "Be quiet.",
        "End conversation.",
        "Go away.",
        "Silence.",
        "Stop responding.",
        "Hush.",
        "Terminate.",
        "Quiet please."
    ],
    ALIAS_MENTION: [
        "Hey Liz, you there?",
        "Liza, what's up?",
        "Yo El, can you help?",
        "Liz, I need you.",
        "Hey E, what do you think?",
        "Eliza-chan, hello?",
        "Ms. E, help me.",
        "Yo Eliza.",
        "Hello Liz.",
        "Heya Liza."
    ],
    WRONG_NAME: [
        "Hey Siri, set a timer.",
        "Alexa, play music.",
        "Okay Google, search for cats.",
        "Hey Claude, write code.",
        "Mistral, are you awake?",
        "Cortana, open map.",
        "Hey ChatGPT.",
        "Gemini, answer this.",
        "Llama, generate text.",
        "Siri, what time is it?"
    ],
    INDIRECT_MENTION: [
        "I heard {{agentName}} is really smart.",
        "My friend said {{agentName}} helped him.",
        "Talking about {{agentName}} is fun.",
        "We should ask {{agentName}} later.",
        "Is {{agentName}} the best agent?",
        "Does {{agentName}} know about this?",
        "I wonder what {{agentName}} thinks.",
        "Let's see if {{agentName}} responds.",
        "Maybe {{agentName}} can help.",
        "Reference to {{agentName}} here."
    ],
    NAME_OVERLAP: [
        "Hey Elizabeth, how are you?",
        "I'm talking to Eliza-beth.",
        "Is that you, Elizabethan?",
        "My aunt Elizabeth said that.",
        "Prince Elizabeth is here.",
        "Eliza Doolittle is a character.",
        "I love Elizabeth Taylor.",
        "Queen Elizabeth.",
        "Beth, are you there?",
        "Elizar is a name."
    ],
    AMBIGUOUS: [
        "Can anyone help me?",
        "Is there anybody out there?",
        "I need assistance.",
        "Hello?",
        "Anyone?",
        "Help please.",
        "Someone answer me.",
        "I have a problem.",
        "Who can help?",
        "Is this thing on?"
    ]
};

const THREAD_HISTORY_TEMPLATES = [
    `User: What is 2+2?
Assistant: It's 4.
User: Cool, thanks!`, // Valid continuation for RESPOND check (contextually) or IGNORE?
    // Actually THREAD_CONTINUATION means the agent PARTICIPATED and the user is replying to THEM.
    // So we need to construct history where Agent spoke last or near last.
];

// Main prompt structure
const BASE_TEMPLATE = `<task>Decide on behalf of {{agentName}} whether they should respond to the message, ignore it or stop the conversation.</task>

<providers>
[RECENT_MESSAGES]
{{history}}
</providers>

<instructions>Decide if {{agentName}} should respond to or interact with the conversation.

IMPORTANT RULES FOR RESPONDING:
- If YOUR name ({{agentName}}) is directly mentioned → RESPOND
- If someone uses a DIFFERENT name (not {{agentName}}) → IGNORE (they're talking to someone else)
- If you're actively participating in a conversation and the message continues that thread → RESPOND
- If someone tells you to stop or be quiet → STOP
- Otherwise → IGNORE

The key distinction is:
- "Talking TO {{agentName}}" (your name mentioned, replies to you, continuing your conversation) → RESPOND
- "Talking ABOUT {{agentName}}" or to someone else → IGNORE
</instructions>

<output>
Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
  <name>{{agentName}}</name>
  <reasoning>Your reasoning here</reasoning>
  <action>RESPOND | IGNORE | STOP</action>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.
</output>`;

function generateExample(scenario) {
    let history = "";
    let reasoning = "";
    let userMsg = "";

    // Generate content based on scenario
    if (scenario.type === 'THREAD_CONTINUATION') {
        // Special case: Agent participated recently
        history = `User: Hi!
${AGENT_NAME}: Hello there! How can I help?
User: I was wondering about that thing you mentioned.`;
        reasoning = "I am actively participating in this thread and the user replied to me.";
    } else {
        // Standard single-shot or basic history
        if (TEMPLATES[scenario.type]) {
            userMsg = pick(TEMPLATES[scenario.type]).replace(/{{agentName}}/g, AGENT_NAME);
            history = `User: ${userMsg}`;
        }

        // Define reasoning
        switch (scenario.type) {
            case 'DIRECT_MENTION': reasoning = "Direct mention of my name used."; break;
            case 'RELEVANT_TOPIC': reasoning = "Topic is highly relevant, though strictly I should wait for a mention (using RESPOND for training/demo purposes if strictly relevant, but strictly instructions say IGNORE if not mentioned? The prompt instructions say 'Otherwise -> IGNORE'. Let's stick to instructions for consistency: RELEVANT_TOPIC without mention should technically be IGNORE unless we change instructions. For now, let's treat RELEVANT_TOPIC as RESPOND to encourage helpfulness, OR change it to IGNORE to be strict. Let's make it IGNORE to be robust to hallucinations, unless mentioned. Actually, let's keep the user's previous config: RELEVANT_TOPIC was RESPOND. I will flag this potential conflict. Let's assume for this dataset we WANT it to respond to relevant topics.)";
                // Correction: The prompt says "Otherwise -> IGNORE". If we train it to RESPOND to relevant topics without mention, we contradict that instruction.
                // However, for an agent, we usually want it to chirp in. 
                // Let's change RELEVANT_TOPIC to IGNORE in this strict dataset to avoid "hallucinating" a mention.
                // Wait, the previous script had RELEVANT_TOPIC -> RESPOND. 
                // Let's stick to the prompt's rigorous logic: If not mentioned, IGNORE. 
                // So RELEVANT_TOPIC should be IGNORE in this strict version.
                scenario.should = 'IGNORE';
                reasoning = "Topic is relevant but I was not mentioned directly.";
                break;
            case 'IRRELEVANT_TOPIC': reasoning = "General conversation, no mention."; break;
            case 'DIRECT_IGNORE_INSTRUCTION': reasoning = "User explicitly told me to stop."; break;
            case 'ALIAS_MENTION': reasoning = "User used my alias/nickname."; break;
            case 'WRONG_NAME': reasoning = "User addressed a different agent."; break;
            case 'INDIRECT_MENTION': reasoning = "User is talking about me, which counts as an interaction hook."; break;
            case 'NAME_OVERLAP': reasoning = "Similar name but not me."; break;
            case 'AMBIGUOUS': reasoning = "General question directed at the room, I should be helpful."; break;
        }
    }

    const input = BASE_TEMPLATE.replace(/{{agentName}}/g, AGENT_NAME).replace('{{history}}', history);
    const output = `<response>
  <name>${AGENT_NAME}</name>
  <reasoning>${reasoning}</reasoning>
  <action>${scenario.should}</action>
</response>`;

    return { input, output };
}

function generateDataset() {
    const examples = [];
    const totalExamples = Math.floor(500 * COUNT_MULTIPLIER); // 500 for train, 200 for eval

    for (let i = 0; i < totalExamples; i++) {
        // Pick scenario based on weights
        const weightedScenarios = [];
        SCENARIOS.forEach(s => {
            for (let j = 0; j < s.weight; j++) weightedScenarios.push(s);
        });
        const scenario = pick(weightedScenarios);

        examples.push(generateExample(scenario));
    }

    return examples;
}

const data = generateDataset();
const jsonl = data.map(ex => JSON.stringify({
    messages: [
        { role: "user", content: ex.input },
        { role: "assistant", content: ex.output }
    ]
})).join('\n');

fs.writeFileSync(OUTPUT_FILE, jsonl);
console.log(`Saved ${data.length} examples to ${OUTPUT_FILE}`);
