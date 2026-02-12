import json
import glob
import pandas as pd
import re
import os
from pathlib import Path
from typing import Dict, Any, List

# Configuration
POTENTIAL_DIRS = [
    "../../../../training-data-output/trajectories",
    "../../../engine/training-data-output/trajectories",
    "./../training-data-output/trajectories"
]
OUTPUT_FILE = "../data/scored_trajectories.csv"

def find_input_dir():
    print(f"Current Working Directory: {os.getcwd()}")
    for d in POTENTIAL_DIRS:
        path = Path(d).resolve()
        if path.exists() and any(path.iterdir()):
            print(f"✅ Found data at: {path}")
            return str(path)
    return None

def construct_synthetic_reasoning(action_type: str, params: Dict) -> str:
    """Creates a synthetic chain-of-thought based on the action taken."""
    ticker = params.get('ticker', 'Unknown')
    amount = params.get('amount', 0)
    confidence = params.get('confidence', 0.5)
    side = "long" if "long" in action_type else "short"
    
    return (
        f"<thinking>\n"
        f"1. Market Analysis: Analyzing {ticker} market conditions.\n"
        f"2. Signal Detection: Detected {side} signal with {confidence:.2f} confidence.\n"
        f"3. Risk Management: Allocating ${amount} based on confidence level.\n"
        f"4. Decision: Execute {action_type} on {ticker}.\n"
        f"</thinking>\n"
        f"Executing {action_type} for {ticker} with amount {amount}."
    )

def process_trajectories():
    input_dir = find_input_dir()
    if not input_dir:
        print("❌ ERROR: Could not find training data.")
        return

    data_rows = []
    files = glob.glob(f"{input_dir}/*.json")
    print(f"Processing {len(files)} files...")

    for file_path in files:
        try:
            with open(file_path, 'r') as f:
                raw_data = json.load(f)
            
            trajectory = raw_data.get('trajectory', raw_data)
            
            # Parse stepsJson
            steps = []
            if 'stepsJson' in trajectory and isinstance(trajectory['stepsJson'], str):
                try:
                    steps = json.loads(trajectory['stepsJson'])
                except:
                    continue
            elif 'steps' in trajectory:
                steps = trajectory['steps']
            
            if not steps: continue

            for step in steps:
                # 1. Input: Environment State
                state = step.get('environmentState', {})
                
                # 2. Output: Action
                action = step.get('action', {})
                params = action.get('parameters', {})
                action_type = action.get('actionType', '')

                # 3. Check for existing LLM call (Gold Standard)
                llm_calls = step.get('llmCalls', [])
                
                if llm_calls:
                    # Case A: We have the real log
                    for call in llm_calls:
                        resp = call.get('response', '')
                        if resp:
                            data_rows.append({
                                "system": call.get('systemPrompt', 'You are a trading agent.'),
                                "prompt": call.get('userPrompt', f"Context: {json.dumps(state)}"),
                                "response": resp,
                                "score": 1.0 
                            })
                elif action_type and params:
                    # Case B: Reconstruct from Action (Your specific case)
                    # We map State -> Action Parameter
                    
                    # Synthesize a reasoning response so the model learns CoT
                    synthetic_response = construct_synthetic_reasoning(action_type, params)
                    
                    # Construct a structured prompt representing the state
                    user_prompt = (
                        f"Current Market State:\n{json.dumps(state, indent=2)}\n\n"
                        f"Task: Analyze the market and make a trading decision."
                    )
                    
                    # Score based on action success/confidence data availability
                    score = 1.0 if params.get('confidence', 0) > 0.6 else 0.5

                    data_rows.append({
                        "system": "You are an expert autonomous trading agent. Analyze market conditions and execute trades.",
                        "prompt": user_prompt,
                        "response": synthetic_response,
                        "score": score
                    })

        except Exception as e:
            continue

    if not data_rows:
        print("❌ No valid data rows extracted.")
        return

    df = pd.DataFrame(data_rows)
    df = df.sort_values(by="score", ascending=False)
    
    output_path = Path(OUTPUT_FILE).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    df.to_csv(output_path, index=False)
    print(f"\n✅ Successfully exported {len(df)} samples to:")
    print(f"   {output_path}")
    print(f"   Average Score: {df['score'].mean():.2f}")
    if len(df) > 0:
        print(f"   Sample Response:\n   {df.iloc[0]['response'][:100]}...")

if __name__ == "__main__":
    process_trajectories()