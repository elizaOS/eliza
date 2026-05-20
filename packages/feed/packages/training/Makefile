# Babylon Training Pipeline - Developer Makefile
#
# Quick reference:
#   make help       - Show all commands
#   make tier1      - Run Python unit tests (no infra)
#   make tier2      - Run JSON mode tests
#   make tier3      - Run DB integration tests
#   make tier4      - Run full GPU training
#
# Docker:
#   make docker-base      - Build base image (vLLM + FlashInfer)
#   make docker-training  - Build training image
#   make docker-push      - Push both images to registry
#
# Local Training:
#   make local-train      - Run training in Docker locally
#
# Cloud:
#   make runpod-train     - Deploy training to RunPod

.PHONY: all help tier1 tier2 tier3 tier4 db-up db-down db-migrate \
        train-12gb train-16gb train-24gb train-l40 train-l40-2gpu train-l40-4gpu \
        train-l40-8gpu train-a100 train-a100-2gpu train-a100-4gpu \
        train-h100 train-h100-2gpu train-h100-4gpu train-h200 train-h200-2gpu \
        train-online bridge-server generate-data venv lint test clean qwen-capacity \
        docker-base docker-training docker-push docker-all \
        local-train local-shell local-benchmark local-benchmark-quick \
        runpod-train runpod-shell runpod-list runpod-stop tinker-pipeline \
        hf-export-dataset hf-push-model \
        benchmark benchmark-quick benchmark-scenario ab-test ab-test-quick

# Default target
all: test

