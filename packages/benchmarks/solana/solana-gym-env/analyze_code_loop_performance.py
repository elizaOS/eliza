#!/usr/bin/env python3
"""
Analyze and visualize code_loop_explorer performance metrics.
All outputs are saved to a timestamped folder in analysis_results/
"""

import json
import os
import glob
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime
import numpy as np
from pathlib import Path

def create_output_dir():
    """Create a timestamped output directory for analysis results"""
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_dir = Path(f"analysis_results/code_loop_{timestamp}")
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"\n📁 Created output directory: {output_dir}")
    return output_dir

def load_code_loop_metrics(metrics_path="metrics", exclude_programs=None):
    """Load all code_loop metrics from the specified directory
    
    Args:
        metrics_path: Path to metrics directory
        exclude_programs: List of program IDs to exclude from scoring
    """
    metrics_files = glob.glob(f"{metrics_path}/code_loop_*.json")
    all_metrics = []
    
    for file in metrics_files:
        # Skip conversation files
        if "_conversation.json" in file:
            continue
            
        try:
            with open(file, 'r') as f:
                data = json.load(f)
                # Only include if it has the expected structure
                if 'model' in data and 'messages' in data:
                    # Recalculate scores if programs are excluded
                    if exclude_programs:
                        data = recalculate_scores_without_programs(data, exclude_programs)
                    all_metrics.append(data)
        except Exception as e:
            print(f"Error loading {file}: {e}")
            continue
    
    return all_metrics

def recalculate_scores_without_programs(metrics_data, exclude_programs):
    """Recalculate scores excluding certain programs"""
    # Create a copy to avoid modifying original
    data = json.loads(json.dumps(metrics_data))
    
    # Recalculate programs_discovered
    filtered_programs = {}
    for prog_id, msg_idx in data.get('programs_discovered', {}).items():
        if prog_id not in exclude_programs:
            filtered_programs[prog_id] = msg_idx
    data['programs_discovered'] = filtered_programs
    
    # Recalculate instructions_by_program
    filtered_instructions = {}
    total_unique_instructions = 0
    for prog_id, instructions in data.get('instructions_by_program', {}).items():
        if prog_id not in exclude_programs:
            filtered_instructions[prog_id] = instructions
            total_unique_instructions += len(instructions)
    data['instructions_by_program'] = filtered_instructions
    
    # Recalculate cumulative rewards and message rewards
    new_cumulative_rewards = []
    cumulative = 0
    
    seen = {}
    for i, msg in enumerate(data.get('messages', [])):
        msg_reward = 0
        if 'instructions_discovered' in msg:
            for prog_id, instructions in msg['instructions_discovered'].items():
                if prog_id not in seen:
                    seen[prog_id] = set()
                if prog_id not in exclude_programs:
                    for ix in instructions:
                        if ix not in seen[prog_id]:
                            seen[prog_id].add(ix)
                            msg_reward += 1
        
        # Update message reward
        msg['reward'] = msg_reward
        cumulative += msg_reward
        msg['total_reward'] = cumulative
        new_cumulative_rewards.append(cumulative)
    
    data['cumulative_rewards'] = new_cumulative_rewards
    
    return data

