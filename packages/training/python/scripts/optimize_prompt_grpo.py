import argparse
import json
import re
import random
import os
import mlx.core as mx
from mlx_lm import load, generate
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# -------------------------------------------------------------------------
# Reward Function (Copied from train_grpo.py)
# -------------------------------------------------------------------------
ACTION_RE = re.compile(r"<action>\s*(.*?)\s*</action>", re.DOTALL)

def compute_rewards(prompts, completions):
    """
    Reward function for shouldRespond task.
    Returns list of scores.
    """
    rewards = []
    
    for prompt, text in zip(prompts, completions):
        score = 0.0
        
        # Parse action
        action_match = ACTION_RE.search(text)
        action = action_match.group(1).strip().upper() if action_match else "NONE"
        
        # Heuristics
        last_user_msg = prompt.split("User:")[-1] if "User:" in prompt else prompt
        is_direct_mention = ("@Eliza" in last_user_msg or "Eliza" in last_user_msg)
        is_stop = any(w in last_user_msg.lower() for w in ["stop", "shut up", "quiet", "be quiet"])
        is_continuation = "Eliza:" in prompt
        is_ambiguous = any(w in last_user_msg.lower() for w in ["anyone", "anybody", "help", "assist", "question", "somebody"])
        should_respond = is_direct_mention or is_continuation or is_ambiguous
        
        # Scoring
        if is_stop:
            if action == "STOP": score += 1.0
            elif action == "IGNORE": score += 0.3
            else: score -= 0.3
        elif should_respond:
            if action == "RESPOND": score += 1.0
            else: score -= 0.3
        else: # should ignore
            if action == "IGNORE": score += 1.0
            else: score -= 0.3
            
        # Format bonus
        if "<response>" in text and "</response>" in text:
            score += 0.2
        if action == "NONE":
            score -= 0.5
            
        rewards.append(score)
        
    return rewards

# -------------------------------------------------------------------------
# Meta-Optimizer
# -------------------------------------------------------------------------
META_PROMPT_TEMPLATE = """You are an expert Prompt Engineer optimizing a system prompt for an AI agent.

Current System Prompt:
"{current_prompt}"

Task:
The AI needs to decide whether to REPLY, IGNORE, or STOP based on a chat history.
It MUST output valid XML: <response><name>Eliza</name><reason>...</reason><action>...</action></response>.

Here are some examples of the AI's performance with the current prompt:

[SUCCESSFUL EXAMPLE]
Input: {good_input}
Output: {good_output}
Reward: {good_score} (This was good!)

[FAILED EXAMPLE]
Input: {bad_input}
Output: {bad_output}
Reward: {bad_score} (This was bad!)

[INSTRUCTIONS]
Analyze why the successful example worked and the failed one didn't.
Rewrite the System Prompt to fix the failure case while maintaining the success case.
The new prompt should be concise, clear, and emphasize the XML format and the decision logic.
Return ONLY the new system prompt text. Do not add explanations.
"""

def call_external_model(provider, model_name, prompt):
    """
    Call external API (Groq or Anthropic) to optimize the prompt.
    """
    try:
        if provider == "groq":
            from groq import Groq
            client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
            chat_completion = client.chat.completions.create(
                messages=[
                    {"role": "system", "content": "You are an expert prompt engineer."},
                    {"role": "user", "content": prompt}
                ],
                model=model_name,
                temperature=0.7,
                max_tokens=1024,
            )
            return chat_completion.choices[0].message.content
            
        elif provider == "anthropic":
            import anthropic
            client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
            message = client.messages.create(
                model=model_name,
                max_tokens=1024,
                messages=[
                    {"role": "user", "content": prompt}
                ]
            )
            return message.content[0].text
            
        elif provider == "openai":
            from openai import OpenAI
            client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
            completion = client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": "You are an expert prompt engineer."},
                    {"role": "user", "content": prompt}
                ]
            )
            return completion.choices[0].message.content
            
        else:
            raise ValueError(f"Unknown provider: {provider}")
            
    except Exception as e:
        print(f"Error calling {provider}: {e}")
        return None

