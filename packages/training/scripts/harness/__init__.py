"""Action-trajectory synthesis harness.

Generates canonical eliza training records by prompting a configured teacher
model with the runtime's exact system prompt for every catalog action.

Output: ~2,200-5,500 schema-perfect records covering 111 actions across 22
plugins under data/synthesized/harness/.
"""
