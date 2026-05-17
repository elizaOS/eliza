#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="eliza-local"
REGISTRY_NAME="kind-registry"

echo "=== Tearing down local environment ==="

# Helm releases (reverse install order, graceful before cluster delete)
echo "Removing Helm releases..."
helm uninstall gateway-webhook -n eliza-infra 2>/dev/null || true
helm uninstall gateway-discord -n eliza-infra 2>/dev/null || true
helm uninstall eliza-operator -n pepr-system 2>/dev/null || true
helm uninstall redis -n eliza-infra 2>/dev/null || true
helm uninstall pg-local -n eliza-agents 2>/dev/null || true
helm uninstall cnpg -n cnpg-system 2>/dev/null || true
helm uninstall keda -n keda 2>/dev/null || true
helm uninstall metrics-server -n kube-system 2>/dev/null || true

echo "Deleting kind cluster '$CLUSTER_NAME'..."
kind delete cluster --name "$CLUSTER_NAME" 2>/dev/null || echo "Cluster not found"

echo "Removing local registry..."
docker rm -f "$REGISTRY_NAME" 2>/dev/null || echo "Registry not found"

echo "Done."