def print_programs_by_model(metrics_list, output_dir):
    """Print which programs each model discovered and create visualizations"""
    
    model_programs = {}
    
    for m in metrics_list:
        model = m['model']
        if model not in model_programs:
            model_programs[model] = {}
        
        # Aggregate programs discovered
        programs = m.get('programs_discovered', {})
        for prog_id, count in programs.items():
            if prog_id not in model_programs[model]:
                model_programs[model][prog_id] = 0
            model_programs[model][prog_id] += count
    
    print("\n" + "="*60)
    print("PROGRAMS DISCOVERED BY MODEL")
    print("="*60)
    
    # Known program names mapping
    program_names = {
        '11111111111111111111111111111111': 'System Program',
        'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr': 'Memo Program',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token Account',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token Program',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'Token 2022',
        'ComputeBudget111111111111111111111111111111': 'Compute Budget',
        'Stake11111111111111111111111111111111111111': 'Stake Program',
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter Aggregator',
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
        '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin': 'Serum DEX V3',
        'So11111111111111111111111111111111111111112': 'Wrapped SOL',
        'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'Metaplex Token Metadata'
    }
    
    for model in sorted(model_programs.keys()):
        programs = model_programs[model]
        print(f"\n📊 {model}:")
        print(f"   Total unique programs: {len(programs)}")
        
        # Sort by interaction count
        sorted_programs = sorted(programs.items(), key=lambda x: x[1], reverse=True)
        
        for prog_id, count in sorted_programs[:10]:  # Show top 10
            name = program_names.get(prog_id, 'Unknown Program')
            print(f"   - {name[:30]:30} ({prog_id[:8]}...): {count} interactions")
        
        if len(sorted_programs) > 10:
            print(f"   ... and {len(sorted_programs) - 10} more programs")
    
    # Create visualizations
    plot_program_discovery(model_programs, program_names, output_dir)
    
    return model_programs

def plot_program_discovery(model_programs, program_names, output_dir):
    """Create visualizations for program discovery data"""
    
    # Prepare data for visualization
    all_programs = set()
    for programs in model_programs.values():
        all_programs.update(programs.keys())
    
    # Get top programs across all models
    program_totals = {}
    for prog_id in all_programs:
        total = sum(model_programs[model].get(prog_id, 0) for model in model_programs)
        program_totals[prog_id] = total
    
    # Get top 10 programs by total interactions
    top_programs = sorted(program_totals.items(), key=lambda x: x[1], reverse=True)[:10]
    top_program_ids = [p[0] for p in top_programs]
    
    # Create figure with subplots
    fig, axes = plt.subplots(2, 2, figsize=(18, 12))
    
    # 1. Stacked bar chart of program interactions by model
    ax1 = axes[0, 0]
    models = sorted(model_programs.keys())
    program_labels = [program_names.get(pid, f"{pid[:8]}...") for pid in top_program_ids]
    
    # Create data matrix
    data_matrix = []
    for prog_id in top_program_ids:
        prog_data = [model_programs[model].get(prog_id, 0) for model in models]
        data_matrix.append(prog_data)
    
    # Create stacked bar chart
    x = np.arange(len(models))
    width = 0.6
    bottom = np.zeros(len(models))
    
    colors = plt.cm.tab20(np.linspace(0, 1, len(top_program_ids)))
    
    for i, (prog_data, label) in enumerate(zip(data_matrix, program_labels)):
        ax1.bar(x, prog_data, width, label=label[:25], bottom=bottom, color=colors[i])
        bottom += prog_data
    
    ax1.set_xlabel('Model')
    ax1.set_ylabel('Total Interactions')
    ax1.set_title('Program Interactions by Model (Top 10 Programs)')
    ax1.set_xticks(x)
    ax1.set_xticklabels(models, rotation=45, ha='right')
    ax1.legend(bbox_to_anchor=(1.05, 1), loc='upper left', fontsize=8)
    ax1.grid(axis='y', alpha=0.3)
    
    # 2. Heatmap of program discovery
    ax2 = axes[0, 1]
    
    # Create heatmap data
    heatmap_data = []
    for prog_id in top_program_ids[:8]:  # Limit to 8 for readability
        row = [model_programs[model].get(prog_id, 0) for model in models]
        heatmap_data.append(row)
    
    im = ax2.imshow(heatmap_data, cmap='YlOrRd', aspect='auto')
    
    # Set ticks and labels
    ax2.set_xticks(np.arange(len(models)))
    ax2.set_yticks(np.arange(len(top_program_ids[:8])))
    ax2.set_xticklabels(models, rotation=45, ha='right')
    ax2.set_yticklabels([program_names.get(pid, f"{pid[:8]}...")[:20] for pid in top_program_ids[:8]])
    
    # Add colorbar
    plt.colorbar(im, ax=ax2, label='Interactions')
    
    # Add text annotations
    for i in range(len(top_program_ids[:8])):
        for j in range(len(models)):
            text = ax2.text(j, i, str(heatmap_data[i][j]),
                          ha="center", va="center", color="black" if heatmap_data[i][j] < 50 else "white", fontsize=8)
    
    ax2.set_title('Program Discovery Heatmap')
    
    # 3. Program diversity by model (unique programs count)
    ax3 = axes[1, 0]
    
    unique_counts = [len(model_programs[model]) for model in models]
    bars = ax3.bar(models, unique_counts, color='steelblue')
    
    # Add value labels on bars
    for bar, count in zip(bars, unique_counts):
        height = bar.get_height()
        ax3.text(bar.get_x() + bar.get_width()/2., height,
                f'{count}', ha='center', va='bottom')
    
    ax3.set_xlabel('Model')
    ax3.set_ylabel('Number of Unique Programs')
    ax3.set_title('Program Discovery Diversity')
    ax3.grid(axis='y', alpha=0.3)
    plt.setp(ax3.xaxis.get_majorticklabels(), rotation=45, ha='right')
    
    # 4. Top programs pie chart (aggregate across all models)
    ax4 = axes[1, 1]
    
    # Get top 7 programs for pie chart
    top_7 = top_programs[:7]
    other_total = sum(p[1] for p in top_programs[7:])
    
    pie_labels = [program_names.get(pid, f"{pid[:8]}...")[:20] for pid, _ in top_7]
    pie_values = [count for _, count in top_7]
    
    if other_total > 0:
        pie_labels.append('Others')
        pie_values.append(other_total)
    
    wedges, texts, autotexts = ax4.pie(pie_values, labels=pie_labels, autopct='%1.1f%%',
                                        startangle=90, colors=plt.cm.Set3(np.linspace(0, 1, len(pie_values))))
    
    # Make percentage text smaller
    for autotext in autotexts:
        autotext.set_fontsize(8)
    
    ax4.set_title('Overall Program Distribution')
    
    plt.suptitle('Program Discovery Analysis', fontsize=16, y=1.02)
    plt.tight_layout()
    
    # Save figure
    filename = output_dir / 'program_discovery.png'
    plt.savefig(filename, dpi=150, bbox_inches='tight')
    print(f"📊 Program discovery plots saved to: {filename}")
    plt.show()

