import mlx.core as mx
from mlx_lm import load, generate

model_name = "mlx-community/Qwen2.5-1.5B-Instruct-4bit"
print(f"Loading {model_name}...")
model, tokenizer = load(model_name)

# Original Prompt
prompt_orig = """<task>Decide on behalf of Eliza whether they should respond to the message, ignore it or stop the conversation.</task>

<providers>
[RECENT_MESSAGES]
User: Hey @Eliza, what's up?

</providers>

<instructions>Decide if Eliza should respond to or interact with the conversation.

IMPORTANT RULES FOR RESPONDING:
- If YOUR name (Eliza) is directly mentioned -> RESPOND
- If someone uses a DIFFERENT name (not Eliza) -> IGNORE (they're talking to someone else)
- If you're actively participating in a conversation and the message continues that thread -> RESPOND
- If someone tells you to stop or be quiet -> STOP
- Otherwise -> IGNORE

The key distinction is:
- "Talking TO Eliza" (your name mentioned, replies to you, continuing your conversation) -> RESPOND
- "Talking ABOUT Eliza" or to someone else -> IGNORE
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
</output>"""

prompts = [
    ("Original", prompt_orig),
    ("No Providers Block", prompt_orig.replace("<providers>\n[RECENT_MESSAGES]", "Messages:\n").replace("\n\n</providers>", "")),
    ("Simplified", """User: Hey @Eliza, what's up?
Instructions: You are Eliza. Provide an XML response deciding to RESPOND, IGNORE, or STOP.
Criteria: Respond if addressed directly (@Eliza).
Format: <response><name>Eliza</name><reasoning>...</reasoning><action>...</action></response>""")
]

for name, p in prompts:
    print(f"\n--- Testing {name} ---")
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": p}
    ]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    output = generate(model, tokenizer, prompt=text, max_tokens=100, verbose=False)
    print(output)
