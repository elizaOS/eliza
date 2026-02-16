
import argparse
import json
import re
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import mlx.core as mx
from mlx_lm import load, generate

def extract_action(text):
    match = re.search(r"<action>(.*?)</action>", text, re.DOTALL)
    if match:
        return match.group(1).strip().upper()
    return "NONE"

def is_valid_format(text):
    return "<response>" in text and "</response>" in text and "<action>" in text and "</action>" in text

def run_inference(model_path, adapter_path, prompts, ground_truths, label="Model", verbose=False, args=None):
    print(f"Loading {label} from {model_path} (adapter: {adapter_path})...")
    model, tokenizer = load(model_path, adapter_path=adapter_path)
    
    results = []
    correct_count = 0
    valid_format_count = 0
    
    for i, prompt in enumerate(prompts):
        print(f"Generating {i+1}/{len(prompts)}...")
        
        # Apply chat template to match training
        system_prompt = "You are a helpful assistant."
        if hasattr(args, "system_prompt_file") and args.system_prompt_file:
            with open(args.system_prompt_file, 'r') as f:
                system_prompt = f.read().strip()

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ]
        
        try:
             # apply_chat_template returns a string if tokenize=False
             # We want the text prompt that the model sees
             full_prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
             
             text = generate(model, tokenizer, prompt=full_prompt, max_tokens=100, verbose=verbose)
        except TypeError:
             # Fallback if arguments differ in version
             full_prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
             text = generate(model, tokenizer, prompt=full_prompt, max_tokens=100, verbose=verbose)
        
        pred_action = extract_action(text)
        true_action = extract_action(ground_truths[i])
        
        is_correct = (pred_action == true_action)
        is_valid = is_valid_format(text)
        
        if is_correct: correct_count += 1
        if is_valid: valid_format_count += 1
        
        results.append({
            "prompt": prompt,
            "generated": text,
            "predicted_action": pred_action,
            "ground_truth_action": true_action,
            "is_correct": is_correct,
            "is_valid_format": is_valid
        })
        
    accuracy = correct_count / len(prompts)
    format_compliance = valid_format_count / len(prompts)
    
    return {
        "model": label,
        "accuracy": accuracy,
        "format_compliance": format_compliance,
        "details": results
    }

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", type=str, default="mlx-community/Qwen2.5-1.5B-Instruct-4bit")
    parser.add_argument("--sft-adapter", type=str, required=True)
    parser.add_argument("--rl-adapter", type=str, required=False)
    parser.add_argument("--pure-rl-adapter", type=str, required=False, help="Path to RL-only adapter")
    parser.add_argument("--data", type=str, required=True)
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--verbose", action="store_true", help="Enable verbose generation output")
    parser.add_argument("--system-prompt-file", type=str, help="Path to custom system prompt file")
    args = parser.parse_args()
    
    # Load prompts and ground truths
    prompts = []
    ground_truths = []
    
    print("Loading data...")
    with open(args.data, 'r') as f:
        for line in f:
            if not line.strip(): continue
            try:
                item = json.loads(line)
                if "messages" in item:
                    # User message is prompt, Assistant message is ground truth
                    user_msg = next((m["content"] for m in reversed(item["messages"]) if m["role"] == "user"), None)
                    asst_msg = next((m["content"] for m in reversed(item["messages"]) if m["role"] == "assistant"), None)
                    
                    if user_msg and asst_msg:
                        prompts.append(user_msg)
                        ground_truths.append(asst_msg)
            except:
                pass
    
    # Select subset
    subset_indices = range(min(args.count, len(prompts)))
    selected_prompts = [prompts[i] for i in subset_indices]
    selected_truths = [ground_truths[i] for i in subset_indices]

    if not selected_prompts:
        print("No prompts found.")
        return

    print(f"--- Running Benchmark on {len(selected_prompts)} samples ---")
    
    metrics = []
    
    # 1. Base Model
    base_metrics = run_inference(args.base_model, None, selected_prompts, selected_truths, "Base Model", verbose=args.verbose, args=args)
    metrics.append(base_metrics)
    
    # 2. SFT Model
    sft_metrics = run_inference(args.base_model, args.sft_adapter, selected_prompts, selected_truths, "SFT Model", verbose=args.verbose, args=args)
    metrics.append(sft_metrics)
    
    # 3. Pure RL Model (Base -> RL)
    if args.pure_rl_adapter:
        try:
             pure_rl_metrics = run_inference(args.base_model, args.pure_rl_adapter, selected_prompts, selected_truths, "Pure RL Model", verbose=args.verbose, args=args)
             metrics.append(pure_rl_metrics)
        except Exception as e:
             print(f"Failed to run Pure RL benchmark: {e}")

    # 4. SFT+RL Model (SFT -> RL)
    if args.rl_adapter:
        rl_metrics = run_inference(args.base_model, args.rl_adapter, selected_prompts, selected_truths, "SFT+RL Model", verbose=args.verbose, args=args)
        metrics.append(rl_metrics)
    
    # Save Results
    with open("benchmark_results.json", "w") as f:
        json.dump(metrics, f, indent=2)
    print("\nSaved detailed results to benchmark_results.json")

    # Print Summary
    print("\n=== SUMMARY ===")
    print(f"{'Model':<15} | {'Accuracy':<10} | {'Format':<10}")
    print("-" * 40)
    for m in metrics:
        print(f"{m['model']:<15} | {m['accuracy']:.2%}     | {m['format_compliance']:.2%}")

    # Plotting
    try:
        models = [m['model'] for m in metrics]
        accuracies = [m['accuracy'] for m in metrics]
        formats = [m['format_compliance'] for m in metrics]
        
        x = range(len(models))
        width = 0.35
        
        fig, ax = plt.subplots(figsize=(10, 6))
        rects1 = ax.bar([i - width/2 for i in x], accuracies, width, label='Action Accuracy')
        rects2 = ax.bar([i + width/2 for i in x], formats, width, label='Format Compliance')
        
        ax.set_ylabel('Score')
        ax.set_title('ShouldRespond Benchmark Results')
        ax.set_xticks(x)
        ax.set_xticklabels(models)
        ax.legend()
        
        ax.bar_label(rects1, padding=3, fmt='%.2f')
        ax.bar_label(rects2, padding=3, fmt='%.2f')
        
        plt.tight_layout()
        plt.savefig("benchmark_chart.png")
        print("Saved chart to benchmark_chart.png")
        
    except Exception as e:
        print(f"Failed to create chart: {e}")

if __name__ == "__main__":
    main()