def analyze_metrics(metrics_list, output_dir):
    """Analyze code_loop metrics and generate insights"""
    
    if not metrics_list:
        print("No metrics found!")
        return pd.DataFrame()
    
    # Create summary dataframe
    summary_data = []
    for m in metrics_list:
        # Calculate total rewards
        total_reward = m['cumulative_rewards'][-1] if m.get('cumulative_rewards') else 0
        
        # Count successful code blocks
        successful_blocks = sum(1 for msg in m.get('messages', []) 
                               if msg.get('code_extracted') and msg.get('reward', 0) > 0)
        
        # Calculate success rate
        total_blocks = sum(1 for msg in m.get('messages', []) 
                          if msg.get('code_extracted'))
        
        success_rate = successful_blocks / total_blocks if total_blocks > 0 else 0
        
        # Count unique programs and instructions from top-level fields
        programs = len(m.get('programs_discovered', {}))
        # Calculate total unique instructions from instructions_by_program
        instructions = sum(len(instr_list) for instr_list in m.get('instructions_by_program', {}).values())
        
        summary_data.append({
            'model': m['model'],
            'run_id': m.get('run_id', 'unknown'),
            'run_index': m.get('run_index', 0),
            'total_messages': len(m.get('messages', [])),
            'total_reward': total_reward,
            'successful_blocks': successful_blocks,
            'total_blocks': total_blocks,
            'success_rate': success_rate,
            'programs_discovered': programs,
            'unique_instructions': instructions,
            'avg_reward_per_message': total_reward / len(m.get('messages', [])) if m.get('messages') else 0,
            'errors': sum(1 for msg in m.get('messages', []) if msg.get('error'))
        })
    
    df = pd.DataFrame(summary_data)
    
    # Sort by total reward
    df = df.sort_values('total_reward', ascending=False)
    
    # Print summary statistics
    print("\n" + "="*60)
    print("CODE LOOP PERFORMANCE SUMMARY")
    print("="*60)
    
    # Group by model
    if 'model' in df.columns:
        print("\nBy Model:")
        model_summary = df.groupby('model').agg({
            'total_reward': ['mean', 'std', 'max'],
            'success_rate': ['mean', 'std'],
            'programs_discovered': ['mean', 'max'],
            'unique_instructions': ['mean', 'max']
        }).round(2)
        print(model_summary)
    
    # Best runs
    print("\n🏆 Top 5 Runs by Total Reward:")
    top_runs = df.nlargest(5, 'total_reward')[['model', 'run_id', 'total_reward', 'programs_discovered']]
    print(top_runs.to_string(index=False))
    
    # Best success rate
    print("\n✅ Top 5 Runs by Success Rate:")
    best_success = df.nlargest(5, 'success_rate')[['model', 'run_id', 'success_rate', 'total_reward']]
    print(best_success.to_string(index=False))
    
    # Save summary to CSV
    csv_file = output_dir / 'summary_statistics.csv'
    df.to_csv(csv_file, index=False)
    print(f"\n💾 Summary statistics saved to: {csv_file}")
    
    return df

