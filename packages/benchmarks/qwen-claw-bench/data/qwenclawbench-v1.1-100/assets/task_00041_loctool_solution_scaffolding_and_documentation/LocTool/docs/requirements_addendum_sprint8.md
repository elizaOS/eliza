# LocTool — Requirements Addendum (Sprint 8)

**Document Version:** 2.1-A1  
**Date:** 2024-03-22  
**Author:** Sarah Chen, Lead Architect  
**Status:** Approved — Architecture Review Board, March 2024  
**Applies to:** Requirements Specification v2.1 (2024-02-28)

---

## Purpose

This addendum provides corrections and additions to the LocTool Requirements Specification v2.1. Changes listed below supersede the corresponding sections in the base document. All version numbers have been validated against the production-baseline registry and confirmed by the Architecture Review Board during the March 2024 review cycle.

---

## Change 1: DI Package Version Correction (Section 5.1)

**Original (v2.1):** `Microsoft.Extensions.DependencyInjection` version `8.0.0`  
**Corrected:** `Microsoft.Extensions.DependencyInjection` version `8.0.1`

**Rationale:** The `8.0.0` version listed in the original requirements was from a pre-release pin that was accidentally left in the final document. The `8.0.1` patch release fixes a thread-safety issue in `ServiceProviderEngine` that caused intermittent failures in CI (tracked in LOCTOOL-847). The Architecture Review Board approved the version bump on 2024-03-15. The corrected version is recorded in the production-baseline registry (`config/draft_nuget_versions.json`).

> **Action required:** Any tooling or documentation referencing DI `8.0.0` should be updated to `8.0.1`.

---

## Change 2: Add Structured Logging to Core Layer (New — Section 5.5)

**Addition:** `Microsoft.Extensions.Logging.Abstractions` version `8.0.1` in **LocTool.Core**

**Rationale:** Core services need structured logging via `ILogger<T>` for production diagnostics and monitoring integration. This was deferred from the initial requirements (v2.1) but has now been approved for Sprint 8 delivery. The updated architecture diagram (v1.2, 2024-03-18) shows the integration points. Services in `LocTool.Core` should accept `ILogger<T>` via constructor injection.

---

## Change 3: Add Configuration Support to App Layer (New — Section 5.6)

**Addition:** `Microsoft.Extensions.Configuration.Json` version `8.0.0` in **LocTool.App**

**Rationale:** The application needs to load `appsettings.json` for runtime configuration (logging levels, feature flags, Contoso API endpoints). This package was omitted from the original requirements in error. The `OnStartup` method should build a configuration root from `appsettings.json` before configuring the DI container.

---

## Change 4: Test Package Updates (Section 5.4)

The following test packages have been bumped to align with the Sprint 8 CI pipeline:

| Package | v2.1 Version | Updated Version | Reason |
|---------|-------------|-----------------|--------|
| `coverlet.collector` | `6.0.0` | `6.0.2` | Branch coverage reporting fix |
| `xunit` | `2.7.0` | `2.8.0` | Parallel execution improvements |
| `xunit.runner.visualstudio` | `2.5.7` | `2.5.8` | VS 2024 compatibility |
| `Microsoft.NET.Test.Sdk` | `17.9.0` | `17.10.0` | MSBuild 17.10 alignment |
| `Moq` | `4.20.70` | `4.20.72` | SponsorLink removal |

> All updated versions are recorded in the production-baseline registry.

---

## Unchanged Sections

All other sections of Requirements Specification v2.1 remain in force as originally published. Specifically, the following are **not** changed by this addendum:

- Section 2 (Solution Structure — 4 projects)
- Section 3 (Target Framework: `net8.0-windows`)
- Section 4 (Project References / Dependency Graph)
- Section 6 (Application Startup Sequence — EPPlus license first)
- Section 7 (MVVM Pattern Guidelines)
- Section 8 (Non-Functional Requirements — build properties)
- Section 9 (NuGet Source Configuration — nuget.org + Contoso)

---

*End of Addendum*