# Colors for output
CYAN := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RESET := \033[0m

# Paths
PYTHON_DIR := python
DEPLOY_DIR := deploy
DOCKER_DIR := $(DEPLOY_DIR)/docker
LOCAL_DIR := $(DEPLOY_DIR)/local
RUNPOD_DIR := $(DEPLOY_DIR)/runpod
VENV := venv
VENV_BIN := $(VENV)/bin
PYTHON := $(VENV_BIN)/python
PYTHON3 ?= python3
PIP := $(VENV_BIN)/pip
PYTEST := $(VENV_BIN)/pytest

# Database
DB_URL := postgresql://babylon_test:test_password@localhost:5434/babylon_test
DB_COMPOSE := docker-compose.test.yml

# Docker settings
DOCKER_ORG ?= revlentless
DOCKER_TAG ?= latest

# Default profile (can be overridden: make train PROFILE=24gb)
PROFILE ?= 12gb
MODEL ?= 9b
CONTEXTS ?= 128k,256k
TRAINING_SEQ_LENGTH ?= 8192

# Training settings
STEPS ?= 100
RL_STEPS ?= 100
MIN_AGENTS ?= 1
OUTPUT ?= ./trained_models/tinker-run
HF_DATASET ?=
HF_SPLIT ?= raw
TRAJECTORY_SOURCE ?= db

#---------------------------------------------------------------------------
# Help
#---------------------------------------------------------------------------

help:
	@echo ""
	@echo "$(CYAN)Babylon Training Pipeline$(RESET)"
	@echo "=========================="
	@echo ""
	@echo "$(GREEN)Testing Tiers:$(RESET)"
	@echo "  make tier1          Python unit tests (no infrastructure)"
	@echo "  make tier2          JSON mode integration tests"
	@echo "  make tier3          Database integration tests (requires Docker)"
	@echo "  make tier4          Full GPU training test"
	@echo ""
	@echo "$(GREEN)Infrastructure:$(RESET)"
	@echo "  make db-up          Start test PostgreSQL and Redis"
	@echo "  make db-down        Stop and remove test containers"
	@echo "  make db-migrate     Apply database schema"
	@echo "  make db-reset       Stop, clean, start, and migrate"
	@echo ""
	@echo "$(GREEN)Docker Images:$(RESET)"
	@echo "  make docker-base         Build base image (vLLM 0.14 + FlashInfer)"
	@echo "  make docker-training     Build training image"
	@echo "  make docker-push         Push both images to registry"
	@echo "  make docker-all          Build and push everything"
	@echo "  Options: DOCKER_ORG=myorg DOCKER_TAG=v1.0"
	@echo ""
	@echo "$(GREEN)Local Docker Training:$(RESET)"
	@echo "  make local-train         Run training in Docker locally"
	@echo "  make local-shell         Start interactive shell in container"
	@echo "  Options: PROFILE=24gb STEPS=100"
	@echo ""
	@echo "$(GREEN)RunPod Cloud Training:$(RESET)"
	@echo "  make runpod-train        Deploy training pod to RunPod"
	@echo "  make runpod-shell        Provision a shell pod for manual canonical pipeline runs"
	@echo "  make runpod-list         List running pods"
	@echo "  make runpod-stop POD=id  Stop and delete a pod"
	@echo "  Options: GPU=h100 GPUS=2 STEPS=1000"
	@echo ""
	@echo "$(GREEN)Tinker Training:$(RESET)"
	@echo "  make tinker-pipeline     Run canonical pipeline with Tinker SFT + RL + ScamBench"
	@echo "  Options: OUTPUT=./trained_models/tinker-run STEPS=500 TRAJECTORY_SOURCE=huggingface HF_DATASET=your-org/scambench-trajectories HF_SPLIT=raw"
	@echo ""
	@echo "$(GREEN)Native Training (with GPU profiles):$(RESET)"
	@echo "  make train-12gb     Train with 12GB GPU profile (RTX 3060)"
	@echo "  make train-16gb     Train with 16GB GPU profile (RTX 4080)"
	@echo "  make train-24gb     Train with 24GB GPU profile (RTX 4090)"
	@echo "  make train-l40      Train with L40 (48GB) profile"
	@echo "  make train-l40-2gpu Train with 2x L40 (96GB) profile"
	@echo "  make train-l40-4gpu Train with 4x L40 (192GB) for Qwen3 30B"
	@echo "  make train-l40-8gpu Train with 8x L40 (384GB) - dedicated vLLM/training"
	@echo "  make train-a100     Train with single A100-80GB profile"
	@echo "  make train-a100-2gpu Train with 2x A100-80GB profile"
	@echo "  make train-a100-4gpu Train with 4x A100-80GB - best value for 30B"
	@echo "  make train-h100     Train with single H100-80GB profile"
	@echo "  make train-h100-2gpu Train with 2x H100-80GB profile"
	@echo "  make train-h100-4gpu Train with 4x H100-80GB - fastest for 30B"
	@echo "  make train-h200     Train with single H200-141GB profile"
	@echo "  make train-h200-2gpu Train with 2x H200-141GB profile"
	@echo "  make train PROFILE=<name>  Train with custom profile"
	@echo ""
	@echo "$(GREEN)Capacity Planning:$(RESET)"
	@echo "  make qwen-capacity  Print the Qwen capacity planner report"
	@echo "  Options: MODEL=9b CONTEXTS=128k,256k TRAINING_SEQ_LENGTH=8192"
	@echo ""
	@echo "$(GREEN)Online Training:$(RESET)"
	@echo "  make bridge-server  Start TypeScript simulation bridge"
	@echo "  make bridge-check   Check if bridge server is running"
	@echo "  make train-online   Run online training (requires bridge-server)"
	@echo "  make train-hybrid   Run hybrid training (mix offline + online)"
	@echo "  make generate-data  Generate trajectories for offline training"
	@echo ""
	@echo "$(GREEN)HuggingFace Export:$(RESET)"
	@echo "  make hf-export-dataset   Export trajectories to HuggingFace dataset"
	@echo "  make hf-push-model       Push trained model to HuggingFace Hub"
	@echo ""
	@echo "$(GREEN)Benchmarking (Docker):$(RESET)"
	@echo "  make local-benchmark       Run benchmark in Docker container"
	@echo "  make local-benchmark-quick Quick Docker benchmark (7-day scenarios)"
	@echo "  Options: BENCHMARK_MODEL=step_500 SCENARIO=bear-market"
	@echo ""
	@echo "$(GREEN)Benchmarking (Native):$(RESET)"
	@echo "  make benchmark           Run native benchmark (requires bun)"
	@echo "  make benchmark-quick     Quick native benchmark"
	@echo "  make benchmark-scenario  Run single scenario (SCENARIO=bear-market)"
	@echo "  make ab-test             Run A/B test (MODEL_A vs MODEL_B)"
	@echo "  make ab-test-quick       Quick A/B test with trained model"
	@echo ""
	@echo "$(GREEN)Development:$(RESET)"
	@echo "  make venv           Create/update Python virtual environment"
	@echo "  make lint           Run linting"
	@echo "  make test           Run all tests (tier1 + tier2)"
	@echo "  make clean          Remove generated files"
	@echo ""
	@echo "$(YELLOW)GPU Profiles:$(RESET)"
	@echo "  12gb, 16gb, 24gb, 48gb, cpu, l40, l40-2gpu, l40-4gpu, l40-8gpu, a100, a100-2gpu, a100-4gpu, h100, h100-2gpu, h100-4gpu, h200, h200-2gpu"
	@echo ""

#---------------------------------------------------------------------------
# Virtual Environment
#---------------------------------------------------------------------------

venv:
	@echo "$(CYAN)Setting up Python virtual environment...$(RESET)"
	cd $(PYTHON_DIR) && python3 -m venv venv
	cd $(PYTHON_DIR) && $(PIP) install --upgrade pip
	cd $(PYTHON_DIR) && $(PIP) install -r requirements.txt
	cd $(PYTHON_DIR) && $(PIP) install -e .
	@echo "$(GREEN)✓ Virtual environment ready$(RESET)"
	@echo "  Activate with: source $(PYTHON_DIR)/$(VENV_BIN)/activate"

#---------------------------------------------------------------------------
# Testing Tiers
#---------------------------------------------------------------------------

qwen-capacity:
	@echo "$(CYAN)Planning Qwen capacity for $(MODEL)...$(RESET)"
	cd $(PYTHON_DIR) && PYTHONPATH=. $(PYTHON3) scripts/plan_qwen_training.py \
		--model $(MODEL) \
		--contexts "$(CONTEXTS)" \
		--training-seq-length $(TRAINING_SEQ_LENGTH) \
		--format markdown
	@echo "$(GREEN)✓ Capacity report generated$(RESET)"

tier1:
	@echo "$(CYAN)Running Tier 1: Python Unit Tests$(RESET)"
	cd $(PYTHON_DIR) && PYTHONPATH=. $(PYTEST) tests/ -v \
		--ignore=tests/integration/ \
		--ignore=tests/e2e/ \
		-x
	@echo "$(GREEN)✓ Tier 1 passed$(RESET)"

tier2:
	@echo "$(CYAN)Running Tier 2: JSON Mode Tests$(RESET)"
	cd $(PYTHON_DIR) && PYTHONPATH=. $(PYTEST) tests/integration/test_json_mode_integration.py -v -x
	@echo "$(GREEN)✓ Tier 2 passed$(RESET)"

tier3: db-up db-migrate
	@echo "$(CYAN)Running Tier 3: Database Integration Tests$(RESET)"
	cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) PYTHONPATH=. \
		$(PYTEST) tests/integration/test_db_integration.py -v -x
	@echo "$(GREEN)✓ Tier 3 passed$(RESET)"

