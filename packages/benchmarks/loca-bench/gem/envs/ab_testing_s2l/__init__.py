"""
A/B Testing S2L Environment

This environment simulates an A/B testing scenario where an AI agent needs to:
1. Analyze clickstream data from BigQuery
2. Calculate conversion rates for each scenario and overall
3. Determine the winner (A or B version)
4. Take appropriate action based on test results

The task tests the agent's ability to:
- Query and analyze data from BigQuery
- Perform statistical calculations (conversion rates)
- Make data-driven decisions
- Interact with Google Cloud services (Storage, Logging)

Author: Adapted from ab-testing-s2l task
Version: 1.0
"""

from .ab_testing_s2l import ABTestingS2LEnv

__all__ = ["ABTestingS2LEnv"]

