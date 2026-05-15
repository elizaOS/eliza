# Helm Chart for Gateway Discord

This directory contains Helm charts for deploying the Discord Gateway Service to Kubernetes.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Release Management](#release-management)
- [CI/CD Setup](#cicd-setup)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before deploying, ensure you have:

1. **Helm 3.x** installed
2. **kubectl** configured for your cluster
3. **Kubernetes secrets** created (see below)

### 1. Create GHCR Pull Secret

The deployment pulls images from GitHub Container Registry (GHCR), which requires authentication.

First, create the namespace (or use `--create-namespace` flag with helm):
```bash
kubectl create namespace gateway-discord
```

Then create the pull secret:
```bash
# Create a GitHub PAT with read:packages scope at:
# https://github.com/settings/tokens/new?scopes=read:packages

kubectl create secret docker-registry ghcr-credentials \
  --namespace=gateway-discord \
  --docker-server=ghcr.io \
  --docker-username=<github-username> \
  --docker-password=<github-pat> \
  --docker-email=<email>
```

### 2. Create Application Secrets

```bash
kubectl create secret generic gateway-discord-secrets \
  --namespace=gateway-discord \
  --from-literal=eliza-cloud-url="https://your-eliza-cloud-url.com" \
  --from-literal=gateway-bootstrap-secret="your-bootstrap-secret" \
  --from-literal=redis-url="https://your-redis-url" \
  --from-literal=redis-token="your-redis-token" \
  --from-literal=blob-token="your-blob-token"
```

| Secret Key | Description |
|------------|-------------|
| `eliza-cloud-url` | URL of the Eliza Cloud API |
| `gateway-bootstrap-secret` | Secret exchanged for JWT token at startup |
| `redis-url` | Redis/Upstash URL for failover coordination |
| `redis-token` | Redis authentication token |
| `blob-token` | R2 / managed storage token for voice message storage (optional) |

**Note**: The `gateway-bootstrap-secret` is exchanged for a JWT token at startup. The Eliza Cloud API must have the corresponding JWT signing keys configured (`JWT_SIGNING_PRIVATE_KEY`, `JWT_SIGNING_PUBLIC_KEY`).

---

## Quick Start

Once prerequisites are in place, deploy with Helm:

```bash
# Deploy to development (--create-namespace creates the namespace if it doesn't exist)
helm upgrade --install gateway-discord . \
  --namespace gateway-discord \
  --create-namespace \
  -f values.yaml \
  -f values-development.yaml

# Deploy to production
helm upgrade --install gateway-discord . \
  --namespace gateway-discord \
  --create-namespace \
  -f values.yaml \
  -f values-production.yaml
```

### Deploy with Custom Image Tag

```bash
helm upgrade --install gateway-discord . \
  --namespace gateway-discord \
  --create-namespace \
  -f values.yaml \
  -f values-production.yaml \
  --set image.tag="sha-abc123"
```

### Verify Deployment

```bash
# Check pod status
kubectl get pods -n gateway-discord

# Check Helm release status
helm status gateway-discord -n gateway-discord
```

---

## Configuration

### Values Files

| File | Description |
|------|-------------|
| `values.yaml` | Default values for all environments |
| `values-development.yaml` | Development overrides (smaller resources, fewer replicas) |
| `values-production.yaml` | Production overrides (more resources, Prometheus enabled) |

### Key Configurable Values

```yaml
# Image configuration
image:
  repository: ghcr.io/elizaos/cloud/gateway-discord
  tag: latest

# Resource limits
resources:
  requests:
    memory: "256Mi"
    cpu: "100m"
  limits:
    memory: "1Gi"
    cpu: "500m"

# Gateway configuration
config:
  maxBotsPerPod: "100"
  failoverCheckIntervalMs: "30000"
  deadPodThresholdMs: "45000"

# HPA configuration
hpa:
  enabled: true
  minReplicas: 1
  maxReplicas: 10

# Prometheus monitoring (requires Prometheus Operator)
prometheus:
  enabled: false
```

### Preview Rendered Manifests

Preview what will be deployed without actually deploying:

```bash
helm template gateway-discord . \
  -f values.yaml \
  -f values-development.yaml \
  --namespace gateway-discord
```

---

## Release Management

```bash
# View release history
helm history gateway-discord -n gateway-discord

# Rollback to previous version
helm rollback gateway-discord -n gateway-discord

# Rollback to specific revision
helm rollback gateway-discord 2 -n gateway-discord

# View current deployed values
helm get values gateway-discord -n gateway-discord

# View all values (including defaults)
helm get values gateway-discord -n gateway-discord --all

# Uninstall
helm uninstall gateway-discord -n gateway-discord
```

---

## CI/CD Setup

The GitHub Actions workflow at `.github/workflows/gateway-discord.yml` automates testing, building, and deploying.

### Workflow Overview

| Job | Description |
|-----|-------------|
| `test` | Runs tests using Bun |
| `build` | Builds Docker image and pushes to GHCR |
| `deploy` | Deploys to development (develop branch) or production (main branch) using Helm |

### Triggers

| Trigger | Action |
|---------|--------|
| Push to `dev` | Deploy to development |
| Push to `main` | Deploy to production |
| `workflow_dispatch` | Manual deployment to selected environment |

### Required GitHub Environment Variables

Add these to each GitHub environment (`gateway-dev` and `gateway-prd`) under **Settings → Environments**:

| Variable | Example | Description |
|----------|---------|-------------|
| `GATEWAY_AWS_ROLE_ARN` | `arn:aws:iam::123456789:role/github-actions-gateway-dev` | IAM role for EKS access (created by Terraform) |
| `AWS_REGION` | `us-east-1` | AWS region of EKS cluster |
| `CLUSTER_NAME` | `gateway-cluster-dev` | EKS cluster name |

### AWS OIDC Setup (One-Time)

GitHub Actions authenticates to AWS using OIDC (no static credentials).

<details>
<summary><strong>Step 1: Create OIDC Identity Provider</strong></summary>

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

Or via AWS Console: **IAM → Identity providers → Add provider** (OpenID Connect)
</details>

<details>
<summary><strong>Step 2: Create IAM Role</strong></summary>

Create `github-actions-role-trust-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:elizaOS/cloud:*"
        }
      }
    }
  ]
}
```

```bash
aws iam create-role \
  --role-name github-actions-gateway-discord \
  --assume-role-policy-document file://github-actions-role-trust-policy.json
```
</details>

<details>
<summary><strong>Step 3: Attach EKS Permissions</strong></summary>

Create `eks-deploy-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["eks:DescribeCluster", "eks:ListClusters"],
      "Resource": "*"
    }
  ]
}
```

```bash
aws iam put-role-policy \
  --role-name github-actions-gateway-discord \
  --policy-name eks-access \
  --policy-document file://eks-deploy-policy.json
```
</details>

<details>
<summary><strong>Step 4: Grant EKS Cluster Access</strong></summary>

```bash
# Create access entry
aws eks create-access-entry \
  --cluster-name gateway-cluster \
  --principal-arn arn:aws:iam::<AWS_ACCOUNT_ID>:role/github-actions-gateway-discord \
  --type STANDARD \
  --region us-east-1

# Associate admin policy
aws eks associate-access-policy \
  --cluster-name gateway-cluster \
  --principal-arn arn:aws:iam::<AWS_ACCOUNT_ID>:role/github-actions-gateway-discord \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster \
  --region us-east-1
```
</details>

---

## Troubleshooting

### Pods not starting

```bash
# Check pod status and events
kubectl get pods -n gateway-discord
kubectl describe pod <pod-name> -n gateway-discord
```

### Image Pull Errors (ImagePullBackOff)

1. Verify `ghcr-credentials` secret exists:
   ```bash
   kubectl get secret ghcr-credentials -n gateway-discord
   ```
2. Check the GitHub PAT has `read:packages` scope
3. Recreate the secret if expired

### Secret Missing Errors

1. Verify `gateway-discord-secrets` exists:
   ```bash
   kubectl get secret gateway-discord-secrets -n gateway-discord
   ```
2. Check all required keys are present:
   ```bash
   kubectl get secret gateway-discord-secrets -n gateway-discord -o jsonpath='{.data}' | jq 'keys'
   ```

### Helm Deployment Issues

```bash
# Check release status
helm status gateway-discord -n gateway-discord

# View release history
helm history gateway-discord -n gateway-discord

# Debug template rendering
helm template gateway-discord . -f values.yaml --debug

# Rollback if needed
helm rollback gateway-discord -n gateway-discord
```

### CI/CD OIDC Authentication Errors

If you see "Error assuming role":
1. Verify the OIDC provider exists in IAM
2. Check the trust policy has the correct repo name
3. Ensure `id-token: write` permission is in the workflow

### EKS Access Denied

If kubectl commands fail with "Unauthorized":
```bash
# Verify access entry exists
aws eks list-access-entries --cluster-name gateway-cluster --region us-east-1

# Check associated policies
aws eks list-associated-access-policies \
  --cluster-name gateway-cluster \
  --principal-arn arn:aws:iam::<AWS_ACCOUNT_ID>:role/github-actions-gateway-discord \
  --region us-east-1
```
