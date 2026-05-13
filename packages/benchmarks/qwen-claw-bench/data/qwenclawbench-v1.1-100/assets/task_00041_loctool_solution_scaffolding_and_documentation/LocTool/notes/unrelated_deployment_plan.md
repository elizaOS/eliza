# DataSync.WebAPI — Deployment Plan

**Document Version:** 3.2  
**Last Updated:** 2024-03-01  
**Author:** Marcus Rivera, DevOps Lead  
**Project:** DataSync.WebAPI (ASP.NET Core Web API)

---

## 1. Overview

This document outlines the deployment strategy for the **DataSync.WebAPI** project, a RESTful web API built with ASP.NET Core on .NET 8. The API serves as the backend synchronization service for the DataSync platform, handling real-time data replication between on-premises databases and cloud storage.

> **Note:** This deployment plan is specific to the DataSync.WebAPI project and its microservice architecture. It does not apply to desktop applications or other solution components.

---

## 2. Target Environment

| Component        | Technology                          |
|------------------|-------------------------------------|
| Runtime          | .NET 8 (ASP.NET Core)              |
| Containerization | Docker (Linux containers)           |
| Orchestration    | Kubernetes (AKS — Azure Kubernetes Service) |
| Cloud Provider   | Microsoft Azure                     |
| CI/CD            | Azure DevOps Pipelines              |
| Registry         | Azure Container Registry (ACR)      |

---

## 3. Docker Configuration

### 3.1 Dockerfile

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
WORKDIR /app
EXPOSE 8080
EXPOSE 8443

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["DataSync.WebAPI/DataSync.WebAPI.csproj", "DataSync.WebAPI/"]
COPY ["DataSync.Core/DataSync.Core.csproj", "DataSync.Core/"]
RUN dotnet restore "DataSync.WebAPI/DataSync.WebAPI.csproj"
COPY . .
WORKDIR "/src/DataSync.WebAPI"
RUN dotnet build -c Release -o /app/build

FROM build AS publish
RUN dotnet publish -c Release -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "DataSync.WebAPI.dll"]
```

### 3.2 Docker Compose (Development)

```yaml
version: '3.8'
services:
  datasync-api:
    build:
      context: .
      dockerfile: DataSync.WebAPI/Dockerfile
    ports:
      - "5000:8080"
    environment:
      - ASPNETCORE_ENVIRONMENT=Development
      - ConnectionStrings__DefaultConnection=Server=db;Database=DataSync;User=sa;Password=DevP@ss123
    depends_on:
      - db
  db:
    image: mcr.microsoft.com/mssql/server:2022-latest
    environment:
      - ACCEPT_EULA=Y
      - SA_PASSWORD=DevP@ss123
    ports:
      - "1433:1433"
```

---

## 4. Kubernetes Deployment

### 4.1 Deployment Manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: datasync-api
  namespace: datasync-prod
spec:
  replicas: 3
  selector:
    matchLabels:
      app: datasync-api
  template:
    metadata:
      labels:
        app: datasync-api
    spec:
      containers:
      - name: datasync-api
        image: contosoacr.azurecr.io/datasync-api:latest
        ports:
        - containerPort: 8080
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
```

### 4.2 Service Manifest

```yaml
apiVersion: v1
kind: Service
metadata:
  name: datasync-api-svc
  namespace: datasync-prod
spec:
  type: LoadBalancer
  selector:
    app: datasync-api
  ports:
  - port: 80
    targetPort: 8080
    protocol: TCP
```

---

## 5. CI/CD Pipeline

### 5.1 Azure DevOps Pipeline Stages

1. **Build Stage**
   - Restore NuGet packages
   - Build solution in Release configuration
   - Run unit tests (`dotnet test`)
   - Publish test results

2. **Package Stage**
   - Build Docker image
   - Tag with build number and `latest`
   - Push to Azure Container Registry

3. **Deploy to Staging**
   - Apply Kubernetes manifests to staging namespace
   - Run integration tests against staging endpoint
   - Wait for manual approval

4. **Deploy to Production**
   - Rolling update to production namespace
   - Monitor health checks
   - Auto-rollback on failure

### 5.2 Pipeline Variables

| Variable                    | Value                                    |
|-----------------------------|------------------------------------------|
| `ACR_NAME`                  | contosoacr                               |
| `AKS_CLUSTER`               | datasync-aks-prod                        |
| `AKS_RESOURCE_GROUP`        | rg-datasync-prod                         |
| `STAGING_NAMESPACE`          | datasync-staging                         |
| `PROD_NAMESPACE`             | datasync-prod                            |

---

## 6. Monitoring & Alerting

- **Application Insights** for APM (Application Performance Monitoring)
- **Azure Monitor** for infrastructure metrics
- **Grafana dashboards** for Kubernetes cluster health
- **PagerDuty** integration for critical alerts

### Key Metrics to Monitor

- API response time (P50, P95, P99)
- Request throughput (requests/second)
- Error rate (4xx, 5xx)
- Pod CPU and memory utilization
- Database connection pool usage

---

## 7. Rollback Strategy

In case of deployment failure:

1. Kubernetes will automatically roll back if health checks fail within the configured threshold.
2. Manual rollback: `kubectl rollout undo deployment/datasync-api -n datasync-prod`
3. Emergency: Switch Azure Traffic Manager to point to the disaster recovery region.

---

## 8. Security Considerations

- All secrets stored in Azure Key Vault, injected via Kubernetes CSI driver.
- TLS termination at the ingress controller (NGINX Ingress with cert-manager).
- Network policies restrict pod-to-pod communication.
- Azure AD authentication for API endpoints.

---

*End of Deployment Plan*
