"""Synthetic trajectory generation for Eliza-1 training.

Submodules:

- ``project_simulator``: multi-turn project simulator. A project is an
  LLM-authored multi-step goal. Each turn records (input, output) as a
  trajectory chain via parent-step linkage.
- ``together_synth`` / ``build_scenarios`` / ``judge_filter``: one-shot
  scenario generation, scenario building, and pre-training quality filters.
"""
