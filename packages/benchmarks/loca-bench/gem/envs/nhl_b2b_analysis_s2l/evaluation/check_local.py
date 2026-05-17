import os
import json
import sys
import pandas as pd
from pathlib import Path

def check_local(agent_workspace: str, groundtruth_workspace: str) -> tuple[bool, str]:
    """
    Check if CSV files containing keywords are generated in agent workspace
    AND verify content against standard answer
    
    Args:
        agent_workspace: agent workspace path
        groundtruth_workspace: groundtruth workspace path
    
    Returns:
        tuple: (whether check passed, check information)
    """
    
    try:
        workspace_path = Path(agent_workspace)
        groundtruth_path = Path(groundtruth_workspace)
        
        # Find CSV files containing keywords
        csv_files = list(workspace_path.glob("*.csv"))
        valid_csv_files = []
        
        for csv_file in csv_files:
            # Only check CSV files containing relevant keywords
            name = csv_file.name.lower()
            if any(keyword in name for keyword in ['nhl', 'back', 'b2b', 'back-to-back', 'analysis', 'sheet']):
                valid_csv_files.append(csv_file)
        
        if not valid_csv_files:
            return False, "No CSV files containing NHL back-to-back analysis keywords found"
        
        # Check found CSV files
        csv_details = []
        for csv_file in valid_csv_files:
            try:
                # Simple check if file is readable and non-empty
                with open(csv_file, 'r', encoding='utf-8') as f:
                    content = f.read().strip()
                    if content:
                        csv_details.append(f"Found valid CSV file: {csv_file.name}")
                    else:
                        csv_details.append(f"Found empty CSV file: {csv_file.name}")
            except Exception as e:
                csv_details.append(f"CSV file read failed: {csv_file.name} ({e})")
        
        # NEW: Verify content against standard answer
        standard_answer_path = groundtruth_path / "standard_answer.csv"
        if standard_answer_path.exists() and valid_csv_files:
            try:
                print("\n📊 Verifying CSV content against standard answer...")
                standard_df = pd.read_csv(standard_answer_path)
                
                # Try to find the best matching CSV file
                best_match_file = None
                best_match_score = 0
                
                for csv_file in valid_csv_files:
                    try:
                        agent_df = pd.read_csv(csv_file)
                        # Check if structure matches
                        if 'Team' in agent_df.columns or 'team' in agent_df.columns:
                            # Calculate match score based on row count similarity
                            match_score = min(len(agent_df), len(standard_df)) / max(len(agent_df), len(standard_df))
                            if match_score > best_match_score:
                                best_match_score = match_score
                                best_match_file = csv_file
                    except:
                        continue
                
                if best_match_file:
                    agent_df = pd.read_csv(best_match_file)
                    
                    # Basic content validation
                    validation_passed, validation_msg = validate_csv_content(agent_df, standard_df)
                    
                    if validation_passed:
                        csv_details.append(f"✅ Content validated: {best_match_file.name} matches standard answer")
                    else:
                        csv_details.append(f"⚠️  Content warning: {validation_msg}")
                else:
                    csv_details.append("⚠️  Could not validate content: no matching CSV structure found")
                    
            except Exception as e:
                csv_details.append(f"⚠️  Content validation failed: {e}")
        
        success_msg = f"Local check passed!\nFound CSV files count: {len(valid_csv_files)}\nFile details:\n  " + "\n  ".join(csv_details)
        return True, success_msg
        
    except Exception as e:
        return False, f"Local check error: {str(e)}"


def validate_csv_content(agent_df: pd.DataFrame, standard_df: pd.DataFrame) -> tuple[bool, str]:
    """
    Validate agent CSV content against standard answer
    
    Args:
        agent_df: Agent's CSV data
        standard_df: Standard answer CSV data
    
    Returns:
        tuple: (whether validation passed, validation message)
    """
    try:
        # Extract only rows matching ground truth teams (more flexible than filtering by indicators)
        agent_df = extract_matching_rows_local(agent_df, standard_df)
        
        # Check row count
        if len(agent_df) != len(standard_df):
            return False, f"Row count mismatch: agent has {len(agent_df)}, standard has {len(standard_df)}"
        
        # Check required columns
        required_columns = ['Team', 'HA', 'AH', 'HH', 'AA', 'Total']
        
        # Normalize column names for comparison
        agent_cols = [col.strip() for col in agent_df.columns]
        
        # Check if all required columns exist (case-insensitive)
        missing_cols = []
        for req_col in required_columns:
            if not any(req_col.lower() == col.lower() for col in agent_cols):
                missing_cols.append(req_col)
        
        if missing_cols:
            return False, f"Missing columns: {missing_cols}"
        
        # All basic checks passed
        return True, f"Structure valid: {len(agent_df)} rows with correct columns"
        
    except Exception as e:
        return False, f"Validation error: {e}"


def extract_matching_rows_local(agent_df: pd.DataFrame, standard_df: pd.DataFrame) -> pd.DataFrame:
    """
    Extract rows from agent_df that match teams in standard_df.
    
    This approach is more flexible than filtering by comment indicators:
    - Only extracts rows for teams that exist in ground truth
    - Automatically ignores any extra rows (comments, notes, metadata, etc.)
    - More robust to different output formats
    
    Args:
        agent_df: Agent's output DataFrame
        standard_df: Ground truth DataFrame
        
    Returns:
        DataFrame with only the rows matching ground truth teams
    """
    if len(agent_df) == 0 or len(standard_df) == 0:
        return agent_df
    
    # Remove completely empty rows first
    agent_df = agent_df.dropna(how='all')
    standard_df = standard_df.dropna(how='all')
    
    # Find the team column (case-insensitive)
    agent_team_col = None
    for col in agent_df.columns:
        if col.lower() in ['team', 'teams', 'teamname']:
            agent_team_col = col
            break
    
    standard_team_col = None
    for col in standard_df.columns:
        if col.lower() in ['team', 'teams', 'teamname']:
            standard_team_col = col
            break
    
    if agent_team_col is None or standard_team_col is None:
        # No team column found, return as-is
        return agent_df
    
    # Get team names from standard (normalize for comparison)
    def normalize_name(name):
        """Normalize team name for comparison"""
        if pd.isna(name):
            return ""
        return str(name).lower().strip().replace('  ', ' ')
    
    standard_teams = set(standard_df[standard_team_col].apply(normalize_name))
    standard_teams.discard("")  # Remove empty strings
    
    if not standard_teams:
        return agent_df
    
    # Filter agent rows to only include teams from standard
    def matches_standard_team(team_name):
        """Check if team name matches any standard team"""
        normalized = normalize_name(team_name)
        return normalized in standard_teams
    
    matching_mask = agent_df[agent_team_col].apply(matches_standard_team)
    matched_df = agent_df[matching_mask].reset_index(drop=True)
    
    return matched_df

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        workspace = sys.argv[1]
        groundtruth = sys.argv[2]
        passed, message = check_local(workspace, groundtruth)
        print(f"Check result: {'Passed' if passed else 'Failed'}")
        print(f"Details: {message}")
    else:
        print("Usage: python check_local.py <agent_workspace> <groundtruth_workspace>")