tier4: db-up db-migrate tier4-import
	@echo "$(CYAN)Running Tier 4: Full GPU Training$(RESET)"
	@echo "Using profile: $(PROFILE)"
	cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) WANDB_MODE=offline \
		PATH="$(shell pwd)/$(PYTHON_DIR)/$(VENV_BIN):$$PATH" \
		$(PYTHON) scripts/run_training.py \
		--profile $(PROFILE) \
		--steps 1 \
		--no-wandb \
		--skip-validation
	@echo "$(GREEN)✓ Tier 4 passed$(RESET)"

# Training data output directory (absolute path from repo root)
TRAINING_DATA_DIR := $(shell cd ../.. && pwd)/training-data-output

tier4-generate:
	@echo "$(CYAN)Generating training data...$(RESET)"
	cd ../.. && bun run packages/engine/examples/generate-training-data.ts \
		--causal --hours 2 --npcs 5 --seed 42
	@echo "$(GREEN)✓ Training data generated$(RESET)"

tier4-import:
	@echo "$(CYAN)Importing trajectories to database...$(RESET)"
	@if [ -d "$(TRAINING_DATA_DIR)/trajectories" ]; then \
		cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) \
		$(PYTHON) scripts/import_json_trajectories.py \
		--source $(TRAINING_DATA_DIR); \
	else \
		echo "$(YELLOW)Note: No trajectories found. Run 'make tier4-generate' first.$(RESET)"; \
	fi

