# ASIMOV-1 Full Training Job

Reproducible ASIMOV-1 text-conditioned PPO/MJX baseline package.

Run `./run_full_training.sh --check` on a development machine to validate the package and installed training dependencies. Run `./run_full_training.sh --train` on a GPU training host to start Brax/MJX PPO baseline training and then execute the policy verifier, production checkpoint validator, ASIMOV MJX evaluator, and simulation validation gate. For the default continual-learning path, use this module without `--full` or run `scripts/train_text_conditioned.py --backend alberta`.