def plot_model_error_bars(df, output_dir):
    """Create error bar plots for model performance with confidence intervals"""
    
    # Set style
    sns.set_style("whitegrid")
    
    # Calculate statistics per model
    model_stats = df.groupby('model').agg({
        'total_reward': ['mean', 'std', 'count'],
        'avg_reward_per_message': ['mean', 'std'],
        'programs_discovered': ['mean', 'std'],
        'unique_instructions': ['mean', 'std']
    })
    
    # Create figure with subplots
    fig, axes = plt.subplots(2, 2, figsize=(15, 12))
    
    # 1. Total Reward with Error Bars
    ax1 = axes[0, 0]
    models = model_stats.index
    means = model_stats[('total_reward', 'mean')]
    stds = model_stats[('total_reward', 'std')]
    counts = model_stats[('total_reward', 'count')]
    
    # Calculate standard error
    std_errors = stds / np.sqrt(counts)
    
    x_pos = np.arange(len(models))
    ax1.bar(x_pos, means, yerr=std_errors, capsize=5, alpha=0.7, color='steelblue')
    ax1.set_xticks(x_pos)
    ax1.set_xticklabels(models, rotation=45, ha='right')
    ax1.set_ylabel('Total Reward')
    ax1.set_title('Average Total Reward by Model (with Standard Error)')
    ax1.grid(axis='y', alpha=0.3)
    
    # Add sample size annotations
    for i, (mean, se, count) in enumerate(zip(means, std_errors, counts)):
        ax1.text(i, mean + se + 0.5, f'n={int(count)}', ha='center', fontsize=9)
    
    # 2. Programs Discovered with Error Bars
    ax2 = axes[0, 1]
    means = model_stats[('programs_discovered', 'mean')]
    stds = model_stats[('programs_discovered', 'std')]
    
    ax2.bar(x_pos, means, yerr=stds, capsize=5, alpha=0.7, color='purple')
    ax2.set_xticks(x_pos)
    ax2.set_xticklabels(models, rotation=45, ha='right')
    ax2.set_ylabel('Programs Discovered')
    ax2.set_title('Average Programs Discovered by Model (with Std Dev)')
    ax2.grid(axis='y', alpha=0.3)
    
    # 3. Reward per Message with Error Bars
    ax3 = axes[1, 0]
    means = model_stats[('avg_reward_per_message', 'mean')]
    stds = model_stats[('avg_reward_per_message', 'std')]
    
    ax3.bar(x_pos, means, yerr=stds, capsize=5, alpha=0.7, color='orange')
    ax3.set_xticks(x_pos)
    ax3.set_xticklabels(models, rotation=45, ha='right')
    ax3.set_ylabel('Avg Reward per Message')
    ax3.set_title('Reward Efficiency by Model (with Std Dev)')
    ax3.grid(axis='y', alpha=0.3)
    
    # 4. Hide unused subplot
    axes[1, 1].axis('off')
    
    plt.suptitle('Model Performance Comparison with Error Bars', fontsize=16, y=1.02)
    plt.tight_layout()
    
    # Save figure
    filename = output_dir / 'error_bars.png'
    plt.savefig(filename, dpi=150, bbox_inches='tight')
    print(f"📊 Error bar plots saved to: {filename}")
    plt.show()
    
    return model_stats