#---------------------------------------------------------------------------
# Infrastructure
#---------------------------------------------------------------------------

db-up:
	@echo "$(CYAN)Starting test database...$(RESET)"
	docker compose -f $(DB_COMPOSE) up -d
	@sleep 3
	@docker compose -f $(DB_COMPOSE) ps
	@echo "$(GREEN)✓ Database ready$(RESET)"

db-down:
	@echo "$(CYAN)Stopping test database...$(RESET)"
	docker compose -f $(DB_COMPOSE) down -v
	@echo "$(GREEN)✓ Database stopped$(RESET)"

db-migrate:
	@echo "$(CYAN)Applying database schema...$(RESET)"
	cd ../db && DATABASE_URL=$(DB_URL) bunx drizzle-kit push --force
	@echo "$(GREEN)✓ Schema applied$(RESET)"

db-reset: db-down db-up db-migrate
	@echo "$(GREEN)✓ Database reset complete$(RESET)"

#---------------------------------------------------------------------------
# Docker Images
#---------------------------------------------------------------------------

docker-base:
	@echo "$(CYAN)Building base Docker image...$(RESET)"
	cd $(DOCKER_DIR) && ./build.sh base -o $(DOCKER_ORG) -t $(DOCKER_TAG)
	@echo "$(GREEN)✓ Base image built$(RESET)"

docker-training:
	@echo "$(CYAN)Building training Docker image...$(RESET)"
	cd $(DOCKER_DIR) && ./build.sh training -o $(DOCKER_ORG) -t $(DOCKER_TAG) -b $(DOCKER_TAG)
	@echo "$(GREEN)✓ Training image built$(RESET)"

docker-push:
	@echo "$(CYAN)Pushing Docker images...$(RESET)"
	cd $(DOCKER_DIR) && ./build.sh push-base -o $(DOCKER_ORG) -t $(DOCKER_TAG)
	cd $(DOCKER_DIR) && ./build.sh push-training -o $(DOCKER_ORG) -t $(DOCKER_TAG)
	@echo "$(GREEN)✓ Images pushed to $(DOCKER_ORG)$(RESET)"

docker-all:
	@echo "$(CYAN)Building and pushing all Docker images...$(RESET)"
	cd $(DOCKER_DIR) && ./build.sh all -o $(DOCKER_ORG) -t $(DOCKER_TAG)
	@echo "$(GREEN)✓ All images built and pushed$(RESET)"

#---------------------------------------------------------------------------
# Local Docker Training
#---------------------------------------------------------------------------

local-train:
	@echo "$(CYAN)Starting local Docker training...$(RESET)"
	cd $(LOCAL_DIR) && ./run.sh --profile $(PROFILE) --steps $(STEPS) --min-agents $(MIN_AGENTS)

local-shell:
	@echo "$(CYAN)Starting interactive shell in training container...$(RESET)"
	cd $(LOCAL_DIR) && ./run.sh --interactive

