# elizaOS Deployment Infrastructure

**'Just works' builds and deployments**

## What We're Building

elizaOS has solid Docker foundations. There's opportunity to build on this foundation with optimised builds, enhanced developer experience, and capabilities for distributed, load-balanced swarms. We want to add an `elizaos deploy` command that handles build optimisation, environment management, and opens up possibilities for advanced deployment scenarios.

## Current State

There is already good Docker support:

- **Main Dockerfile**: Multi-stage build with Node.js 23.3.0-slim and Bun 1.2.5
- **docker-compose.yaml**: Full stack with PostgreSQL
- **docker-compose-docs.yaml**: Local documentation site preview  
- **tee-docker-compose.yaml**: TEE mode deployments

Our work builds on these foundations to enable lean, hardened deployments that scale from local development to distributed swarms.

## Defining Our Terms

- **Local Deployment**: Using Docker locally with standardised, optimised builds
- **Remote Deployment**: Pushing to cloud providers (Digital Ocean, AWS, etc.)
- **Swarm Deployment**: k3d/Kubernetes clusters for distributed elizaOS networks
- **Build Optimisation**: Reducing image size, improving security, enabling caching

## Assumptions and Expectations

- **Target Audience**: Developers and integrators comfortable with docker-compose who want a stable platform to build upon
- **Secondary Audience**: Our users! It will be a friction-free experience getting elizaOS running.
- **Primary Use Case**: Providing consistent, bulletproof environments and making elizaOS deployment straightforward
- **Immediate Goals**: Lean images (<2GB production), full test coverage, reproducible deployments
- **Scope**: Local optimisation first, remote deployment second, then swarm capabilities (the fun bit)

## The Plan: Unified Command Structure

### Existing Commands

**`elizaos dev`**
```bash
elizaos dev                      # Unchanged, local development
elizaos dev --docker             # Spin up dev-optimised Docker target to dev against, locally
```

**`elizaos start`**
```bash
elizaos start                    # Unchanged, direct execution
elizaos start --docker           # Spin up production-optimised Docker target, locally
```

### New: `elizaos deploy` - single command namespace for all things relating to containerisation

```bash
elizaos deploy                   # mirrors elizaos start --docker
elizaos deploy --target test     # or, specify deploy target, here a test optimised version
elizaos deploy demo              # fully configured demo target (shortcut to --target demo)
elizaos deploy --remote aws      # Remote deployment (future)
elizaos deploy build-image       # Build optimised Docker images ready for registries (future)
elizaos deploy push              # Push images to registry (future)
elizaos deploy swarm             # Deploy to k3d cluster (future)
```

## Versioning System

**Potential GitHub Actions Integration**:
- Automatic builds on PR and main branch
- Security scanning with Trivy
- Multi-architecture builds (AMD64, ARM64)
- Automated testing with our container test framework

**Build Pipeline**:
```yaml
# Example CI integration
- name: Build elizaOS
  run: elizaos deploy build-image --tag ${{ github.sha }}
- name: Test Image  
  run: elizaos deploy test --image elizaos:${{ github.sha }}
- name: Push to Registry
  run: elizaos deploy push --tag ${{ github.sha }}
```

## Registry Strategy

**Recommended: GitHub Container Registry (ghcr.io)**
- Native GitHub integration
- Free for public repositories  
- OIDC authentication
- Multi-architecture support

**Alternative: Docker Hub**
- Broad compatibility
- Public visibility
- Rate limiting considerations

**Self-Hosted Option: Harbor**
- Full control over images
- Enterprise features (vulnerability scanning, replication)
- Air-gapped deployment support
- OIDC and LDAP integration

**Registry Commands**:
```bash
elizaos deploy push ghcr.io/elizaos/elizaos:latest
elizaos deploy push docker.io/elizaos/elizaos:latest  
elizaos deploy push harbor.company.com/elizaos:latest
```

## Testing Strategy

**Container Structure Tests**
- Validate image contents automatically
- Ensure security configurations
- Check for required binaries

**Security Scanning** 
- Trivy integration for vulnerability detection
- No HIGH/CRITICAL vulnerabilities in production
- Automated in CI/CD pipeline

**Performance Targets**
- Production images under 2GB (currently 6GB)
- Startup time under 30 seconds
- Resource limits per environment

**Test Image Builds**
- `elizaos deploy --target test` for test-optimised builds
- Isolated test runs with clean environments
- Reproducible builds for CI/CD

## Implementation Phases

### Foundation
1. Build out basic `elizaos deploy` command framework
2. Enhance current Dockerfile for production optimisation
3. Basic testing framework
4. Working demo target


### Future

1. Cloud provider integrations
2. Advanced orchestration of k3d clusters (to facilitate resource efficient swarms)
3. Registry management
4. Remote monitoring


## Updated Quickstart Experience

**Current Quickstart**:
```bash
bun i -g @elizaos/cli
elizaos create my-agent
cd my-agent  
elizaos start
```

**Enhanced Quickstart**:
```bash
bun i -g @elizaos/cli
elizaos deploy demo
```

Then at [elizaos.how/quickstart](https://eliza.how/quickstart):
- Replace Docker complexity with one command
- Add troubleshooting for common deployment issues  
- Link to advanced, vendor specific, deployment guides

## Reference

- [Elizify](http://github.com/bealers/elizify)
- [eliza-remote](http://github.com/bealers/eliza-remote) (needs updating for v1.x)