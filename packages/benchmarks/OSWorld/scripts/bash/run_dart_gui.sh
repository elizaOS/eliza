# export HF_ENDPOINT=https://hf-mirror.com
python run_multienv_dart_gui.py \
  --dart_base_url http://0.0.0.0:6006/v1 \
  --provider_name docker \
  --test_all_meta_path evaluation_examples/test_nogdrive.json \
  --path_to_vm docker_vm_data/Ubuntu.qcow2 \
  --headless \
  --max_steps 30 \
  --domain  all  \
  --num_envs 2 \
  --log_level INFO \
  --temperature 1.0 \
  --save_complete_trajectory \
  --use_enhanced_runner \
  --model dart-gui \
  --model_type qwen25vl \
  --infer_mode dart_mode \
  --result_dir ./result_multi_apps_pengxiang_transformers12 | tee run_20251103_multi_apps_pengxiang_transformers12.log 