#---------------------------------------------------------------------------
# RunPod Cloud Training
#---------------------------------------------------------------------------

# Default RunPod settings
GPU ?= h100
GPUS ?= 1
RUNPOD_IMAGE ?= $(DOCKER_ORG)/babylon-training:$(DOCKER_TAG)

runpod-train:
	@echo "$(CYAN)Deploying training to RunPod...$(RESET)"
	cd $(RUNPOD_DIR) && python setup.py train \
		--gpu $(GPU) \
		--gpus $(GPUS) \
		--image $(RUNPOD_IMAGE) \
		--env-file ../.env \
		--steps $(STEPS) \
		--min-agents-per-window $(MIN_AGENTS)
	@echo "$(GREEN)✓ Pod created$(RESET)"

runpod-shell:
	@echo "$(CYAN)Provisioning RunPod shell pod...$(RESET)"
	cd $(RUNPOD_DIR) && python setup.py shell \
		--gpu $(GPU) \
		--gpus $(GPUS) \
		--image $(RUNPOD_IMAGE) \
		--env-file ../.env
	@echo "$(GREEN)✓ Shell pod created$(RESET)"

runpod-list:
	@echo "$(CYAN)Listing RunPod pods...$(RESET)"
	cd $(RUNPOD_DIR) && python setup.py list

runpod-stop:
	@if [ -z "$(POD)" ]; then \
		echo "$(YELLOW)Usage: make runpod-stop POD=<pod-id>$(RESET)"; \
		exit 1; \
	fi
	@echo "$(CYAN)Stopping pod $(POD)...$(RESET)"
	cd $(RUNPOD_DIR) && python setup.py stop $(POD)
	@echo "$(GREEN)✓ Pod stopped$(RESET)"

tinker-pipeline: venv
	@set -a; \
		[ -f ./.env ] && . ./.env; \
		[ -f ./.env.local ] && . ./.env.local; \
		set +a; \
		if [ -z "$$TINKER_API_KEY" ]; then \
			echo "$(YELLOW)TINKER_API_KEY is required$(RESET)"; \
			exit 1; \
		fi; \
		if [ "$(TRAJECTORY_SOURCE)" = "huggingface" ] && [ -z "$(HF_DATASET)" ]; then \
			echo "$(YELLOW)HF_DATASET is required when TRAJECTORY_SOURCE=huggingface$(RESET)"; \
			exit 1; \
		fi; \
		if [ "$(TRAJECTORY_SOURCE)" != "huggingface" ] && [ -z "$$DATABASE_URL" ]; then \
			echo "$(YELLOW)DATABASE_URL is required when TRAJECTORY_SOURCE=$(TRAJECTORY_SOURCE)$(RESET)$(YELLOW). Set it in packages/training/.env or export it in the shell.$(RESET)"; \
			exit 1; \
		fi; \
		echo "$(CYAN)Running canonical Tinker pipeline...$(RESET)"; \
		cd $(PYTHON_DIR) && \
			TRAJECTORY_SOURCE=$(TRAJECTORY_SOURCE) \
			HF_TRAJECTORY_DATASET=$(HF_DATASET) \
			HF_TRAJECTORY_SPLIT=$(HF_SPLIT) \
			DATABASE_URL="$$DATABASE_URL" \
			$(PYTHON) scripts/run_pipeline.py \
				--training-backend tinker \
				--output $(OUTPUT) \
				--tinker-steps $(STEPS) \
				--rl-steps $(RL_STEPS) \
				$(if $(filter huggingface,$(TRAJECTORY_SOURCE)),--trajectory-source huggingface --hf-dataset $(HF_DATASET) --hf-split $(HF_SPLIT),); \
		echo "$(GREEN)✓ Tinker pipeline finished$(RESET)"

#---------------------------------------------------------------------------
# HuggingFace Export
#---------------------------------------------------------------------------

HF_REPO ?= 
HF_OUTPUT ?= ./hf_dataset