def plot_code_loop_performance(df, output_dir):
    """Create visualizations for code_loop performance"""
    
    # Set style
    sns.set_style("whitegrid")
    plt.rcParams['figure.figsize'] = (15, 10)
    
    # Create subplots
    fig, axes = plt.subplots(2, 3, figsize=(18, 12))
    
    # 1. Total Reward by Model
    ax1 = axes[0, 0]
    if 'model' in df.columns:
        model_rewards = df.groupby('model')['total_reward'].apply(list)
        for model, rewards in model_rewards.items():
            ax1.scatter([model] * len(rewards), rewards, alpha=0.6, s=50)
        
        # Add mean line
        model_means = df.groupby('model')['total_reward'].mean()
        ax1.hlines(model_means.values, 
                  xmin=np.arange(len(model_means)) - 0.3,
                  xmax=np.arange(len(model_means)) + 0.3,
                  colors='red', linestyles='solid', linewidth=2, label='Mean')
        
    ax1.set_xlabel('Model')
    ax1.set_ylabel('Total Reward')
    ax1.set_title('Total Rewards Distribution by Model')
    ax1.grid(True, alpha=0.3)
    ax1.legend()
    
    # Rotate x labels
    plt.setp(ax1.xaxis.get_majorticklabels(), rotation=45, ha='right')
    
    # 2. Reward Efficiency (Reward per Message)
    ax2 = axes[0, 1]
    if 'model' in df.columns:
        model_efficiency = df.groupby('model')['avg_reward_per_message'].mean().sort_values()
        ax2.barh(model_efficiency.index, model_efficiency.values, color='steelblue')
    
    ax2.set_xlabel('Average Reward per Message')
    ax2.set_ylabel('Model')
    ax2.set_title('Reward Efficiency by Model')
    ax2.grid(True, alpha=0.3)
    
    # 3. Programs Discovered
    ax3 = axes[0, 2]
    if 'model' in df.columns:
        model_programs = df.groupby('model')['programs_discovered'].apply(list)
        for model, programs in model_programs.items():
            ax3.scatter([model] * len(programs), programs, alpha=0.6, s=50)
    
    ax3.set_xlabel('Model')
    ax3.set_ylabel('Programs Discovered')
    ax3.set_title('Programs Discovered by Model')
    ax3.grid(True, alpha=0.3)
    plt.setp(ax3.xaxis.get_majorticklabels(), rotation=45, ha='right')
    
    # Hide unused subplots
    axes[1, 0].axis('off')
    axes[1, 1].axis('off')
    axes[1, 2].axis('off')
    
    plt.suptitle('Code Loop Explorer Performance Analysis', fontsize=16, y=1.02)
    plt.tight_layout()
    
    # Save figure
    filename = output_dir / 'performance_overview.png'
    plt.savefig(filename, dpi=150, bbox_inches='tight')
    print(f"📊 Performance plots saved to: {filename}")
    
    plt.show()

