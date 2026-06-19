"""
DID Regression – Starter Template
===================================
Rough first pass at analyzing the policy shock data.
Not fully working yet – needs proper panel methods.
"""

import pandas as pd
import numpy as np

# Load data
df = pd.read_csv("data/panel_data.csv")
print(f"Loaded {len(df)} rows, {df['firm_id'].nunique()} firms")
print(df.head())

# Basic group comparison (naive, doesn't account for time)
treated_avg = df[df['treated'] == 1]['revenue_growth_pct'].mean()
control_avg = df[df['treated'] == 0]['revenue_growth_pct'].mean()
print(f"\nOverall treated avg: {treated_avg:.2f}")
print(f"Overall control avg: {control_avg:.2f}")
print(f"Simple difference: {treated_avg - control_avg:.2f}")

# TODO: This is just a raw mean comparison, not a real DID
# Need to implement:
#   - Proper pre/post x treatment interaction
#   - Firm fixed effects
#   - Year fixed effects
#   - Clustered standard errors
#   - Interpretation section