hf-export-dataset:
	@echo "$(CYAN)Exporting trajectories to HuggingFace dataset...$(RESET)"
	cd $(PYTHON_DIR) && $(PYTHON) scripts/hf/trajectories_to_hf_dataset.py \
		--output $(HF_OUTPUT) \
		$(if $(HF_REPO),--push-to-hub $(HF_REPO),)
	@echo "$(GREEN)✓ Dataset exported$(RESET)"

hf-push-model:
	@if [ -z "$(HF_REPO)" ]; then \
		echo "$(YELLOW)Usage: make hf-push-model HF_REPO=your-org/model-name$(RESET)"; \
		exit 1; \
	fi
	@echo "$(CYAN)Pushing model to HuggingFace Hub...$(RESET)"
	cd $(PYTHON_DIR) && $(PYTHON) scripts/hf/push_model_to_hf.py \
		--adapter-path ./trained_models/final_model \
		--repo-id $(HF_REPO)
	@echo "$(GREEN)✓ Model pushed to $(HF_REPO)$(RESET)"

#---------------------------------------------------------------------------
# Training Shortcuts (Native - no Docker)
#---------------------------------------------------------------------------

train-12gb:
	$(MAKE) train PROFILE=12gb

train-16gb:
	$(MAKE) train PROFILE=16gb

train-24gb:
	$(MAKE) train PROFILE=24gb

train-l40:
	$(MAKE) train PROFILE=l40

train-l40-2gpu:
	$(MAKE) train PROFILE=l40-2gpu

train-l40-4gpu:
	$(MAKE) train PROFILE=l40-4gpu

train-l40-8gpu:
	$(MAKE) train PROFILE=l40-8gpu

train-a100:
	$(MAKE) train PROFILE=a100

train-a100-2gpu:
	$(MAKE) train PROFILE=a100-2gpu

train-a100-4gpu:
	$(MAKE) train PROFILE=a100-4gpu

train-h100:
	$(MAKE) train PROFILE=h100

train-h100-2gpu:
	$(MAKE) train PROFILE=h100-2gpu

train-h100-4gpu:
	$(MAKE) train PROFILE=h100-4gpu

train-h200:
	$(MAKE) train PROFILE=h200

train-h200-2gpu:
	$(MAKE) train PROFILE=h200-2gpu

train: db-up db-migrate
	@echo "$(CYAN)Starting native training with profile: $(PROFILE)$(RESET)"
	cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) WANDB_MODE=offline \
		PATH="$(shell pwd)/$(PYTHON_DIR)/$(VENV_BIN):$$PATH" \
		$(PYTHON) scripts/run_training.py \
		--profile $(PROFILE) \
		--steps $(STEPS) \
		--min-agents-per-window $(MIN_AGENTS) \
		--no-wandb \
		--skip-validation

#---------------------------------------------------------------------------
# Online Training
#---------------------------------------------------------------------------

bridge-server:
	@echo "$(CYAN)Starting TypeScript simulation bridge server...$(RESET)"
	cd ../engine && bun run src/services/simulation-bridge-server.ts

train-online: db-up db-migrate
	@echo "$(CYAN)Starting online training (requires bridge-server running)$(RESET)"
	@echo "Make sure you've started the bridge server with: make bridge-server"
	cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) WANDB_MODE=offline \
		USE_SIMULATION_BRIDGE=1 \
		SIMULATION_BRIDGE_URL=http://localhost:3001 \
		PATH="$(shell pwd)/$(PYTHON_DIR)/$(VENV_BIN):$$PATH" \
		$(PYTHON) scripts/run_training.py \
		--profile $(PROFILE) \
		--mode online \
		--bridge-url http://localhost:3001 \
		--no-wandb