def analyze_reward_progression(output_dir, metrics_path="metrics", exclude_programs=None):
    """Analyze how rewards progress over messages with error bands"""
    
    # Load metrics with full message history
    metrics_files = glob.glob(f"{metrics_path}/code_loop_*_metrics.json")
    model_progressions = {}
    
    for file in metrics_files:
        if "_conversation.json" in file:
            continue
            
        try:
            with open(file, 'r') as f:
                data = json.load(f)
                if 'model' in data and 'cumulative_rewards' in data:
                    # Recalculate if programs are excluded
                    if exclude_programs:
                        data = recalculate_scores_without_programs(data, exclude_programs)
                    model = data['model']
                    if model not in model_progressions:
                        model_progressions[model] = []
                    model_progressions[model].append(data['cumulative_rewards'])
        except:
            continue
    
    if not model_progressions:
        print("No reward progression data found")
        return
    
    # Define model ordering (same as individual trajectories)
    model_order = [
        'anthropic/claude-sonnet-4',
        'openai/gpt-5',
        'google/gemini-2.5-flash',
        'openai/gpt-oss-120b',
    ]
    
    # Order models according to preference, with any remaining models at the end
    ordered_models = []
    for model in model_order:
        if model in model_progressions:
            ordered_models.append(model)
    
    # Add any models not in the predefined order
    for model in sorted(model_progressions.keys()):
        if model not in ordered_models:
            ordered_models.append(model)
    
    # Create plot
    plt.figure(figsize=(14, 8))
    
    handles = []
    for model in ordered_models:
        progressions = model_progressions[model]
        # Pad progressions to same length
        max_len = max(len(p) for p in progressions)
        padded = []
        for p in progressions:
            padded_p = p + [p[-1]] * (max_len - len(p)) if p else [0] * max_len
            padded.append(padded_p)
        
        # Calculate mean and std
        progressions_array = np.array(padded)
        mean_progression = np.mean(progressions_array, axis=0)
        std_progression = np.std(progressions_array, axis=0)
        
        # Plot mean with error band
        x = np.arange(len(mean_progression))
        handles.append(plt.plot(x, mean_progression, label=f'{model} (n={len(progressions)})', linewidth=2)[0])
        print(handles[-1])
        plt.fill_between(x, 
                        mean_progression - std_progression,
                        mean_progression + std_progression,
                        alpha=0.3)
    
    plt.xlabel('Message Number')
    plt.ylabel('Cumulative Reward')
    plt.title('Reward Progression Over Time (Mean ± Std Dev)')
    # import pdb
    # pdb.set_trace()
    plt.legend(handles=handles)
    plt.grid(True, alpha=0.3)
    
    # Save figure
    filename = output_dir / 'reward_progression.png'
    plt.savefig(filename, dpi=150, bbox_inches='tight')
    print(f"📊 Reward progression plot saved to: {filename}")
    plt.show()

