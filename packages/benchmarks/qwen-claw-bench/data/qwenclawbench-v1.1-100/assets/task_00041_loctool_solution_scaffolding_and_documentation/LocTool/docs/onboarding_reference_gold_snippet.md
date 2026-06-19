# Onboarding reference — structure and phrasing (gold snippet)

This file is **not** the solution. It describes what a **tech-lead-grade** `solution_structure.md` should look like so reviewers can compare depth and structure.

## Recommended top-level sections

1. **Purpose & audience** — One short paragraph: who reads this, what they can do after reading it.
2. **Solution layout** — Table with columns at minimum: `Project`, `Role`, `Output type`, `TargetFramework`, `Key packages (Include / Version / PrivateAssets)`, `Project references`. Every `PackageReference` in the real `.csproj` files should appear in the row for that project with the **same** version as the approved baseline registry.
3. **Dependency graph** — Mermaid `graph TD` or clear ASCII arrows; show Core as the leaf with **no** incoming project refs from below and **no** `ProjectReference` entries in Core’s csproj.
4. **NuGet restore & feeds** — Name both sources (nuget.org + Contoso internal), state that `NuGet.config` should use `<clear />` before `<add>` to avoid machine-wide source pollution, and note that internal feed access may require VPN/credentials (compliance narrative).
5. **EPPlus licensing** — Quote or paraphrase the **same** assignment as `requirements.md` (`OfficeOpenXml.ExcelPackage.LicenseContext = OfficeOpenXml.LicenseContext.NonCommercial` in `OnStartup` **before** first EPPlus use), name `LicenseException`, and include a **short C# snippet** consistent with that wording.
6. **Build defaults** — Explicitly list `LangVersion`, `Nullable`, `ImplicitUsings`, `TreatWarningsAsErrors` and tie them to `Directory.Build.props`.
7. **Quick start** — Numbered steps: clone → (optional) authenticate to Contoso feed → `dotnet restore` → `dotnet build` → `dotnet run --project ...`.
8. **When sources disagree** — Explicit sentence pattern: “`requirements.md` overrides `architecture_diagram.md` and chat for package versions; we chose `nuget_versions.json` because DI `8.0.0` matches the requirements doc, not `8.0.1` from the draft file.”

## Example sentence stubs (adapt, do not copy blindly)

- “**Authoritative sources:** `LocTool/docs/requirements.md` plus `LocTool/config/nuget_versions.json` (status `current`).”
- “**Ignore for LocTool:** `draft_nuget_versions.json` (unapproved Sprint narrative), `old_nuget_versions.json` (legacy baseline), `unrelated_deployment_plan.md` (different product).”
- “**Do not add** `Microsoft.Extensions.Logging.Abstractions` to Core; it appears only in the diagram/draft, not in approved requirements.”