train-hybrid: db-up db-migrate
	@echo "$(CYAN)Starting hybrid training (requires bridge-server running)$(RESET)"
	@echo "Make sure you've started the bridge server with: make bridge-server"
	@echo "Using online ratio: $(ONLINE_RATIO)"
	cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) WANDB_MODE=offline \
		USE_SIMULATION_BRIDGE=1 \
		SIMULATION_BRIDGE_URL=http://localhost:3001 \
		HYBRID_ONLINE_RATIO=$(ONLINE_RATIO) \
		PATH="$(shell pwd)/$(PYTHON_DIR)/$(VENV_BIN):$$PATH" \
		$(PYTHON) scripts/run_training.py \
		--profile $(PROFILE) \
		--mode hybrid \
		--bridge-url http://localhost:3001 \
		--hybrid-online-ratio $(ONLINE_RATIO) \
		--no-wandb

# Default online ratio for hybrid mode
ONLINE_RATIO ?= 0.2

# Check if bridge server is running
bridge-check:
	@curl -s http://localhost:3001/health > /dev/null 2>&1 && \
		echo "$(GREEN)✓ Simulation bridge is running$(RESET)" || \
		(echo "$(YELLOW)✗ Simulation bridge not running. Start with: make bridge-server$(RESET)" && exit 1)

generate-data:
	@echo "$(CYAN)Generating training trajectories...$(RESET)"
	cd ../.. && bun run packages/engine/examples/generate-training-data.ts \
		--causal --hours $(HOURS) --npcs $(NPCS) --seed $(SEED)
	@echo "$(GREEN)✓ Data generation complete$(RESET)"

# Default data generation settings
HOURS ?= 24
NPCS ?= 10
SEED ?= 42

#---------------------------------------------------------------------------
# Cloud Training with W&B
#---------------------------------------------------------------------------

# Default W&B settings
WANDB_PROJECT ?= babylon-training
WANDB_ENTITY ?= 
WANDB_RUN_NAME ?= 

train-cloud: db-up db-migrate
	@echo "$(CYAN)Starting cloud training with W&B logging...$(RESET)"
	@if [ -z "$$WANDB_API_KEY" ]; then \
		echo "$(YELLOW)Warning: WANDB_API_KEY not set. W&B logging will be disabled.$(RESET)"; \
	fi
	cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) \
		PATH="$(shell pwd)/$(PYTHON_DIR)/$(VENV_BIN):$$PATH" \
		$(PYTHON) scripts/run_training.py \
		--profile $(PROFILE) \
		--steps $(STEPS) \
		--min-agents-per-window $(MIN_AGENTS) \
		--wandb-project $(WANDB_PROJECT) \
		$(if $(WANDB_ENTITY),--wandb-entity $(WANDB_ENTITY),) \
		$(if $(WANDB_RUN_NAME),--wandb-run-name $(WANDB_RUN_NAME),)

# Cloud training with specific profiles
train-cloud-l40:
	$(MAKE) train-cloud PROFILE=l40

train-cloud-l40-2gpu:
	$(MAKE) train-cloud PROFILE=l40-2gpu

train-cloud-l40-4gpu:
	$(MAKE) train-cloud PROFILE=l40-4gpu

# Online cloud training (with bridge)
train-cloud-online: db-up db-migrate bridge-check
	@echo "$(CYAN)Starting production online training with W&B logging...$(RESET)"
	cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) \
		USE_SIMULATION_BRIDGE=1 \
		SIMULATION_BRIDGE_URL=http://localhost:3001 \
		PATH="$(shell pwd)/$(PYTHON_DIR)/$(VENV_BIN):$$PATH" \
		$(PYTHON) scripts/run_training.py \
		--profile $(PROFILE) \
		--mode online \
		--bridge-url http://localhost:3001 \
		--wandb-project $(WANDB_PROJECT) \
		$(if $(WANDB_ENTITY),--wandb-entity $(WANDB_ENTITY),)

#---------------------------------------------------------------------------
# Benchmarking & Evaluation
#---------------------------------------------------------------------------

# Default benchmark settings
BENCHMARK_MODEL ?= final_model
BENCHMARK_OUTPUT ?= ./benchmark-results
SCENARIO ?= 

