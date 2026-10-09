# aworldGUIAgent-v1

aworldGUIAgent-v1 built on the [AWorld Framework](https://github.com/inclusionAI/AWorld), specifically designed to tackle complex desktop automation tasks within the [OSWorld-verified](https://os-world.github.io/) benchmark.

The core logic for our agent's perception and reasoning is adapted from the great work of the [Agent-S project](https://github.com/simular-ai/Agent-S). We have built upon their foundation by introducing a suite of new executable tools that enhance the agent's ability to interact with the OS environment.

##  Quick Start

Follow these steps to set up the environment and reproduce our results.

1.  **Create Environment & Set Up OSWorld**:
   *   First, create a dedicated Conda environment with **Python 3.11**. 
       ```bash
       conda create -n osworld_env python=3.11
       conda activate osworld_env
       ```
  *   Next, follow the official setup guide in the [OSWorld README](https://github.com/xlang-ai/OSWorld) to install OSWorld and its dependencies.

2.  **Install AWorld Framework**:
   *    Install the specific version of the AWorld Framework into the **same environment**.
         ```bash
         # Make sure your osworld_env is still activated
         git clone https://github.com/inclusionAI/AWorld.git
         cd AWorld
         git checkout osworld_benchmark
         python setup.py install
         ```

3.  **Run the Evaluation Script**:
    *   Our results were achieved using `openai/o3` for reasoning and `bytedance/ui-tars-1.5-7b` for visual grounding, both accessed via OpenRouter.
    *    Remember to replace placeholders like `YOUR_OPENROUTER_API_KEY` and `/path/to/your/vm/Ubuntu.vmx` with your actual credentials and paths.

    ```bash
    # Activate your OSWorld conda environment (e.g., osworld_env)
    conda activate osworld_env

    # Run the evaluation with the recommended settings
    python run_multienv_aworldguiagent.py \
        --headless \
        --ground_url YOUR_BASE_URL \
        --ground_api_key YOUR_API_KEY \
        --ground_model bytedance/ui-tars-1.5-7b \
        --ground_provider open_router \
        --model_url YOUR_BASE_URL \
        --model_api_key YOUR_API_KEY \
        --model_temperature 1.0 \
        --provider_name vmware \
        --path_to_vm /path/to/your/vm/Ubuntu.vmx \
        --max_steps 50 \
        --model_provider open_router \
        --model openai/o3 \
        --grounding_width 1920 \
        --grounding_height 1080 \
        --test_all_meta_path evaluation_examples/test_all.json \
        --result_dir ./results \
        --observation_type screenshot \
        --num_envs 1 \
        --region us-east-1 \
        --client_password osworld-public-evaluation
    ```

## Acknowledgements

This work would not have been possible without building upon the foundations of several incredible open-source projects.

-   **AWorld Framework**: We thank the developers of the [AWorld Framework](https://github.com/inclusionAI/AWorld) for providing a powerful and flexible platform for agent development. The AWorld Framework is designed for agent training and is especially suited for complex multi-agent scenarios. If you have requirements for designing or experimenting with multi-agent systems, we highly recommend you explore the AWorld Framework further.
  
-   **Agent-S**: We extend our sincere gratitude to the creators of the [Agent-S project](https://github.com/simular-ai/Agent-S). The core agent logic in our implementation is adapted and enhanced from their codebase. We built upon their work by adding a suite of executable tools to improve the agent's interaction with the OS environment, which effectively boosted the stability and capability of our CUA Agent.

-   **OSWorld Benchmark**: We are grateful to the creators of the [OSWorld Benchmark](https://os-world.github.io/) for developing a challenging and comprehensive testbed for GUI agents.