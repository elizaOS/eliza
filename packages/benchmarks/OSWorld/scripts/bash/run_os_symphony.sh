EXP_NAME="xxx"
export AWS_SECRET_ACCESS_KEY="xxx"
export AWS_ACCESS_KEY_ID="xxx"
export AWS_REGION="us-east-1"
export AWS_SUBNET_ID="xxx"
export AWS_SECURITY_GROUP_ID="xxx"
# >> logs/${EXP_NAME}.log 2>&1
python run_multienv_os_symphony.py \
  --provider_name "aws" \
  --region "us-east-1" \
  --client_password "osworld-public-evaluation" \
  --headless \
  --num_envs 7 \
  --max_steps 50 \
  --benchmark osworld \
  --domain "all" \
  --test_all_meta_path evaluation_examples/test_nogdrive.json \
  --result_dir "results" \
  --tool_config mm_agents/os_symphony/tool/all_tool_config.yaml \
  --orchestrator_provider "openai" \
  --orchestrator_model "gpt-5" \
  --orchestrator_url "xxx" \
  --orchestrator_api_key "xxx" \
  --orchestrator_temperature 0.1 \
  --orchestrator_keep_first_image \
  --max_trajectory_length 8 \
  --grounder_provider "vllm" \
  --grounder_model "UI-TARS-1.5-7B" \
  --grounder_api_key "none" \
  --grounder_url "xxx" \
  --grounding_smart_resize \
  --grounding_width 1920 \
  --grounding_height 1080 \
  --coder_provider "openai" \
  --coder_model "gpt-5" \
  --coder_url "xxx" \
  --coder_api_key "xxx" \
  --coder_temperature 0.1 \
  --coder_budget 20 \
  --memoryer_provider "openai" \
  --memoryer_model "gpt-5" \
  --memoryer_url "xxx" \
  --memoryer_api_key "xxx" \
  --memoryer_temperature 0.1 \
  --memoryer_max_images 8 \
  --searcher_provider "openai" \
  --searcher_model "gpt-5" \
  --searcher_url "xxx" \
  --searcher_api_key "xxx" \
  --searcher_temperature 0.1 \
  --searcher_type "vlm" \
  --searcher_engine "google" \
  --searcher_budget 20 \
  --searcher_screen_width 1920 \
  --searcher_screen_height 1080 \
  --sleep_after_execution 3 \
  --exp_name ${EXP_NAME} \
  --enable_reflection >> logs/${EXP_NAME}.log 2>&1