# Docker-based benchmark (recommended)
local-benchmark:
	@echo "$(CYAN)Running Docker benchmark...$(RESET)"
	cd $(LOCAL_DIR) && ./benchmark.sh --model $(BENCHMARK_MODEL) $(if $(SCENARIO),--scenario $(SCENARIO),)

local-benchmark-quick:
	@echo "$(CYAN)Running quick Docker benchmark...$(RESET)"
	cd $(LOCAL_DIR) && ./benchmark.sh --model $(BENCHMARK_MODEL) --quick $(if $(SCENARIO),--scenario $(SCENARIO),)

# Native benchmark (requires full monorepo setup with bun)
benchmark:
	@echo "$(CYAN)Running native benchmark suite...$(RESET)"
	cd ../.. && bun run packages/training/scripts/run-benchmark-suite.ts \
		--model packages/training/trained_models/$(BENCHMARK_MODEL) \
		--output packages/training/$(BENCHMARK_OUTPUT) \
		$(if $(SCENARIO),--scenario $(SCENARIO),)
	@echo "$(GREEN)✓ Benchmark complete$(RESET)"

benchmark-quick:
	@echo "$(CYAN)Running quick native benchmark...$(RESET)"
	cd ../.. && bun run packages/training/scripts/run-benchmark-suite.ts \
		--model packages/training/trained_models/$(BENCHMARK_MODEL) \
		--output packages/training/$(BENCHMARK_OUTPUT) \
		--quick \
		$(if $(SCENARIO),--scenario $(SCENARIO),)
	@echo "$(GREEN)✓ Quick benchmark complete$(RESET)"

benchmark-scenario:
	@if [ -z "$(SCENARIO)" ]; then \
		echo "$(YELLOW)Usage: make benchmark-scenario SCENARIO=bear-market$(RESET)"; \
		echo "Valid scenarios: bull-market, bear-market, scandal-unfolds, pump-and-dump"; \
		exit 1; \
	fi
	$(MAKE) benchmark SCENARIO=$(SCENARIO)

# Run A/B test comparing trained model against baseline
ab-test:
	@echo "$(CYAN)Running A/B test: $(MODEL_A) vs $(MODEL_B)$(RESET)"
	cd $(PYTHON_DIR) && \
		PATH="$(shell pwd)/$(PYTHON_DIR)/$(VENV_BIN):$$PATH" \
		$(PYTHON) scripts/run_ab_test.py \
		--model-a $(MODEL_A) \
		--model-b $(MODEL_B) \
		--num-runs $(AB_RUNS) \
		--output-dir $(AB_OUTPUT) \
		$(if $(AB_ARCHETYPES),--archetypes $(AB_ARCHETYPES),)

# Quick A/B test with trained model vs base
ab-test-quick:
	$(MAKE) ab-test MODEL_B=./trained_models/final_model AB_RUNS=1

# Default A/B test settings
MODEL_A ?= Qwen/Qwen2.5-0.5B-Instruct
MODEL_B ?= ./trained_models/final_model
AB_RUNS ?= 3
AB_OUTPUT ?= ./ab_test_results
AB_ARCHETYPES ?=

#---------------------------------------------------------------------------
# Development
#---------------------------------------------------------------------------

lint:
	@echo "$(CYAN)Running linting...$(RESET)"
	cd ../.. && bun run lint

test: tier1 tier2
	@echo "$(GREEN)✓ All quick tests passed$(RESET)"

clean:
	@echo "$(CYAN)Cleaning generated files...$(RESET)"
	rm -rf $(PYTHON_DIR)/logs
	rm -rf $(PYTHON_DIR)/trained_models
	rm -rf $(PYTHON_DIR)/.pytest_cache
	rm -rf $(PYTHON_DIR)/__pycache__
	rm -rf $(PYTHON_DIR)/hf_dataset
	find $(PYTHON_DIR) -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	@echo "$(GREEN)✓ Clean complete$(RESET)"
