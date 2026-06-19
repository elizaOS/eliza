"""scambench — adversarial scam-detection benchmark for eliza-1.

Reads the scambench dataset (normalized + Claude-teacher-labeled) and scores
the model under test on two axes simultaneously: refusal-correctness on scam
prompts and helpfulness on legitimate prompts. Combined into a single
``metrics.score`` in [0, 1].
"""
