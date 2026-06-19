import json
import os
from typing import Dict, List, Any
from datetime import datetime
import pandas as pd


class TransactionAnalyzer:
    """
    Analyzes transaction data from checkpoint directories.
    """
    
    def __init__(self, ckpt_dir: str):
        self.ckpt_dir = ckpt_dir
        self.events_dir = os.path.join(ckpt_dir, "events")
        
    def load_all_transactions(self) -> List[Dict[str, Any]]:
        """Load all transaction data from event files."""
        transactions = []
        
        if not os.path.exists(self.events_dir):
            return transactions
            
        for filename in sorted(os.listdir(self.events_dir)):
            filepath = os.path.join(self.events_dir, filename)
            try:
                with open(filepath, 'r') as f:
                    events = json.load(f)
                    
                for event_type, event_data in events:
                    if event_type == "info" and "tx_meta" in event_data:
                        tx_entry = {
                            "task": filename,
                            "signature": event_data.get("tx_sig"),
                            "programs": event_data.get("programs_interacted", []),
                            "reward": event_data.get("reward", 0),
                            "metadata": json.loads(event_data["tx_meta"])
                        }
                        transactions.append(tx_entry)
                        
            except Exception as e:
                print(f"Error loading {filename}: {e}")
                
        return transactions
    
    def get_transaction_summary(self) -> pd.DataFrame:
        """Create a summary DataFrame of all transactions."""
        transactions = self.load_all_transactions()
        
        summary_data = []
        for tx in transactions:
            meta = tx["metadata"]["meta"]
            
            # Extract instruction details
            instructions = []
            if "innerInstructions" in meta:
                for inner in meta["innerInstructions"]:
                    instructions.extend(inner["instructions"])
                    
            summary_data.append({
                "task": tx["task"],
                "signature": tx["signature"][:8] + "...",  # Shortened for display
                "programs": ", ".join(tx["programs"]),
                "reward": tx["reward"],
                "success": meta["err"] is None,
                "fee": meta.get("fee", 0) / 1e9,  # Convert to SOL
                "num_instructions": len(tx["metadata"]["transaction"]["message"]["instructions"]),
                "num_inner_instructions": len(instructions),
                "logs": "\n".join(meta.get("logMessages", []))[:100] + "..."  # First 100 chars
            })
            
        return pd.DataFrame(summary_data)
    
    def get_discovered_instructions(self) -> Dict[str, List[int]]:
        """Extract all discovered instruction IDs by program."""
        discovered = {}
        transactions = self.load_all_transactions()
        
        for tx in transactions:
            if tx["reward"] > 0:  # Only count rewarded transactions
                # Parse instruction data to extract instruction IDs
                for program in tx["programs"]:
                    if program not in discovered:
                        discovered[program] = []
                        
                # Note: This would need to parse the actual instruction data
                # to extract instruction IDs - simplified for now
                
        return discovered
    
    def export_transaction_details(self, output_file: str = "transaction_details.json"):
        """Export detailed transaction data to a JSON file."""
        transactions = self.load_all_transactions()
        
        output_path = os.path.join(self.ckpt_dir, output_file)
        with open(output_path, 'w') as f:
            json.dump(transactions, f, indent=2)
            
        print(f"Exported {len(transactions)} transactions to {output_path}")
        
    def print_transaction_stats(self):
        """Print statistics about transactions."""
        transactions = self.load_all_transactions()
        
        total_txs = len(transactions)
        successful_txs = sum(1 for tx in transactions if tx["metadata"]["meta"]["err"] is None)
        total_rewards = sum(tx["reward"] for tx in transactions)
        unique_programs = set()
        
        for tx in transactions:
            unique_programs.update(tx["programs"])
            
        print(f"\n📊 Transaction Statistics:")
        print(f"Total transactions: {total_txs}")
        print(f"Successful transactions: {successful_txs} ({successful_txs/total_txs*100:.1f}%)")
        print(f"Total rewards earned: {total_rewards}")
        print(f"Unique programs interacted with: {len(unique_programs)}")
        print(f"Programs: {', '.join(sorted(unique_programs))}")


if __name__ == "__main__":
    # Example usage
    import sys
    
    if len(sys.argv) > 1:
        ckpt_dir = sys.argv[1]
    else:
        ckpt_dir = "ckpt/25-07-25_1753465929"
        
    analyzer = TransactionAnalyzer(ckpt_dir)
    
    # Print statistics
    analyzer.print_transaction_stats()
    
    # Get summary DataFrame
    df = analyzer.get_transaction_summary()
    print("\n📋 Transaction Summary:")
    print(df.to_string(index=False))
    
    # Export detailed data
    analyzer.export_transaction_details()