def optimize_prompt(provider, model_name, current_prompt, good_example, bad_example):
    meta_prompt = META_PROMPT_TEMPLATE.format(
        current_prompt=current_prompt,
        good_input=good_example['prompt'],
        good_output=good_example['output'],
        good_score=good_example['score'],
        bad_input=bad_example['prompt'],
        bad_output=bad_example['output'],
        bad_score=bad_example['score']
    )
    
    new_prompt = call_external_model(provider, model_name, meta_prompt)
    
    if new_prompt:
        # Simple cleanup: remove quotes if the model added them
        new_prompt = new_prompt.strip()
        if new_prompt.startswith('"') and new_prompt.endswith('"'):
            new_prompt = new_prompt[1:-1]
        return new_prompt
    else:
        return current_prompt

# -------------------------------------------------------------------------
# Main Loop
# -------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=str, default="mlx-community/Qwen2.5-1.5B-Instruct-4bit")
    parser.add_argument("--data", type=str, required=True)
    parser.add_argument("--iter", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--save-path", type=str, default="optimized_prompt.txt")
    parser.add_argument("--optimizer-provider", type=str, default="groq", choices=["groq", "anthropic", "openai"])
    parser.add_argument("--optimizer-model", type=str, default="llama-3.3-70b-versatile")
    args = parser.parse_args()
    
    print(f"Loading Evaluator Model: {args.model}...")
    model, tokenizer = load(args.model)
    
    print(f"Using Meta-Optimizer: {args.optimizer_provider} ({args.optimizer_model})")
    
    # Load Data
    prompts = []
    with open(args.data, 'r') as f:
        for line in f:
            if line.strip():
                item = json.loads(line)
                user_msg = next((m["content"] for m in reversed(item["messages"]) if m["role"] == "user"), None)
                if user_msg: prompts.append(user_msg)
                
    random.shuffle(prompts)
    
    # Initialize Prompt
    # Initialize Prompt
    current_system_prompt = (
        "You are an AI assistant named Eliza. "
        "Decide whether to REPLY, IGNORE, or STOP. "
        "You MUST respond in valid XML format: "
        "<response><name>Eliza</name><reason>...</reason><action>REPLY/IGNORE/STOP</action></response>."
    )
    best_overall_avg_score = -float('inf')
    
    print(f"Starting Training-Free GRPO for {args.iter} iterations...")
    
    for i in range(args.iter):
        print(f"\n=== Iteration {i+1}/{args.iter} ===")
        
        # 1. Sample Batch
        batch_prompts = random.sample(prompts, args.batch_size)
        
        batch_results = []
        
        # 2. Evaluate Current Prompt on Batch
        print(f"Evaluating current prompt on {len(batch_prompts)} examples...")
        current_scores = []
        
        for p in batch_prompts:
            # Construct full prompt with system instruction
            messages = [
                {"role": "system", "content": current_system_prompt},
                {"role": "user", "content": p}
            ]
            full_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            output = generate(model, tokenizer, prompt=full_text, max_tokens=100, verbose=False)
            
            # Score
            score = compute_rewards([p], [output])[0]
            current_scores.append(score)
            
            batch_results.append({
                "prompt": p,
                "output": output,
                "score": score
            })
            
        avg_score = sum(current_scores) / len(current_scores)
        print(f"Avg Score: {avg_score:.2f}")
        
        if avg_score > best_overall_avg_score:
            best_overall_avg_score = avg_score
            print(f"New Best Score! Saving prompt to {args.save_path}...")
            with open(args.save_path, "w") as f:
                f.write(current_system_prompt)
        
        # 3. Select Good and Bad Examples
        # Sort by score
        batch_results.sort(key=lambda x: x['score'], reverse=True)
        good = batch_results[0]
        bad = batch_results[-1]
        
        if good['score'] > bad['score']:
            # Variance exists, we can learn
            print(f"Optimizing: Good ({good['score']}) vs Bad ({bad['score']})")
            print(f"Good Output: {good['output'][:50]}...")
            print(f"Bad Output: {bad['output'][:50]}...")
            
            new_prompt = optimize_prompt(args.optimizer_provider, args.optimizer_model, current_system_prompt, good, bad)
            print(f"\nNew Prompt Proposed:\n{new_prompt}\n")
            current_system_prompt = new_prompt
        else:
            print("No variance in batch (all good or all bad). Skipping optimization step.")
            
    print("\noptimization Complete.")
    print(f"Final Prompt saved to {args.save_path}")

if __name__ == "__main__":
    main()
