# Babylon Training Pipeline - Developer Makefile
#
# Quick reference:
#   make help       - Show all commands
#   make tier1      - Run Python unit tests (no infra)
#   make tier2      - Run JSON mode tests
#   make tier3      - Run DB integration tests
#   make tier4      - Run full GPU training
#
# Infrastructure:
#   make db-up      - Start test PostgreSQL/Redis
#   make db-down    - Stop and remove containers
#   make db-migrate - Apply database schema

.PHONY: all help tier1 tier2 tier3 tier4 db-up db-down db-migrate \
        train-12gb train-16gb train-24gb train-l40 train-l40-2gpu train-l40-4gpu \
        train-online bridge-server generate-data venv lint test clean

# Default target
all: test

# Colors for output
CYAN := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
RESET := \033[0m

# Paths
PYTHON_DIR := python
VENV := venv
VENV_BIN := $(VENV)/bin
PYTHON := $(VENV_BIN)/python
PIP := $(VENV_BIN)/pip
PYTEST := $(VENV_BIN)/pytest

# Database
DB_URL := postgresql://babylon_test:test_password@localhost:5434/babylon_test
DB_COMPOSE := docker-compose.test.yml

# Default profile (can be overridden: make train PROFILE=24gb)
PROFILE ?= 12gb

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
	@echo "$(GREEN)Training (with GPU profiles):$(RESET)"
	@echo "  make train-12gb     Train with 12GB GPU profile (RTX 3060)"
	@echo "  make train-16gb     Train with 16GB GPU profile (RTX 4080)"
	@echo "  make train-24gb     Train with 24GB GPU profile (RTX 4090)"
	@echo "  make train-l40      Train with L40 (48GB) profile"
	@echo "  make train-l40-2gpu Train with 2x L40 (96GB) profile"
	@echo "  make train-l40-4gpu Train with 4x L40 (192GB) for Qwen3 30B"
	@echo "  make train PROFILE=<name>  Train with custom profile"
	@echo ""
	@echo "$(GREEN)Online Training (Phase 3):$(RESET)"
	@echo "  make bridge-server  Start TypeScript simulation bridge"
	@echo "  make bridge-check   Check if bridge server is running"
	@echo "  make train-online   Run online training (requires bridge-server)"
	@echo "  make train-hybrid   Run hybrid training (mix offline + online)"
	@echo "  make generate-data  Generate trajectories for offline training"
	@echo ""
	@echo "$(GREEN)Cloud & Production (Phase 4):$(RESET)"
	@echo "  make docker-build   Build Docker image for cloud deployment"
	@echo "  make train-cloud    Train with W&B logging enabled"
	@echo "  make train-cloud-l40      Cloud training with 1x L40"
	@echo "  make train-cloud-l40-2gpu Cloud training with 2x L40"
	@echo "  make train-cloud-l40-4gpu Cloud training with 4x L40 (Qwen3 30B)"
	@echo "  make train-cloud-online   Cloud online training with W&B"
	@echo ""
	@echo "$(GREEN)A/B Testing & Evaluation:$(RESET)"
	@echo "  make ab-test        Run A/B test (MODEL_A vs MODEL_B)"
	@echo "  make ab-test-quick  Quick A/B test with trained model"
	@echo ""
	@echo "$(GREEN)Development:$(RESET)"
	@echo "  make venv           Create/update Python virtual environment"
	@echo "  make lint           Run linting"
	@echo "  make test           Run all tests (tier1 + tier2)"
	@echo "  make clean          Remove generated files"
	@echo ""
	@echo "$(YELLOW)Profiles available:$(RESET)"
	@echo "  12gb, 16gb, 24gb, 48gb, cpu, l40, l40-2gpu, l40-4gpu"
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
# Training Shortcuts
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

#---------------------------------------------------------------------------
# Phase 4: Cloud & Production
#---------------------------------------------------------------------------

# Build Docker image for cloud deployment
docker-build:
	@echo "$(CYAN)Building Docker image for cloud deployment...$(RESET)"
	docker build -t babylon-training:latest .
	@echo "$(GREEN)✓ Docker image built: babylon-training:latest$(RESET)"

# Production training with W&B logging (requires WANDB_API_KEY)
train-cloud: db-up db-migrate
	@echo "$(CYAN)Starting production cloud training with W&B logging...$(RESET)"
	@if [ -z "$$WANDB_API_KEY" ]; then \
		echo "$(YELLOW)Warning: WANDB_API_KEY not set. W&B logging will be disabled.$(RESET)"; \
	fi
	cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) \
		PATH="$(shell pwd)/$(PYTHON_DIR)/$(VENV_BIN):$$PATH" \
		$(PYTHON) scripts/run_training.py \
		--profile $(PROFILE) \
		--wandb-project $(WANDB_PROJECT) \
		$(if $(WANDB_ENTITY),--wandb-entity $(WANDB_ENTITY),) \
		$(if $(WANDB_RUN_NAME),--wandb-run-name $(WANDB_RUN_NAME),)

# Cloud training with specific L40 profiles
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

# Default W&B settings
WANDB_PROJECT ?= babylon-training
WANDB_ENTITY ?= 
WANDB_RUN_NAME ?= 

train: db-up db-migrate
	@echo "$(CYAN)Starting training with profile: $(PROFILE)$(RESET)"
	cd $(PYTHON_DIR) && DATABASE_URL=$(DB_URL) WANDB_MODE=offline \
		PATH="$(shell pwd)/$(PYTHON_DIR)/$(VENV_BIN):$$PATH" \
		$(PYTHON) scripts/run_training.py \
		--profile $(PROFILE) \
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
	./scripts/generate_dataset.sh $(HOURS) $(PARALLEL) $(NPCS) $(OUTPUT)
	@echo "$(GREEN)✓ Data generation complete$(RESET)"

#---------------------------------------------------------------------------
# A/B Testing & Evaluation
#---------------------------------------------------------------------------

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
	find $(PYTHON_DIR) -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	@echo "$(GREEN)✓ Clean complete$(RESET)"

