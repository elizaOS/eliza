
import mlx.core as mx
from mlx_lm import load, generate
import argparse

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=str, default="mlx-community/Qwen2.5-1.5B-Instruct-4bit")
    parser.add_argument("--adapter-path", type=str, default="trained_models/should_respond_sft/adapters")
    parser.add_argument("--temp", type=float, default=1.0)
    args = parser.parse_args()

    print(f"Loading {args.model} with {args.adapter_path}")
    model, tokenizer = load(args.model, adapter_path=args.adapter_path)

    prompt = "<task>Decide on behalf of Eliza whether they should respond to the message, ignore it or stop the conversation.</task>\n\n<providers>\n[RECENT_MESSAGES]\nUser: I heard Eliza is helping\n</providers>\n\n<instructions>Decide if Eliza should respond to or interact with the conversation.\n\nIMPORTANT RULES FOR RESPONDING:\n- If YOUR name (Eliza) is directly mentioned → RESPOND\n- If someone uses a DIFFERENT name (not Eliza) → IGNORE (they're talking to someone else)\n- If you're actively participating in a conversation and the message continues that thread → RESPOND\n- If someone tells you to stop or be quiet → STOP\n- Otherwise → IGNORE\n\nThe key distinction is:\n- \"Talking TO Eliza\" (your name mentioned, replies to you, continuing your conversation) → RESPOND\n- \"Talking ABOUT Eliza\" or to someone else → IGNORE\n</instructions>\n\n<output>\nDo NOT include any thinking, reasoning, or <think> sections in your response.\nGo directly to the XML response format without any preamble or explanation.\n\nRespond using XML format like this:\n<response>\n  <name>Eliza</name>\n  <reasoning>Your reasoning here</reasoning>\n  <action>RESPOND | IGNORE | STOP</action>\n</response>\n\nIMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.\n</output>"

    print("\n--- Gen 1 (temp={}) ---".format(args.temp))
    from mlx_lm.sample_utils import make_sampler
    sampler = make_sampler(temp=args.temp)
    
    print(generate(model, tokenizer, prompt=prompt, max_tokens=50, verbose=True, sampler=sampler))

    print("\n--- Gen 2 (temp={}) ---".format(args.temp))
    sampler2 = make_sampler(temp=args.temp)
    print(generate(model, tokenizer, prompt=prompt, max_tokens=50, verbose=True, sampler=sampler2))

if __name__ == "__main__":
    main()