def analyze_reward_progression_individual(output_dir, metrics_path="metrics", exclude_programs=None):
    """Show individual trajectories for each model"""
    
    # Load metrics with full message history
    metrics_files = glob.glob(f"{metrics_path}/code_loop_*_metrics.json")
    model_progressions = {}
    
    for file in metrics_files:
        if "_conversation.json" in file:
            continue
            
        try:
            with open(file, 'r') as f:
                data = json.load(f)
                if 'model' in data and 'cumulative_rewards' in data:
                    # Recalculate if programs are excluded
                    if exclude_programs:
                        data = recalculate_scores_without_programs(data, exclude_programs)
                    model = data['model']
                    if model not in model_progressions:
                        model_progressions[model] = []
                    model_progressions[model].append(data['cumulative_rewards'])
        except:
            continue
    
    if not model_progressions:
        print("No reward progression data found")
        return
    
    # Define model ordering
    model_order = [
        'anthropic/claude-sonnet-4',
        'openai/gpt-5',
        'google/gemini-2.5-flash',
        'openai/gpt-oss-120b',
    ]
    
    # Order models according to preference, with any remaining models at the end
    ordered_models = []
    for model in model_order:
        if model in model_progressions:
            ordered_models.append(model)
    
    # Add any models not in the predefined order
    for model in sorted(model_progressions.keys()):
        if model not in ordered_models:
            ordered_models.append(model)
    
    # Create subplots for each model
    n_models = len(ordered_models)
    fig, axes = plt.subplots(1, n_models, figsize=(5*n_models, 6), sharey=True)
    
    if n_models == 1:
        axes = [axes]
    
    for idx, model in enumerate(ordered_models):
        progressions = model_progressions[model]
        ax = axes[idx]
        
        # Plot each individual trajectory
        for i, progression in enumerate(progressions):
            x = np.arange(len(progression))
            ax.plot(x, progression, alpha=0.5, linewidth=1)
        
        # Add mean line
        max_len = max(len(p) for p in progressions)
        padded = []
        for p in progressions:
            padded_p = p + [p[-1]] * (max_len - len(p)) if p else [0] * max_len
            padded.append(padded_p)
        
        mean_progression = np.mean(padded, axis=0)
        ax.plot(np.arange(len(mean_progression)), mean_progression, 
               color='red', linewidth=3, label='Mean', linestyle='--')
        
        ax.set_xlabel('Message Number')
        ax.set_title(f'{model}\n({len(progressions)} runs)')
        ax.grid(True, alpha=0.3)
        ax.legend()
    
    axes[0].set_ylabel('Cumulative Reward')
    plt.suptitle('Individual Reward Trajectories by Model', fontsize=14, y=1.02)
    plt.tight_layout()
    
    # Save figure
    filename = output_dir / 'individual_trajectories.png'
    plt.savefig(filename, dpi=150, bbox_inches='tight')
    print(f"📊 Individual trajectories plot saved to: {filename}")
    plt.show()

def main():
    import argparse
    
    # Parse arguments
    parser = argparse.ArgumentParser(description='Analyze code_loop_explorer performance metrics')
    parser.add_argument('--metrics-path', default='metrics', 
                       help='Path to metrics directory (default: metrics)')
    parser.add_argument('--exclude-programs', nargs='+', default=None,
                       help='Program IDs to exclude from scoring (e.g., MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr)')
    args = parser.parse_args()
    
    print("="*60)
    print("CODE LOOP EXPLORER ANALYSIS")
    print("="*60)
    
    # Create output directory
    output_dir = create_output_dir()
    
    print(f"\n📂 Loading code_loop metrics from: {args.metrics_path}")
    
    if args.exclude_programs:
        print(f"⚠️  Excluding programs from scoring: {args.exclude_programs}")
    
    metrics = load_code_loop_metrics(args.metrics_path, exclude_programs=args.exclude_programs)
    
    if not metrics:
        print(f"❌ No code_loop metrics found in {args.metrics_path}/ directory!")
        return
    
    print(f"✅ Found {len(metrics)} code_loop runs to analyze")
    
    # Print programs discovered by each model and create visualizations
    model_programs = print_programs_by_model(metrics, output_dir)
    
    # Analyze metrics
    df = analyze_metrics(metrics, output_dir)
    
    # Create visualizations
    if len(df) > 0:
        print("\n📊 Creating visualizations...")
        
        # Original plots
        plot_code_loop_performance(df, output_dir)
        
        # Error bar plots
        if df['model'].nunique() > 1:
            plot_model_error_bars(df, output_dir)
        
        # Reward progression with error bands
        analyze_reward_progression(output_dir, args.metrics_path, exclude_programs=args.exclude_programs)
        
        # Individual trajectories
        analyze_reward_progression_individual(output_dir, args.metrics_path, exclude_programs=args.exclude_programs)
        
        print(f"\n✅ Analysis complete! All results saved to: {output_dir}")
        print(f"📁 {output_dir}/")
        print(f"   ├── summary_statistics.csv")
        print(f"   ├── program_discovery.png")
        print(f"   ├── performance_overview.png")
        print(f"   ├── error_bars.png")
        print(f"   ├── reward_progression.png")
        print(f"   └── individual_trajectories.png")

if __name__ == "__main__":
    main()