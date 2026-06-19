---
id: task_00041_loctool_solution_scaffolding_and_documentation
name: LocTool Solution Scaffolding and Documentation
category: System Operations and Administration
grading_type: hybrid
verification_method: rubric
external_dependency: none
input_modality: text-only
timeout_seconds: 1800
grading_weights:
  automated: 0.15
  llm_judge: 0.85
workspace_files:
- source: LocTool/docs/requirements.md
  dest: LocTool/docs/requirements.md
- source: LocTool/docs/architecture_diagram.md
  dest: LocTool/docs/architecture_diagram.md
- source: LocTool/config/nuget_versions.json
  dest: LocTool/config/nuget_versions.json
- source: LocTool/config/old_nuget_versions.json
  dest: LocTool/config/old_nuget_versions.json
- source: LocTool/config/draft_nuget_versions.json
  dest: LocTool/config/draft_nuget_versions.json
- source: LocTool/templates/sample_wpf_csproj.xml
  dest: LocTool/templates/sample_wpf_csproj.xml
- source: LocTool/templates/sample_classlib_csproj.xml
  dest: LocTool/templates/sample_classlib_csproj.xml
- source: LocTool/notes/team_chat_log.txt
  dest: LocTool/notes/team_chat_log.txt
- source: LocTool/notes/epplus_license_notes.md
  dest: LocTool/notes/epplus_license_notes.md
- source: LocTool/notes/unrelated_deployment_plan.md
  dest: LocTool/notes/unrelated_deployment_plan.md
- source: LocTool/notes/sprint8_package_pin_export.csv
  dest: LocTool/notes/sprint8_package_pin_export.csv
- source: LocTool/notes/old_sln_format_example.txt
  dest: LocTool/notes/old_sln_format_example.txt
- source: LocTool/config/directory_build_props.xml
  dest: LocTool/config/directory_build_props.xml
- source: LocTool/docs/coding_standards.md
  dest: LocTool/docs/coding_standards.md
- source: LocTool/docs/onboarding_reference_gold_snippet.md
  dest: LocTool/docs/onboarding_reference_gold_snippet.md
- source: LocTool/docs/requirements_addendum_sprint8.md
  dest: LocTool/docs/requirements_addendum_sprint8.md
subcategory: Software and Environment Management
---

## Prompt

So we've got a new developer joining the LocTool project next week, and I want to make sure they can clone the repo and start building right away. There's a bunch of existing reference material scattered around the `LocTool/` workspace — requirements docs, architecture diagrams, NuGet version configs, csproj templates, team chat logs, coding standards, and various notes. Fair warning though: some of this stuff is current and some is outdated leftovers from earlier sprints or even entirely different projects, so you'll need to figure out what to actually trust. I also noticed someone dropped what looks like an addendum or errata for the main requirements doc in the docs folder — I honestly can't remember if those changes ever got folded into the main spec or if they're still pending final sign-off, so be careful with that. There's also a short `LocTool/docs/onboarding_reference_gold_snippet.md` that describes what a really thorough onboarding write-up looks like in terms of sections and phrasing — it's not the answers, just a sanity check for how deep and structured the Markdown should be.

Here's what I need you to do:

First, scaffold the solution skeleton under `LocTool/output/`. That means creating the actual `.sln` file and all the `.csproj` files — one per project — with the correct target framework, NuGet packages (exact version numbers), and project-to-project references already wired up. There are multiple NuGet version config files in the config folder from different stages of the project, and some of the docs reference package versions too — honestly I've lost track of which registry is the most current, so you'll need to cross-reference and work out which set of versions to actually use. If there are solution-wide build properties that should be shared via a `Directory.Build.props`, go ahead and include that too. Oh, and make sure package restore will work out of the box — we use both the public NuGet gallery and an internal Contoso feed, so you'll need to handle that in the config as well. One more thing — `coverlet.collector` and `xunit.runner.visualstudio` are build/design-time-only packages that shouldn't leak into consuming projects, so tag them with `PrivateAssets="all"` in the test project csproj.

Second, drop a tiny **machine-readable** package inventory at `LocTool/output/package_baseline.csv` so CI can diff pins without parsing Markdown. Header row must be exactly `Project,PackageId,Version,PrivateAssets` (four columns), UTF-8, one row per package reference you actually ship in the csproj files. The `PrivateAssets` column should say `all` for design-time-only packages (like the coverage collector and the VS test runner adapter) and be empty for everything else. Values must match the **approved** baseline from `requirements.md` + `nuget_versions.json`, not any stray export you find under `notes/`.

Third, add a real `LocTool/output/LocTool.App/App.xaml.cs` stub (partial class is fine) that compiles conceptually: `OnStartup` must call `base.OnStartup(e)` and set `OfficeOpenXml.ExcelPackage.LicenseContext = OfficeOpenXml.LicenseContext.NonCommercial` before any EPPlus use — same spelling as `epplus_license_notes.md`. You do **not** need a full DI wire-up here, but the license line has to be in `OnStartup`, not buried in a random helper. You should also create the matching `LocTool/output/LocTool.App/App.xaml` — standard WPF Application markup with `x:Class` pointing to your App class. But since we handle window creation in `OnStartup` manually, make sure there's **no `StartupUri`** attribute on the `<Application>` element — having both `StartupUri` and manual window creation in `OnStartup` will double-open the window and confuse the new dev.

Fourth, write a reference guide at `LocTool/output/solution_structure.md` that a new team member can use to get oriented. Cover what each project is and does, the dependency graph between them, NuGet packages per project with versions, the EPPlus licensing setup — where it needs to go and what blows up if you skip it — the DI container approach, the MVVM toolkit, shared build properties, and the NuGet feed setup so they know how to restore packages. Nice clear Markdown headings so someone can quickly jump to what they need. The doc should explicitly mention the CSV + `App.xaml.cs` deliverables so onboarding isn't a treasure hunt.

Fifth — since there are literally five different places in this workspace where package versions show up (I just counted…), do me a favor and drop a cross-reference audit at `LocTool/output/version_audit.csv` so the new dev can see at a glance where each version comes from and which one we actually use. Seven columns: `PackageId,nuget_versions_json,draft_nuget_versions_json,old_nuget_versions_json,addendum_sprint8,staging_csv,selected_version`. One row per unique package that appears in *any* of those five sources — fill in the version from each source where it exists, leave the cell blank if that source doesn't mention the package, and `selected_version` is whatever you ended up putting in the csproj files (or blank if you decided not to include the package at all). I want something a new hire can open in Excel and immediately see why we picked `nuget_versions.json` over the others.

When you hit conflicting info across files, the formal requirements doc is the single source of truth.

## Expected Behavior

The agent should produce deliverables under `LocTool/output/`, synthesizing information primarily from `LocTool/docs/requirements.md`, `LocTool/config/nuget_versions.json`, `LocTool/docs/architecture_diagram.md`, `LocTool/notes/epplus_license_notes.md`, `LocTool/config/directory_build_props.xml`, and the csproj templates. The agent should correctly identify the formal requirements document as the authoritative source and prioritize it over conflicting information in other files. For package versions not listed inline in requirements.md, the agent must identify the correct version registry by cross-referencing: requirements.md explicitly specifies `Microsoft.Extensions.DependencyInjection 8.0.0` which only appears in `nuget_versions.json` (the draft file has `8.0.1`), confirming `nuget_versions.json` as the canonical source for all versions.

### Part 1: Solution Scaffold

**Solution file** — `LocTool/output/LocTool.sln`: A valid Visual Studio solution file listing all 4 projects (LocTool.App, LocTool.Core, LocTool.ViewModel, LocTool.Tests) with correct project type GUIDs and relative csproj paths. The `.sln` must include **complete** solution build configuration metadata: `GlobalSection(SolutionConfigurationPlatforms)` with at least `Debug|Any CPU` and `Release|Any CPU`, and `GlobalSection(ProjectConfigurationPlatforms)` listing each project's active/build mappings for those configurations, so the new developer can build Debug and Release out of the box.

**Project files (4 total):**
1. **`LocTool/output/LocTool.App/LocTool.App.csproj`** — WPF application (`OutputType: Exe`, `UseWPF: true`). NuGet: `Microsoft.Extensions.DependencyInjection 8.0.0`. Must NOT include `Microsoft.Extensions.Configuration.Json` (that package appears only in the addendum, not in the approved requirements v2.1). ProjectReferences: `LocTool.ViewModel`, `LocTool.Core`.
2. **`LocTool/output/LocTool.Core/LocTool.Core.csproj`** — Class library. NuGet: `EPPlus 7.0.0`. No ProjectReferences (bottom layer). Must NOT include `Microsoft.Extensions.Logging.Abstractions` (that package appears only in the draft registry, the addendum, and the architecture diagram, not in the approved requirements v2.1).
3. **`LocTool/output/LocTool.ViewModel/LocTool.ViewModel.csproj`** — Class library. NuGet: `CommunityToolkit.Mvvm 8.2.2`. ProjectReferences: `LocTool.Core`.
4. **`LocTool/output/LocTool.Tests/LocTool.Tests.csproj`** — xUnit test project. NuGet: `xunit 2.7.0`, `xunit.runner.visualstudio 2.5.7`, `Microsoft.NET.Test.Sdk 17.9.0`, `Moq 4.20.70`, `coverlet.collector 6.0.0`. `coverlet.collector` and `xunit.runner.visualstudio` must have `PrivateAssets="all"` (or equivalent child element). ProjectReferences: `LocTool.Core`, `LocTool.ViewModel`.

All projects target `net8.0-windows`.

**`LocTool/output/Directory.Build.props`** — Shared build properties derived from the config template (`LocTool/config/directory_build_props.xml`): `LangVersion=latest`, `Nullable=enable`, `ImplicitUsings=enable`, `TreatWarningsAsErrors=true`, and `AnalysisLevel=latest-recommended`. The template contains all five properties; the agent should reproduce all of them, not just the four listed in requirements.md section 8. A production-quality props file should include **XML comments (`<!-- ... -->`) explaining the purpose/effect of each property** so a new developer understands what each setting does and when it would need changing.

**`LocTool/output/NuGet.config`** — Package source configuration with both feeds: `https://api.nuget.org/v3/index.json` (nuget.org) and `https://pkgs.contoso.com/nuget/v3/index.json` (Contoso Internal). The config should include `<clear />` before the `<add>` elements to prevent machine-wide feed pollution, and the key names should match the canonical identifiers from `requirements.md` section 9 (specifically, the internal feed key should contain "Internal"). A well-documented config should include an **XML comment near `<clear />`** explaining its purpose (preventing inherited machine-wide or user-level feeds from polluting restore).

**`LocTool/output/package_baseline.csv`** — Exactly four columns `Project,PackageId,Version,PrivateAssets` (header must match character-for-character aside from optional UTF-8 BOM). Eight data rows total, one per `PackageReference` across the solution, using IDs and versions from the approved registry (not staging exports). The `PrivateAssets` column is `all` for design-time-only packages (`coverlet.collector` and `xunit.runner.visualstudio`) and empty for all others:

| Project | PackageId | Version | PrivateAssets |
|---------|-----------|---------|---------------|
| LocTool.App | Microsoft.Extensions.DependencyInjection | 8.0.0 | |
| LocTool.Core | EPPlus | 7.0.0 | |
| LocTool.ViewModel | CommunityToolkit.Mvvm | 8.2.2 | |
| LocTool.Tests | xunit | 2.7.0 | |
| LocTool.Tests | xunit.runner.visualstudio | 2.5.7 | all |
| LocTool.Tests | Microsoft.NET.Test.Sdk | 17.9.0 | |
| LocTool.Tests | Moq | 4.20.70 | |
| LocTool.Tests | coverlet.collector | 6.0.0 | all |

**`LocTool/output/LocTool.App/App.xaml`** — Standard WPF Application XAML with `<Application x:Class="..."` pointing to the App class. Must **not** contain a `StartupUri` attribute, because the application creates and shows `MainWindow` manually inside `OnStartup`. Having `StartupUri` alongside manual window creation causes a double-open bug.

**`LocTool/output/LocTool.App/App.xaml.cs`** — Contains `protected override void OnStartup(StartupEventArgs e)` (or equivalent override) with `base.OnStartup(e)` and the exact assignment `OfficeOpenXml.ExcelPackage.LicenseContext = OfficeOpenXml.LicenseContext.NonCommercial;` inside `OnStartup`, matching `LocTool/notes/epplus_license_notes.md`. Should include a **C# comment explaining why the license line must be in `OnStartup`** (i.e., it must execute before any EPPlus API call; placing it in a static constructor or helper risks out-of-order initialization).

### Part 2: Reference Document

Use `LocTool/docs/onboarding_reference_gold_snippet.md` as the **structure and depth benchmark** for the written guide: a submission that matches or exceeds that outline (per-project package inventory, feed/compliance narrative, explicit conflict resolution language, etc.) counts as fully successful documentation quality; lighter coverage is only partial success for those qualitative aspects (see LLM rubric).

`LocTool/output/solution_structure.md` should contain:

- **Projects (4 total):** Name, type (WPF app / class library / test project), and purpose for each — preferably in a Markdown **table** for scannability (see gold snippet section 2).
- **Target framework:** `net8.0-windows` for all projects.
- **NuGet packages per project** with exact version numbers from the current baseline version registry (`nuget_versions.json`) — ideally in a Markdown table with columns like `Project | Package | Version | PrivateAssets`.
- **Project reference graph:** Which projects reference which, including that LocTool.Core is the bottom layer with no project references. Should include a **Mermaid `graph TD` or ASCII art diagram** showing directed edges for all five relationships: App→ViewModel, App→Core, ViewModel→Core, Tests→Core, Tests→ViewModel (see gold snippet section 3).
- **EPPlus license configuration:** Must set `ExcelPackage.LicenseContext = LicenseContext.NonCommercial` in `App.xaml.cs` `OnStartup` method before any EPPlus API calls. Failure results in a `LicenseException` at runtime. Should include a short C# code snippet and explain the NonCommercial vs Commercial license-type choice.
- **DI container:** Microsoft.Extensions.DependencyInjection 8.0.0, configured in App.xaml.cs.
- **MVVM toolkit:** CommunityToolkit.Mvvm 8.2.2.
- **Shared build properties:** LangVersion, Nullable, ImplicitUsings, TreatWarningsAsErrors, **and AnalysisLevel** settings from Directory.Build.props, with a brief explanation of each property's effect.
- **NuGet source configuration:** Both package feeds (nuget.org and Contoso internal) and the NuGet.config requirement. Should explain the purpose of `<clear />` (preventing machine-wide feed pollution) and note internal-feed VPN/credential requirements.
- **Machine-readable pins + startup stub:** Call out where `package_baseline.csv` lives and that `LocTool.App/App.xaml.cs` carries the EPPlus license line (so people do not hunt through random notes for CSV exports). Explain how to update the CSV and how CI consumes it.
- **Quick start steps:** Numbered clone → feed check → restore → build → run workflow (see gold snippet section 7).
- **Troubleshooting / FAQ:** At least two common failure scenarios (e.g., EPPlus `LicenseException`, Contoso feed restore failure, missing WPF SDK, `TreatWarningsAsErrors` breaking on warnings).
- **Source provenance:** Explicit statement that `requirements.md` + `nuget_versions.json` are authoritative, with per-file rationale for why **each** of the following was excluded: `old_nuget_versions.json`, `draft_nuget_versions.json`, `requirements_addendum_sprint8.md`, `unrelated_deployment_plan.md`, `sprint8_package_pin_export.csv`, and `coding_standards.md` (incorrect MVVM version). Must name at least five of these six individually (see gold snippet section 8).
- **Per-claim source annotation:** Key claims in the document should be annotated with their source (e.g., "version 8.0.0 per `requirements.md` §5.1", "versions from `nuget_versions.json` (status: `current`)"). This gives the new developer confidence that each fact was cross-referenced, not just assumed.
- **NonCommercial vs Commercial license contrast:** The EPPlus section should explain when NonCommercial applies (internal/non-revenue use) versus when a Commercial license is required (revenue-generating product), so the new developer understands the licensing implications.

*All version numbers have been verified against requirements.md and nuget_versions.json (the file whose metadata status is "current" and whose DI version matches the requirements document's explicit 8.0.0 specification).*

### Part 3: Version Audit

**`LocTool/output/version_audit.csv`** — Machine-readable cross-reference table mapping every unique package across the five version sources in the workspace. Seven columns: `PackageId,nuget_versions_json,draft_nuget_versions_json,old_nuget_versions_json,addendum_sprint8,staging_csv,selected_version`. Ten data rows (one per unique package that appears in any source). For each row, the cell under each source column contains the version listed in that source, or is blank if the source does not list the package. The `selected_version` column contains the version actually used in the `.csproj` files (from the approved baseline) or is blank if the package was rejected entirely (phantom packages not included in the solution).

| PackageId | nuget_versions_json | draft_nuget_versions_json | old_nuget_versions_json | addendum_sprint8 | staging_csv | selected_version |
|-----------|--------------------|--------------------------|-----------------------|-----------------|------------|-----------------|
| Microsoft.Extensions.DependencyInjection | 8.0.0 | 8.0.1 | 6.0.1 | 8.0.1 | 8.0.1 | 8.0.0 |
| EPPlus | 7.0.0 | 7.1.0 | 5.8.4 | | | 7.0.0 |
| CommunityToolkit.Mvvm | 8.2.2 | 8.3.0 | 8.0.0 | | | 8.2.2 |
| Microsoft.Extensions.Logging.Abstractions | | 8.0.1 | | 8.0.1 | 8.0.1 | |
| Microsoft.Extensions.Configuration.Json | | | | 8.0.0 | | |
| xunit | 2.7.0 | 2.8.0 | 2.4.2 | 2.8.0 | 2.8.0 | 2.7.0 |
| xunit.runner.visualstudio | 2.5.7 | 2.5.8 | 2.4.5 | 2.5.8 | 2.5.8 | 2.5.7 |
| Microsoft.NET.Test.Sdk | 17.9.0 | 17.10.0 | 17.4.1 | 17.10.0 | 17.10.0 | 17.9.0 |
| Moq | 4.20.70 | 4.20.72 | 4.18.4 | 4.20.72 | 4.20.72 | 4.20.70 |
| coverlet.collector | 6.0.0 | 6.0.2 | | 6.0.2 | 6.0.1 | 6.0.0 |

Key correctness requirements: (a) `Microsoft.Extensions.Logging.Abstractions` and `Microsoft.Extensions.Configuration.Json` must have **blank** `selected_version` (rejected phantom packages); (b) all approved packages must have `selected_version` matching `nuget_versions_json` column; (c) the `staging_csv` column for `coverlet.collector` is `6.0.1` (not `6.0.2` — the staging CSV contains a different version from the addendum, which is itself a subtle cross-source inconsistency the agent must capture faithfully).

### Trap Handling

**Trap 1 — Three-way version file disambiguation:** Three NuGet version registry files exist in `config/`: (a) `nuget_versions.json` — metadata status: `"current"`, lastUpdated: `2024-02-28`, DI version `8.0.0`; (b) `old_nuget_versions.json` — lastUpdated: `2023-01-15`, labeled Sprint 4 baseline, DI version `6.0.1`; (c) `draft_nuget_versions.json` — metadata status: `"production-baseline"`, lastUpdated: `2024-03-15`, approvedBy: "Architecture Review Board", DI version `8.0.1`. The draft file is the strongest decoy: it has a more recent date, sounds authoritative, and its versions match `architecture_diagram.md`. However, the agent should identify `nuget_versions.json` as the canonical source because: (1) requirements.md — the designated single source of truth — explicitly specifies `Microsoft.Extensions.DependencyInjection 8.0.0`, which only appears in `nuget_versions.json`; (2) requirements.md uses the phrase "current baseline NuGet version registry", matching `nuget_versions.json`'s status field of `"current"`; (3) the draft file's versions have not been incorporated into the approved requirements document.

**Trap 2 — Chat log contradictions and Sprint 7 reinforcement:** The chat log contains two traps. First, early messages (Feb 12) have developers suggesting `net8.0` (without `-windows`) and a static service locator instead of DI — both contradict the requirements. Second, later messages (Mar 18) have the lead architect calling the draft registry "the production baseline going forward" and confirming the architecture diagram was updated to match — reinforcing the draft's incorrect versions. The agent should follow the formal requirements document over both the informal chat and the updated architecture diagram.

**Trap 3 — Incomplete old solution file:** The file `LocTool/notes/old_sln_format_example.txt` shows an old .sln with only 2 projects (LocTool.App and LocTool.Core). The agent should list all 4 projects as specified in the requirements document.

**Trap 4 — Phantom package in architecture diagram:** The updated `architecture_diagram.md` (v1.2, 2024-03-18) lists `Microsoft.Extensions.Logging.Abstractions 8.0.1` as a dependency of `LocTool.Core`. This package appears in the Sprint 7 draft registry and architecture diagram but is NOT listed in the approved requirements document (`requirements.md`). The agent should NOT include this package in `LocTool.Core.csproj`.

**Trap 5 — Architecture diagram version mismatch:** The architecture diagram shows Sprint 7 package versions throughout (EPPlus 7.1.0, CommunityToolkit.Mvvm 8.3.0, DI 8.0.1, xunit 2.8.0, Moq 4.20.72, etc.) that conflict with the current baseline registry's versions (EPPlus 7.0.0, CommunityToolkit.Mvvm 8.2.2, DI 8.0.0, xunit 2.7.0, Moq 4.20.70). Combined with the chat log's narrative that "the architecture diagram was updated to match the new versions," this creates a strong signal toward incorrect versions. The agent must prefer the requirements document and the registry it points to.

**Noise file:** The agent should correctly identify that `LocTool/notes/unrelated_deployment_plan.md` pertains to a different project (DataSync.WebAPI) and exclude its content from the output.

**Trap 6 — Sprint 8 staging CSV looks “official”:** `LocTool/notes/sprint8_package_pin_export.csv` resembles a CI package pin export (extra columns, newer batch id, Core row for `Microsoft.Extensions.Logging.Abstractions`). It aligns with Sprint 7-style inflated versions and the phantom Core package. It is **not** approved in `requirements.md` and must **not** drive `package_baseline.csv`, any `.csproj`, or prose version claims — only `requirements.md` + `nuget_versions.json` do.

**Trap 7 — Requirements addendum looks formally approved:** `LocTool/docs/requirements_addendum_sprint8.md` is the strongest decoy in the workspace. It is formatted as an official amendment to requirements.md v2.1, authored by the same lead architect (Sarah Chen), and bears "Approved — Architecture Review Board" status. It directly "corrects" DI from 8.0.0 to 8.0.1, adds `Microsoft.Extensions.Logging.Abstractions` to Core, adds `Microsoft.Extensions.Configuration.Json` to App, and bumps all test package versions. Combined with the chat log (Sarah calling the draft "the production baseline going forward"), the architecture diagram (Sprint 7 versions), and the draft registry (status "production-baseline"), this forms a **four-source consensus** pointing to incorrect versions. The agent should nonetheless ignore the addendum because: (1) the Prompt states "the formal requirements doc is the single source of truth" and warns the addendum might not have been formally merged; (2) `requirements.md` itself remains at version 2.1 (2024-02-28), unchanged — the addendum's changes were never incorporated; (3) the DI 8.0.0 anchor in requirements.md v2.1 still pinpoints `nuget_versions.json` as the canonical registry, not the addendum's "production-baseline" file.

**Trap 8 — Csproj templates contain wrong versions:** The `templates/sample_wpf_csproj.xml` has been updated (by someone who followed the addendum) to list `Microsoft.Extensions.DependencyInjection 8.0.1` instead of the correct `8.0.0`. An agent that copies the template without cross-referencing requirements.md will ship the wrong DI version.

**Trap 9 — Coding standards has wrong MVVM version:** `LocTool/docs/coding_standards.md` section 7.1 states CommunityToolkit.Mvvm "version 8.3.0" (matching the draft/addendum versions), not the correct baseline 8.2.2. The agent should prefer the version from `nuget_versions.json` (confirmed via the DI 8.0.0 anchor in requirements.md).

**Trap 10 — Chat log explicitly names the wrong file as canonical:** A late entry (2024-03-20) in the team chat has Sarah Chen explicitly stating that `draft_nuget_versions.json` is "actually our production baseline now, not a draft" and telling the team to "ignore `nuget_versions.json` — that's the old Sprint 6 file." This directly contradicts the correct source identification. Combined with the addendum, architecture diagram, draft registry metadata, and the earlier chat entries, this forms a **five-source consensus** (chat + addendum + diagram + draft registry + staging CSV) pointing to the wrong file vs. only the formal requirements document pointing to the correct one. The agent should follow the prompt's instruction that "the formal requirements doc is the single source of truth" over even the lead architect's informal chat instruction.

## Grading Criteria

- [ ] `LocTool/output/package_baseline.csv` exists with header `Project,PackageId,Version,PrivateAssets` and exactly the eight baseline rows with correct PrivateAssets values (`all` for coverlet.collector and xunit.runner.visualstudio, empty for the rest); full marks require rows sorted by Project name alphabetically (LocTool.App, LocTool.Core, LocTool.Tests, LocTool.ViewModel) then by PackageId within each project; correct data in wrong row order receives partial credit
- [ ] `LocTool/output/LocTool.App/App.xaml.cs` sets EPPlus `LicenseContext.NonCommercial` inside `OnStartup` with the `OfficeOpenXml.ExcelPackage.LicenseContext` assignment as in `epplus_license_notes.md`; full marks require a C# comment (line containing `//` with `EPPlus` or `license`) in `OnStartup` explaining why the license line is placed here; correct assignment without such a comment caps at partial credit
- [ ] `LocTool/output/LocTool.App/App.xaml` exists with `<Application>` element and `x:Class` but does NOT contain `StartupUri`
- [ ] Reference document exists at `LocTool/output/solution_structure.md` with sufficient depth (≥ 2800 characters for full marks)
- [ ] Document lists all 4 projects with correct types (WPF app, class library, test project); full marks require each project and its type to appear in a Markdown table row (line containing `|`) **and** each project's table row must include an OutputType or SDK descriptor keyword (`Exe` for App, `Library`/`classlib` for Core and ViewModel, `test` for Tests)
- [ ] Document correctly specifies target framework as `net8.0-windows`
- [ ] Document lists correct NuGet package versions from current baseline registry (EPPlus 7.0.0, DI 8.0.0, MVVM 8.2.2, xunit 2.7.0, xunit.runner.vs 2.5.7, Test.Sdk 17.9.0, Moq 4.20.70, coverlet 6.0.0); full marks require all 8 versions in structured Markdown table rows **and** a source attribution (e.g., `nuget_versions.json`) within 300 characters of the version table; table versions without nearby source attribution receive partial credit
- [ ] Document explains EPPlus LicenseContext setup: location (App.xaml.cs OnStartup), mode (NonCommercial), and failure consequence (exception); full marks require contrasting **NonCommercial** with **Commercial** (or naming `LicenseException`) in prose, not NonCommercial alone; full marks require a fenced C# code block (` ```csharp ` or ` ```cs `) containing the `LicenseContext` assignment **and** a `using OfficeOpenXml` directive within the same code block; a code block showing only the assignment without the `using` declaration caps at partial credit
- [ ] Document identifies Microsoft.Extensions.DependencyInjection as the DI framework (not a static service locator); full marks require mentioning a DI registration API (e.g., ServiceCollection, ServiceProvider, AddSingleton, AddTransient) near the DI discussion, co-mentioning `requirements.md` or `nuget_versions.json` as the source that anchors the DI package version, **and** including a fenced C# code block (` ```csharp ` or ` ```cs `) within ±500 characters of the DI discussion that demonstrates DI registration (containing `ServiceCollection`, `AddSingleton`, or `AddTransient`); prose-only DI discussion without a code example caps at partial credit
- [ ] Document correctly maps project reference relationships including Core's zero-dependency status; full marks require explicit directed edges for all 5 relationships (App→ViewModel, App→Core, ViewModel→Core, Tests→Core, Tests→ViewModel) **and** a standalone diagram: Mermaid block containing `graph` / `graph TD|LR|...`, or ASCII with `-->` or `├──` / `└──`; the visual graph block itself must explicitly encode all 5 directed edges (source node containing project name `-->` target node containing project name on a single line); full marks additionally require **full project names** with `LocTool.` prefix in the graph nodes (e.g., `LocTool.App`, `LocTool.Core`, `LocTool.ViewModel`, `LocTool.Tests` rather than abbreviated `App`, `Core`); a graph using short names without the `LocTool.` prefix caps at partial credit; a graph with only 3–4 detectable edges receives partial credit; prose-only arrows cap at partial credit, and visual diagram must include Tests project edges
- [ ] Document notes shared build properties (LangVersion, Nullable, ImplicitUsings, TreatWarningsAsErrors)
- [ ] Document describes NuGet source configuration (nuget.org and Contoso feed), names `package_baseline.csv` (path or filename), and explicitly mentions the `<clear />` element (or its purpose of preventing machine-wide/global/inherited feed pollution); full marks require all five items (nuget.org, Contoso, NuGet.config, baseline CSV, and `<clear />` mention); four of five items caps at partial credit
- [ ] `.sln` file exists at `LocTool/output/LocTool.sln` and contains all 4 projects; full marks require `GlobalSection(SolutionConfigurationPlatforms)` with Debug|Any CPU and Release|Any CPU
- [ ] **Automated key `sln_build_configurations`:** solution has `GlobalSection(SolutionConfigurationPlatforms)` listing both `Debug|Any CPU` and `Release|Any CPU`, and `GlobalSection(ProjectConfigurationPlatforms)` with per-project build mappings → **1.0**; has the solution configuration GlobalSection but only one of Debug/Release → **0.5**; missing `GlobalSection(SolutionConfigurationPlatforms)` → **0.0**
- [ ] `LocTool.App.csproj` has Exe output type, UseWPF, DI package 8.0.0, no Configuration.Json package, and project references to ViewModel and Core
- [ ] `LocTool.Core.csproj` has EPPlus 7.0.0, no project references, and no Logging.Abstractions package
- [ ] `LocTool.ViewModel.csproj` has CommunityToolkit.Mvvm 8.2.2 and references Core
- [ ] `LocTool.Tests.csproj` has all 5 test packages with correct versions, `PrivateAssets="all"` on coverlet.collector and xunit.runner.visualstudio, and references Core + ViewModel
- [ ] All `.csproj` files target `net8.0-windows`
- [ ] `Directory.Build.props` exists with LangVersion, Nullable, ImplicitUsings, TreatWarningsAsErrors; full marks require `AnalysisLevel=latest-recommended` (from config template)
- [ ] `NuGet.config` exists with both package source URLs, `<clear/>`, and internal-feed key name containing "Internal"
- [ ] Generated engineering files do not contain versions from `old_nuget_versions.json`, `draft_nuget_versions.json`, or `requirements_addendum_sprint8.md`
- [ ] Reference document does not recommend `Microsoft.Extensions.Logging.Abstractions` or `Microsoft.Extensions.Configuration.Json` as actual project dependencies (mentioning them only in a "do not include" or noise-triage context is acceptable)
- [ ] Reference document explicitly names `requirements.md` and `nuget_versions.json` as authoritative sources and identifies at least three noise/conflicting files (e.g., draft registry, addendum, old registry, staging CSV, unrelated deployment plan)
- [ ] Reference document individually names ≥ 5 of 6 excluded materials (`old_nuget_versions.json`, `draft_nuget_versions.json`, `requirements_addendum_sprint8.md`, `sprint8_package_pin_export.csv`, `unrelated_deployment_plan.md`, `coding_standards.md`) with per-file exclusion rationale
- [ ] Reference document includes numbered quick-start steps (clone → feed check/VPN → restore → build → run) with all five action keywords present
- [ ] Reference document has a dedicated Troubleshooting/FAQ heading with ≥ 3 specific scenarios: EPPlus `LicenseException`, `TreatWarningsAsErrors` build failure, Contoso feed/VPN issue, missing WPF SDK
- [ ] Reference document annotates key claims with their source (e.g., "per `requirements.md`", "from `nuget_versions.json` (status: current)", or section references)
- [ ] Reference document explains CSV maintenance workflow (how to update `package_baseline.csv`, how CI consumes it for drift detection)
- [ ] Reference document contrasts NonCommercial vs Commercial EPPlus license types (when each applies); full marks require mentioning business context (e.g., revenue, paid, fee, commercial-use)
- [ ] `App.xaml.cs` includes a comment explaining why the EPPlus license line must be in `OnStartup` (before first EPPlus API call)
- [ ] `Directory.Build.props` includes XML comments (`<!-- ... -->`) explaining each property's purpose; full marks require ≥ 3 comments
- [ ] `LocTool/output/version_audit.csv` exists with 7-column header (`PackageId,nuget_versions_json,draft_nuget_versions_json,old_nuget_versions_json,addendum_sprint8,staging_csv,selected_version`) and lists ≥ 9 of 10 unique packages across the five version sources
- [ ] Version audit `selected_version` column matches approved baseline for all 8 shipped packages and is blank for rejected phantom packages (`Logging.Abstractions`, `Configuration.Json`)
- [ ] Version audit cross-reference columns contain accurate version numbers extracted from each respective source file (≥96% cell accuracy for full marks); `staging_csv` column for `coverlet.collector` must be `6.0.1` (not `6.0.2`) reflecting the staging CSV's own inconsistency with the addendum
- [ ] Reference document explains why `net8.0-windows` TFM is used instead of plain `net8.0` (WPF depends on the Windows Desktop SDK); full marks require linking the `-windows` suffix to the WPF/WindowsDesktop SDK dependency
- [ ] Reference document explains the semantics of `PrivateAssets="all"` (prevents design-time-only packages from leaking as transitive dependencies to consuming projects); full marks require using transitive-dependency terminology (e.g., transitive, consuming, leak, downstream) and connecting to `coverlet.collector` and `xunit.runner.visualstudio`
- [ ] Reference document presents an explicit version conflict resolution methodology (e.g., DI 8.0.0 as anchor → confirms `nuget_versions.json` → rejects alternatives with per-source rationale); full marks require a reproducible decision process, not just "requirements.md wins"

## Automated Checks

```python
import csv
import re
import xml.etree.ElementTree as ET
from io import StringIO
from pathlib import Path

_EXPECTED_BASELINE_ROWS = frozenset(
    {
        ("LocTool.App", "Microsoft.Extensions.DependencyInjection", "8.0.0", ""),
        ("LocTool.Core", "EPPlus", "7.0.0", ""),
        ("LocTool.ViewModel", "CommunityToolkit.Mvvm", "8.2.2", ""),
        ("LocTool.Tests", "xunit", "2.7.0", ""),
        ("LocTool.Tests", "xunit.runner.visualstudio", "2.5.7", "all"),
        ("LocTool.Tests", "Microsoft.NET.Test.Sdk", "17.9.0", ""),
        ("LocTool.Tests", "Moq", "4.20.70", ""),
        ("LocTool.Tests", "coverlet.collector", "6.0.0", "all"),
    }
)

_EXPECTED_BASELINE_ORDER = [
    ("LocTool.App", "Microsoft.Extensions.DependencyInjection", "8.0.0", ""),
    ("LocTool.Core", "EPPlus", "7.0.0", ""),
    ("LocTool.Tests", "Microsoft.NET.Test.Sdk", "17.9.0", ""),
    ("LocTool.Tests", "Moq", "4.20.70", ""),
    ("LocTool.Tests", "coverlet.collector", "6.0.0", "all"),
    ("LocTool.Tests", "xunit", "2.7.0", ""),
    ("LocTool.Tests", "xunit.runner.visualstudio", "2.5.7", "all"),
    ("LocTool.ViewModel", "CommunityToolkit.Mvvm", "8.2.2", ""),
]


def _parse_baseline_csv(text: str):
    if not (text or "").strip():
        return None, None
    text = text.lstrip("\ufeff").strip()
    reader = csv.reader(StringIO(text))
    rows = list(reader)
    if len(rows) < 2:
        return None, None
    header = [h.strip() for h in rows[0]]
    if [h.lower() for h in header] != ["project", "packageid", "version", "privateassets"]:
        return None, None
    if len(header) != 4:
        return None, None
    out_set = set()
    out_list = []
    for parts in rows[1:]:
        if not parts or not any(p.strip() for p in parts):
            continue
        if len(parts) < 3 or len(parts) > 4:
            return None, None
        pa = parts[3].strip().lower() if len(parts) > 3 else ""
        if pa in ("", "none"):
            pa = ""
        t = (parts[0].strip(), parts[1].strip(), parts[2].strip(), pa)
        out_set.add(t)
        out_list.append(t)
    return out_set, out_list


def _props_strict_count(xml_text: str) -> tuple:
    """Returns (base_count, has_analysis_level, xml_comment_count)."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return (0, False, 0)
    found = set()
    has_al = False
    for pg in root.iter("PropertyGroup"):
        for child in pg:
            tag = child.tag.split("}")[-1]
            val = (child.text or "").strip()
            if tag == "LangVersion" and val.lower() == "latest":
                found.add("lv")
            elif tag == "Nullable" and val.lower() == "enable":
                found.add("nu")
            elif tag == "ImplicitUsings" and val.lower() == "enable":
                found.add("iu")
            elif tag == "TreatWarningsAsErrors" and val.lower() == "true":
                found.add("tw")
            elif tag == "AnalysisLevel" and val.lower() in (
                "latest-recommended",
                "latest",
                "latest-all",
            ):
                has_al = True
    comment_count = len(re.findall(r"<!--", xml_text))
    return (len(found), has_al, comment_count)


def _csproj_well_formed(xml_text: str) -> bool:
    if not (xml_text or "").strip():
        return False
    try:
        ET.fromstring(xml_text)
        return True
    except ET.ParseError:
        return False


_AUDIT_EXPECTED = {
    "microsoft.extensions.dependencyinjection": ("8.0.0", "8.0.1", "6.0.1", "8.0.1", "8.0.1", "8.0.0"),
    "epplus": ("7.0.0", "7.1.0", "5.8.4", "", "", "7.0.0"),
    "communitytoolkit.mvvm": ("8.2.2", "8.3.0", "8.0.0", "", "", "8.2.2"),
    "microsoft.extensions.logging.abstractions": ("", "8.0.1", "", "8.0.1", "8.0.1", ""),
    "microsoft.extensions.configuration.json": ("", "", "", "8.0.0", "", ""),
    "xunit": ("2.7.0", "2.8.0", "2.4.2", "2.8.0", "2.8.0", "2.7.0"),
    "xunit.runner.visualstudio": ("2.5.7", "2.5.8", "2.4.5", "2.5.8", "2.5.8", "2.5.7"),
    "microsoft.net.test.sdk": ("17.9.0", "17.10.0", "17.4.1", "17.10.0", "17.10.0", "17.9.0"),
    "moq": ("4.20.70", "4.20.72", "4.18.4", "4.20.72", "4.20.72", "4.20.70"),
    "coverlet.collector": ("6.0.0", "6.0.2", "", "6.0.2", "6.0.1", "6.0.0"),
}


def grade(transcript: list, workspace_path: str) -> dict:
    results = {
        "package_baseline_csv": 0.0,
        "app_startup_license": 0.0,
        "app_xaml_correct": 0.0,
        "output_doc_exists": 0.0,
        "doc_all_projects_typed": 0.0,
        "doc_target_framework": 0.0,
        "doc_nuget_versions": 0.0,
        "doc_epplus_license": 0.0,
        "doc_di_framework": 0.0,
        "doc_reference_graph": 0.0,
        "doc_build_properties": 0.0,
        "doc_nuget_sources": 0.0,
        "doc_no_phantom_packages": 0.0,
        "sln_file_valid": 0.0,
        "sln_build_configurations": 0.0,
        "csproj_app_correct": 0.0,
        "csproj_core_correct": 0.0,
        "csproj_viewmodel_correct": 0.0,
        "csproj_tests_correct": 0.0,
        "csproj_frameworks_correct": 0.0,
        "directory_build_props": 0.0,
        "nuget_config_correct": 0.0,
        "no_wrong_versions": 0.0,
        "doc_source_provenance": 0.0,
        "doc_quick_start_steps": 0.0,
        "doc_troubleshoot_faq": 0.0,
        "doc_per_claim_annotation": 0.0,
        "doc_per_file_exclusion": 0.0,
        "doc_csv_ci_narrative": 0.0,
        "doc_noncomm_vs_comm": 0.0,
        "app_cs_startup_comment": 0.0,
        "props_has_xml_comments": 0.0,
        "version_audit_structure": 0.0,
        "version_audit_selected": 0.0,
        "version_audit_cross_ref": 0.0,
        "doc_windows_tfm_rationale": 0.0,
        "doc_private_assets_explain": 0.0,
        "doc_version_decision_process": 0.0,
    }

    ws = Path(workspace_path)
    out_dir = ws / "LocTool" / "output"

    def read_file(p):
        if p.is_file():
            return p.read_text(encoding="utf-8", errors="replace").strip()
        return ""

    doc = read_file(out_dir / "solution_structure.md")
    if not doc:
        return results

    csv_text = read_file(out_dir / "package_baseline.csv")
    parsed_set, parsed_list = _parse_baseline_csv(csv_text)
    if parsed_set == _EXPECTED_BASELINE_ROWS:
        if parsed_list == _EXPECTED_BASELINE_ORDER:
            results["package_baseline_csv"] = 1.0
        else:
            results["package_baseline_csv"] = 0.5
    elif parsed_set:
        inter = parsed_set & _EXPECTED_BASELINE_ROWS
        if len(inter) >= 7:
            results["package_baseline_csv"] = 0.32
        elif len(inter) >= 5:
            results["package_baseline_csv"] = 0.12

    app_cs = read_file(out_dir / "LocTool.App" / "App.xaml.cs")
    if app_cs:
        has_assign = bool(
            re.search(
                r"OfficeOpenXml\.ExcelPackage\.LicenseContext\s*=\s*OfficeOpenXml\.LicenseContext\.NonCommercial",
                app_cs,
            )
        )
        has_on = re.search(r"\bOnStartup\s*\(", app_cs) is not None
        has_base = bool(re.search(r"base\.OnStartup\s*\(", app_cs))
        i_on = app_cs.find("OnStartup")
        i_as = app_cs.find("OfficeOpenXml.ExcelPackage.LicenseContext")
        order_ok = i_on >= 0 and i_as > i_on
        has_license_comment = bool(re.search(r'//.*(?:epplus|license)', app_cs, re.IGNORECASE))
        if has_assign and has_on and has_base and order_ok and has_license_comment:
            results["app_startup_license"] = 1.0
        elif has_assign and has_on and has_base and order_ok:
            results["app_startup_license"] = 0.48
        elif has_assign and has_on and has_base:
            results["app_startup_license"] = 0.48
        elif has_assign and has_on:
            results["app_startup_license"] = 0.28
        elif has_assign:
            results["app_startup_license"] = 0.12

    app_xaml = read_file(out_dir / "LocTool.App" / "App.xaml")
    if app_xaml:
        axl = app_xaml.lower()
        has_app_tag = bool(re.search(r"<application\b", axl))
        has_xclass = bool(re.search(r"x:class", axl))
        no_startup_uri = "startupuri" not in axl
        if has_app_tag and has_xclass and no_startup_uri:
            results["app_xaml_correct"] = 1.0
        elif has_app_tag and no_startup_uri:
            results["app_xaml_correct"] = 0.48
        elif has_app_tag and has_xclass:
            results["app_xaml_correct"] = 0.0

    if len(doc) >= 2800:
        results["output_doc_exists"] = 1.0
    elif len(doc) >= 1400:
        results["output_doc_exists"] = 0.5
    elif len(doc) >= 800:
        results["output_doc_exists"] = 0.28
    elif len(doc) >= 500:
        results["output_doc_exists"] = 0.12
    else:
        results["output_doc_exists"] = 0.0

    dl = doc.lower()

    proj_names = ["loctool.app", "loctool.core", "loctool.viewmodel", "loctool.tests"]
    found_count = sum(1 for n in proj_names if n in dl)

    def _on_table_line(proj_name: str) -> bool:
        for _tl_m in re.finditer(re.escape(proj_name), dl):
            ls = dl.rfind("\n", 0, _tl_m.start()) + 1
            le = dl.find("\n", _tl_m.end())
            if le == -1:
                le = len(dl)
            if "|" in dl[ls:le]:
                return True
        return False

    type_hits = 0
    table_type_hits = 0
    if "loctool.app" in dl and re.search(r"wpf|usewpf|windows\s*presentation", dl):
        if re.search(r"exe|executable|application", dl):
            type_hits += 1
            if _on_table_line("loctool.app"):
                table_type_hits += 1
    if "loctool.core" in dl:
        core_ctx = re.findall(r"loctool\.core.{0,300}", dl, re.DOTALL)
        if any(re.search(r"class\s*lib|library", c) for c in core_ctx):
            type_hits += 1
            if _on_table_line("loctool.core"):
                table_type_hits += 1
    if "loctool.viewmodel" in dl:
        vm_ctx = re.findall(r"loctool\.viewmodel.{0,300}", dl, re.DOTALL)
        if any(re.search(r"class\s*lib|library|mvvm", c) for c in vm_ctx):
            type_hits += 1
            if _on_table_line("loctool.viewmodel"):
                table_type_hits += 1
    if "loctool.tests" in dl and re.search(r"xunit|test\s*project|unit\s*test", dl):
        type_hits += 1
        if _on_table_line("loctool.tests"):
            table_type_hits += 1

    output_type_hits = 0
    def _table_line_has_kw(proj_name: str, kw_pat: str) -> bool:
        for _otm in re.finditer(re.escape(proj_name), dl):
            _ols = dl.rfind("\n", 0, _otm.start()) + 1
            _ole = dl.find("\n", _otm.end())
            if _ole == -1:
                _ole = len(dl)
            _oline = dl[_ols:_ole]
            if "|" in _oline and re.search(kw_pat, _oline):
                return True
        return False
    if _table_line_has_kw("loctool.app", r"\bexe\b"):
        output_type_hits += 1
    if _table_line_has_kw("loctool.core", r"library|classlib"):
        output_type_hits += 1
    if _table_line_has_kw("loctool.viewmodel", r"library|classlib"):
        output_type_hits += 1
    if _table_line_has_kw("loctool.tests", r"\btest\b"):
        output_type_hits += 1

    if found_count == 4 and type_hits >= 4 and table_type_hits >= 4 and output_type_hits >= 4:
        results["doc_all_projects_typed"] = 1.0
    elif found_count == 4 and type_hits >= 4 and table_type_hits >= 4:
        results["doc_all_projects_typed"] = 0.5
    elif found_count == 4 and type_hits >= 2:
        results["doc_all_projects_typed"] = 0.5
    elif found_count == 4:
        results["doc_all_projects_typed"] = 0.35
    elif found_count >= 3:
        results["doc_all_projects_typed"] = 0.2

    if "net8.0-windows" in dl:
        results["doc_target_framework"] = 1.0
    elif "net8.0" in dl:
        results["doc_target_framework"] = 0.15

    def _pkg_ver_ok(pkg_pat: str, ver: str) -> bool:
        for m in re.finditer(pkg_pat, dl):
            start = max(0, m.start() - 72)
            end = min(len(doc), m.end() + 72)
            if ver in doc[start:end]:
                return True
        return False

    def _pkg_ver_in_table(pkg_pat: str, ver: str) -> bool:
        for m in re.finditer(pkg_pat, dl):
            ls = dl.rfind("\n", 0, m.start()) + 1
            le = dl.find("\n", m.end())
            if le == -1:
                le = len(dl)
            line = dl[ls:le]
            if "|" in line and ver in doc[ls : min(len(doc), le + 80)]:
                return True
        return False

    ver_hits = 0
    table_ver_hits = 0
    pkg_checks = [
        (r"epplus", "7.0.0"),
        (r"communitytoolkit[\.\s]*mvvm", "8.2.2"),
        (r"\bxunit\b", "2.7.0"),
        (r"xunit\.runner", "2.5.7"),
        (r"microsoft\.net\.test\.sdk|test[\.\s]*sdk", "17.9.0"),
        (r"\bmoq\b", "4.20.70"),
        (r"coverlet", "6.0.0"),
    ]
    di_m = re.search(
        r"(?:dependencyinjection|dependency[\.\s]*injection)\D{0,50}(\d+\.\d+\.\d+)", dl
    )
    if di_m and di_m.group(1) == "8.0.0" and _pkg_ver_ok(
        r"(?:dependencyinjection|dependency[\.\s]*injection)", "8.0.0"
    ):
        ver_hits += 1
        if _pkg_ver_in_table(
            r"(?:dependencyinjection|dependency[\.\s]*injection)", "8.0.0"
        ):
            table_ver_hits += 1
    for pat, ver in pkg_checks:
        if _pkg_ver_ok(pat, ver):
            ver_hits += 1
            if _pkg_ver_in_table(pat, ver):
                table_ver_hits += 1
    has_pa_in_table = bool(re.search(r"\|.*(?:private\s*assets|privateassets).*\|", dl))
    _source_near_ver_table = False
    for _snm in re.finditer(r"nuget_versions\.json", dl):
        _sn_region = dl[max(0, _snm.start() - 300) : min(len(dl), _snm.end() + 300)]
        if re.search(r"\|.*\d+\.\d+\.\d+.*\|", _sn_region):
            _source_near_ver_table = True
            break
    if ver_hits >= 8 and table_ver_hits >= 8 and has_pa_in_table and _source_near_ver_table:
        results["doc_nuget_versions"] = 1.0
    elif ver_hits >= 8 and table_ver_hits >= 8 and has_pa_in_table:
        results["doc_nuget_versions"] = 0.42
    elif ver_hits >= 8 and table_ver_hits >= 6 and has_pa_in_table:
        results["doc_nuget_versions"] = 0.35
    elif ver_hits >= 8 and table_ver_hits >= 6:
        results["doc_nuget_versions"] = 0.28
    elif ver_hits >= 8:
        results["doc_nuget_versions"] = 0.22
    elif ver_hits >= 6:
        results["doc_nuget_versions"] = 0.15
    else:
        results["doc_nuget_versions"] = min(0.1, (ver_hits / 8.0) * 0.1)

    ep = 0
    api_hit = ("officeopenxml.excelpackage" in dl) or ("excelpackage.licensecontext" in dl)
    if re.search(r"license\s*context", dl):
        ep += 1
    if re.search(r"non[-\s]*commercial", dl):
        ep += 1
    if re.search(r"app\.xaml|onstartup|on[\s_]startup", dl):
        ep += 1
    if re.search(r"licenseexception", dl):
        ep += 1
    elif re.search(r"exception|throw|fail|break|error|crash|blow", dl):
        ep += 1
    ep = min(ep, 4)
    if not api_hit:
        ep = min(ep, 2)
    _cfence = chr(96) * 3
    has_epplus_code_fence = bool(
        re.search(
            _cfence + r"(?:csharp|cs|c#)\s*\n[^`]*LicenseContext\s*=[^`]*\n\s*" + _cfence,
            doc,
            re.IGNORECASE,
        )
    )
    code_snippet_complete = False
    if has_epplus_code_fence:
        for _cb_m in re.finditer(
            _cfence + r"(?:csharp|cs|c#)\s*\n(.*?)\n\s*" + _cfence,
            doc,
            re.IGNORECASE | re.DOTALL,
        ):
            _cb_body = _cb_m.group(1)
            if re.search(r"LicenseContext\s*=", _cb_body) and re.search(r"using\s+OfficeOpenXml", _cb_body):
                code_snippet_complete = True
                break
    has_noncommercial_doc = bool(re.search(r"non[-\s]*commercial", dl))
    has_comm_or_license_exc = bool(re.search(r"\bcommercial\b", dl)) or bool(
        re.search(r"licenseexception", dl)
    )
    if (
        ep >= 4
        and has_epplus_code_fence
        and code_snippet_complete
        and has_noncommercial_doc
        and has_comm_or_license_exc
    ):
        results["doc_epplus_license"] = 1.0
    elif ep >= 4 and has_epplus_code_fence and code_snippet_complete:
        results["doc_epplus_license"] = 0.5
    elif ep >= 4 and has_epplus_code_fence:
        results["doc_epplus_license"] = 0.55
    elif ep >= 4:
        results["doc_epplus_license"] = 0.55
    elif ep == 3:
        results["doc_epplus_license"] = 0.42
    elif ep == 2:
        results["doc_epplus_license"] = 0.2
    elif ep == 1:
        results["doc_epplus_license"] = 0.08
    else:
        results["doc_epplus_license"] = 0.0

    has_svc_locator = False
    for _sl_m in re.finditer(r"service\s*locator", dl):
        before = dl[max(0, _sl_m.start() - 60) : _sl_m.start()]
        if not re.search(
            r"\bnot\b|instead|rather\s+than|avoid|don.?t|reject|over\b|replac", before
        ):
            has_svc_locator = True
            break
    di_pkg_found = bool(re.search(r"microsoft\.extensions\.dependencyinjection", dl))
    di_ver_correct = bool(re.search(r"dependencyinjection\D{0,50}8\.0\.0", dl))
    di_ver_wrong = bool(re.search(r"dependencyinjection\D{0,50}8\.0\.1", dl))
    di_api_near = False
    for _di_m in re.finditer(r"dependencyinjection", dl):
        _di_region = dl[max(0, _di_m.start() - 300) : min(len(dl), _di_m.end() + 300)]
        if re.search(r"servicecollection|serviceprovider|addsingleton|addtransient|buildserviceprovider", _di_region):
            di_api_near = True
            break
    has_di_source = bool(
        re.search(
            r"(?i)(requirements\.md|nuget_versions\.json).*(?:DI|dependency.?injection)|(?:DI|dependency.?injection).*(?:requirements\.md|nuget_versions\.json)",
            doc,
        )
    )
    has_di_code_fence = False
    for _di_m in re.finditer(r"dependencyinjection", dl):
        _di_start = max(0, _di_m.start() - 500)
        _di_end = min(len(doc), _di_m.end() + 500)
        _di_region_doc = doc[_di_start:_di_end]
        if re.search(
            _cfence + r"(?:csharp|cs|c#)\s*\n[^`]*(?:ServiceCollection|AddSingleton|AddTransient)[^`]*\n\s*" + _cfence,
            _di_region_doc,
            re.IGNORECASE | re.DOTALL,
        ):
            has_di_code_fence = True
            break
    if di_pkg_found and di_ver_correct and not has_svc_locator and di_api_near and has_di_source and has_di_code_fence:
        results["doc_di_framework"] = 1.0
    elif di_pkg_found and di_ver_correct and not has_svc_locator and di_api_near and has_di_source:
        results["doc_di_framework"] = 0.5
    elif di_pkg_found and di_ver_correct and not has_svc_locator:
        results["doc_di_framework"] = 0.5
    elif di_pkg_found and di_ver_correct:
        results["doc_di_framework"] = 0.5
    elif di_pkg_found and di_ver_wrong:
        results["doc_di_framework"] = 0.15
    elif di_pkg_found and not has_svc_locator:
        results["doc_di_framework"] = 0.42
    elif re.search(r"dependency\s*injection", dl) and not has_svc_locator:
        results["doc_di_framework"] = 0.35

    has_ref = bool(
        re.search(r"referenc|project\s*ref|depends?\s+on|dependency|→|->|──", dl)
    )
    core_leaf = bool(
        re.search(
            r"core.{0,450}(?:no\s*(?:project\s*)?ref|bottom|leaf|no\s*depend|base\s*layer|lowest)",
            dl,
            re.DOTALL,
        )
    )
    edge_set = set()
    for pat, label in [
        (r"(?:loctool\.)?app.*?(?:→|-->|->|references?\s*→?\s*).*?(?:loctool\.)?viewmodel", "a_vm"),
        (r"(?:loctool\.)?app.*?(?:→|-->|->|references?\s*→?\s*).*?(?:loctool\.)?core", "a_c"),
        (r"(?:loctool\.)?viewmodel.*?(?:→|-->|->|references?\s*→?\s*).*?(?:loctool\.)?core", "vm_c"),
        (r"(?:loctool\.)?tests?.*?(?:→|-->|->|references?\s*→?\s*).*?(?:loctool\.)?core", "t_c"),
        (r"(?:loctool\.)?tests?.*?(?:→|-->|->|references?\s*→?\s*).*?(?:loctool\.)?viewmodel", "t_vm"),
    ]:
        if re.search(pat, dl, re.DOTALL):
            edge_set.add(label)
    _fence = chr(96) * 3
    has_strict_diagram = bool(
        re.search(
            _fence + r"\s*mermaid[\s\S]*?\bgraph\b",
            doc,
            re.DOTALL | re.IGNORECASE,
        )
    ) or bool(re.search(r"\bgraph\s+(?:td|lr|bt|rl)\b", doc, re.IGNORECASE)) or bool(
        re.search(r"(?:-->|├──|└──)", doc)
    )
    _graph_has_tests = False
    _mermaid_block_m = re.search(
        _fence + r"\s*mermaid\s*\n(.*?)\n\s*" + _fence, doc, re.DOTALL | re.IGNORECASE
    )
    if _mermaid_block_m:
        _graph_has_tests = bool(re.search(r"tests?", _mermaid_block_m.group(1), re.IGNORECASE))
    if not _graph_has_tests:
        for _ascii_line in doc.splitlines():
            if re.search(r"├──|└──|→|-->|->", _ascii_line) and re.search(r"tests?", _ascii_line, re.IGNORECASE):
                _graph_has_tests = True
                break
    all_edges = len(edge_set) >= 5
    _graph_block_text = ""
    if _mermaid_block_m:
        _graph_block_text = _mermaid_block_m.group(1).lower()
    if not _graph_block_text:
        _asc_lines = [l.lower() for l in doc.splitlines() if re.search(r"├──|└──|→|-->|->", l)]
        if _asc_lines:
            _graph_block_text = "\n".join(_asc_lines)
    _graph_edge_count = 0
    if _graph_block_text:
        _g_edges = set()
        for _gline in _graph_block_text.splitlines():
            for _arrow in ["-->", "->"]:
                if _arrow not in _gline:
                    continue
                _gparts = _gline.split(_arrow, 1)
                if len(_gparts) == 2:
                    _gsrc, _gtgt = _gparts
                    if re.search(r"app", _gsrc) and re.search(r"viewmodel|view.?model|vm\b", _gtgt):
                        _g_edges.add("a_vm")
                    if re.search(r"app", _gsrc) and re.search(r"core", _gtgt):
                        _g_edges.add("a_c")
                    if re.search(r"viewmodel|view.?model|vm\b", _gsrc) and re.search(r"core", _gtgt):
                        _g_edges.add("vm_c")
                    if re.search(r"test", _gsrc) and re.search(r"core", _gtgt):
                        _g_edges.add("t_c")
                    if re.search(r"test", _gsrc) and re.search(r"viewmodel|view.?model|vm\b", _gtgt):
                        _g_edges.add("t_vm")
                break
        _graph_edge_count = len(_g_edges)
    full_names_in_graph = False
    if _graph_block_text:
        _fn_hits = sum(1 for fn in ["loctool.app", "loctool.core", "loctool.viewmodel", "loctool.tests"] if fn in _graph_block_text)
        if _fn_hits >= 4:
            full_names_in_graph = True
    if has_ref and found_count >= 4 and core_leaf and all_edges and has_strict_diagram and _graph_has_tests and _graph_edge_count >= 5 and full_names_in_graph:
        results["doc_reference_graph"] = 1.0
    elif has_ref and found_count >= 4 and core_leaf and all_edges and has_strict_diagram and _graph_has_tests and _graph_edge_count >= 5:
        results["doc_reference_graph"] = 0.65
    elif has_ref and found_count >= 4 and core_leaf and all_edges and has_strict_diagram and _graph_has_tests and _graph_edge_count >= 3:
        results["doc_reference_graph"] = 0.65
    elif has_ref and found_count >= 4 and core_leaf and all_edges and has_strict_diagram and _graph_has_tests:
        results["doc_reference_graph"] = 0.35
    elif has_ref and found_count >= 4 and core_leaf and all_edges and has_strict_diagram:
        results["doc_reference_graph"] = 0.5
    elif has_ref and found_count >= 4 and core_leaf and (all_edges or has_strict_diagram):
        results["doc_reference_graph"] = 0.5
    elif has_ref and found_count >= 4 and core_leaf:
        results["doc_reference_graph"] = 0.5
    elif has_ref and found_count >= 4:
        results["doc_reference_graph"] = 0.35
    elif has_ref and found_count >= 3:
        results["doc_reference_graph"] = 0.22
    elif found_count >= 3:
        results["doc_reference_graph"] = 0.12

    bp = 0
    if re.search(r"langversion.*latest|latest.*lang", dl):
        bp += 1
    if re.search(r"nullable.*enable|enable.*nullable", dl):
        bp += 1
    if re.search(r"implicit\s*usings?.*enable|enable.*implicit\s*usings?", dl):
        bp += 1
    if re.search(
        r"treat\s*warnings?\s*as\s*errors?|warnings?\s*as\s*errors?.*true", dl
    ):
        bp += 1
    has_analysis_doc = bool(re.search(r"analysis\s*level", dl))
    bp_effect = 0
    if re.search(r"langversion.{0,250}(?:c#|feature|syntax|language)", dl, re.DOTALL):
        bp_effect += 1
    if re.search(r"nullable.{0,250}(?:null\s*ref|nrt|null\s*safe|warning)", dl, re.DOTALL):
        bp_effect += 1
    if re.search(r"treat.*warnings?.{0,250}(?:break|fail|block|ci|build)", dl, re.DOTALL):
        bp_effect += 1
    if re.search(r"analysis.?level.{0,250}(?:analyz|roslyn|diagnostic|recommend)", dl, re.DOTALL):
        bp_effect += 1
    if bp >= 4 and has_analysis_doc and bp_effect >= 4:
        results["doc_build_properties"] = 1.0
    elif bp >= 4 and has_analysis_doc and bp_effect >= 3:
        results["doc_build_properties"] = 0.72
    elif bp >= 4 and has_analysis_doc:
        results["doc_build_properties"] = 0.55
    elif bp >= 4:
        results["doc_build_properties"] = 0.5
    elif bp == 3:
        results["doc_build_properties"] = 0.28
    elif bp == 2:
        results["doc_build_properties"] = 0.15
    elif bp == 1:
        results["doc_build_properties"] = 0.08
    else:
        results["doc_build_properties"] = 0.0

    ns = 0
    if re.search(r"nuget\.org|api\.nuget\.org", dl):
        ns += 1
    if re.search(r"contoso", dl):
        ns += 1
    if re.search(r"nuget\.config|nuget\s*config", dl):
        ns += 1
    if "package_baseline" in dl or "baseline.csv" in dl:
        ns += 1
    has_clear_mention = bool(
        re.search(r'<\s*clear\s*/?\s*>|clear.*(?:machine|global|inherited)|prevent.*(?:machine|global)', dl)
    )
    if has_clear_mention:
        ns += 1
    if ns >= 5:
        results["doc_nuget_sources"] = 1.0
    elif ns == 4:
        results["doc_nuget_sources"] = 0.52
    elif ns == 3:
        results["doc_nuget_sources"] = 0.28
    elif ns == 2:
        results["doc_nuget_sources"] = 0.15
    elif ns == 1:
        results["doc_nuget_sources"] = 0.08
    else:
        results["doc_nuget_sources"] = 0.0

    phantom_penalty = 0
    if "logging.abstractions" in dl:
        for m in re.finditer(r"logging\.abstractions", dl):
            before = dl[max(0, m.start() - 120) : m.start()]
            if not re.search(
                r"\bnot\b|don.?t|avoid|ignor|exclud|omit|phantom|incorrect|absent|do\s+not|should\s+not|must\s+not|remov|reject|out\s+of\s+scope|mislead",
                before,
            ):
                phantom_penalty += 1
                break
    if re.search(r"configuration\.json", dl):
        for m in re.finditer(r"configuration\.json", dl):
            before = dl[max(0, m.start() - 120) : m.start()]
            if not re.search(
                r"\bnot\b|don.?t|avoid|ignor|exclud|omit|phantom|incorrect|absent|do\s+not|should\s+not|must\s+not|remov|reject|out\s+of\s+scope|mislead",
                before,
            ):
                phantom_penalty += 1
                break
    results["doc_no_phantom_packages"] = 1.0 if phantom_penalty == 0 else 0.0

    sln = read_file(out_dir / "LocTool.sln")
    if sln:
        sl = sln.lower()
        sln_proj_count = sum(1 for n in proj_names if n in sl)
        has_sln_fmt = bool(re.search(r"project\(", sl))
        end_projects = len(re.findall(r"endproject", sl))
        proj_lines = sum(
            1
            for ln in sln.splitlines()
            if "project(" in ln.lower() and ".csproj" in ln.lower()
        )
        fmt_ok = (
            has_sln_fmt
            and end_projects >= 4
            and "format version" in sl
            and proj_lines >= 4
        )
        has_sln_configs = bool(
            re.search(r"globalsection\s*\(\s*solutionconfigurationplatforms", sl)
        )
        has_debug_cfg = bool(re.search(r"debug\|any\s*cpu", sl))
        has_release_cfg = bool(re.search(r"release\|any\s*cpu", sl))
        config_ok = has_sln_configs and has_debug_cfg and has_release_cfg
        has_proj_config = bool(
            re.search(r"globalsection\s*\(\s*projectconfigurationplatforms", sl)
        )
        if sln_proj_count == 4 and fmt_ok and config_ok and has_proj_config:
            results["sln_file_valid"] = 1.0
        elif sln_proj_count == 4 and fmt_ok and config_ok:
            results["sln_file_valid"] = 0.65
        elif sln_proj_count == 4 and fmt_ok:
            results["sln_file_valid"] = 0.42
        elif sln_proj_count == 4 and has_sln_fmt and proj_lines >= 4:
            results["sln_file_valid"] = 0.38
        elif sln_proj_count == 4 and has_sln_fmt:
            results["sln_file_valid"] = 0.25
        elif sln_proj_count >= 3 and has_sln_fmt:
            results["sln_file_valid"] = 0.15
        elif sln_proj_count >= 1:
            results["sln_file_valid"] = 0.08

        # sln_build_configurations
        has_global_section = "GlobalSection(SolutionConfigurationPlatforms)" in sln
        has_debug = bool(re.search(r"Debug\|Any CPU", sln))
        has_release = bool(re.search(r"Release\|Any CPU", sln))
        has_proj_config = "GlobalSection(ProjectConfigurationPlatforms)" in sln
        if has_global_section and has_debug and has_release and has_proj_config:
            results["sln_build_configurations"] = 1.0
        elif has_global_section and (has_debug or has_release):
            results["sln_build_configurations"] = 0.5

    app_csproj = read_file(out_dir / "LocTool.App" / "LocTool.App.csproj")
    core_csproj = read_file(out_dir / "LocTool.Core" / "LocTool.Core.csproj")
    vm_csproj = read_file(out_dir / "LocTool.ViewModel" / "LocTool.ViewModel.csproj")
    test_csproj = read_file(out_dir / "LocTool.Tests" / "LocTool.Tests.csproj")

    if app_csproj:
        al = app_csproj.lower()
        h = 0
        if re.search(r"<outputtype>\s*exe\s*</outputtype>", al):
            h += 1
        if re.search(r"<usewpf>\s*true\s*</usewpf>", al):
            h += 1
        if re.search(
            r'<packagereference[^>]+include\s*=\s*["\']microsoft\.extensions\.dependencyinjection["\'][^>]*version\s*=\s*["\']8\.0\.0["\']',
            al,
        ):
            h += 1
        elif "dependencyinjection" in al and "8.0.0" in app_csproj:
            h += 0.42
        if (
            "loctool.viewmodel" in al
            and "loctool.core" in al
            and "projectreference" in al
        ):
            h += 1
        if "configuration.json" not in al:
            h += 1
        xm = _csproj_well_formed(app_csproj)
        results["csproj_app_correct"] = min(h / 5.0, 1.0) * (1.0 if xm else 0.55)

    if core_csproj:
        cl_c = core_csproj.lower()
        h = 0
        if re.search(
            r'<packagereference[^>]+include\s*=\s*["\']epplus["\'][^>]*version\s*=\s*["\']7\.0\.0["\']',
            cl_c,
        ):
            h += 1
        elif "epplus" in cl_c and "7.0.0" in core_csproj:
            h += 0.42
        if "projectreference" not in cl_c:
            h += 1
        if "logging.abstractions" not in cl_c:
            h += 1
        xm = _csproj_well_formed(core_csproj)
        results["csproj_core_correct"] = (h / 3.0) * (1.0 if xm else 0.55)

    if vm_csproj:
        cl_v = vm_csproj.lower()
        h = 0
        if re.search(
            r'<packagereference[^>]+include\s*=\s*["\']communitytoolkit\.mvvm["\'][^>]*version\s*=\s*["\']8\.2\.2["\']',
            cl_v,
        ):
            h += 1
        elif "communitytoolkit.mvvm" in cl_v and "8.2.2" in vm_csproj:
            h += 0.42
        if "loctool.core" in cl_v and "projectreference" in cl_v:
            h += 1
        xm = _csproj_well_formed(vm_csproj)
        results["csproj_viewmodel_correct"] = (h / 2.0) * (1.0 if xm else 0.55)

    if test_csproj:
        cl_t = test_csproj.lower()
        pkg = sum(
            1
            for p in [
                "xunit",
                "xunit.runner.visualstudio",
                "microsoft.net.test.sdk",
                "moq",
                "coverlet.collector",
            ]
            if p in cl_t
        )
        ver = 0
        if re.search(
            r'<packagereference[^>]+include\s*=\s*["\']xunit["\'][^>]*version\s*=\s*["\']2\.7\.0["\']',
            cl_t,
        ):
            ver += 1
        elif "2.7.0" in test_csproj and "xunit" in cl_t:
            ver += 0.45
        if re.search(
            r'<packagereference[^>]+include\s*=\s*["\']xunit\.runner\.visualstudio["\'][^>]*version\s*=\s*["\']2\.5\.7["\']',
            cl_t,
        ):
            ver += 1
        elif "2.5.7" in test_csproj:
            ver += 0.45
        if re.search(
            r'<packagereference[^>]+include\s*=\s*["\']microsoft\.net\.test\.sdk["\'][^>]*version\s*=\s*["\']17\.9\.0["\']',
            cl_t,
        ):
            ver += 1
        elif "17.9.0" in test_csproj:
            ver += 0.45
        if re.search(
            r'<packagereference[^>]+include\s*=\s*["\']moq["\'][^>]*version\s*=\s*["\']4\.20\.70["\']',
            cl_t,
        ):
            ver += 1
        elif "4.20.70" in test_csproj:
            ver += 0.45
        if re.search(
            r'<packagereference[^>]+include\s*=\s*["\']coverlet\.collector["\'][^>]*version\s*=\s*["\']6\.0\.0["\']',
            cl_t,
        ):
            ver += 1
        elif "6.0.0" in test_csproj and "coverlet" in cl_t:
            ver += 0.45
        refs = sum(
            1
            for r in ["loctool.core", "loctool.viewmodel"]
            if r in cl_t and "projectreference" in cl_t
        )
        pa = 0
        if re.search(
            r"coverlet\.collector.*?(?:<privateassets>\s*all\s*</privateassets>|privateassets\s*=\s*[\"']all[\"'])",
            cl_t,
            re.DOTALL,
        ):
            pa += 1
        if re.search(
            r"xunit\.runner\.visualstudio.*?(?:<privateassets>\s*all\s*</privateassets>|privateassets\s*=\s*[\"']all[\"'])",
            cl_t,
            re.DOTALL,
        ):
            pa += 1
        raw = pkg + ver + refs + pa
        base_t = 1.0 if _csproj_well_formed(test_csproj) else 0.55
        if raw >= 14:
            results["csproj_tests_correct"] = 1.0 * base_t
        elif raw >= 12:
            results["csproj_tests_correct"] = 0.52 * base_t
        elif raw >= 10:
            results["csproj_tests_correct"] = 0.35 * base_t
        elif raw >= 8:
            results["csproj_tests_correct"] = 0.22 * base_t
        else:
            results["csproj_tests_correct"] = min(raw / 16.0, 0.18) * base_t

    csproj_all = [c for c in [app_csproj, core_csproj, vm_csproj, test_csproj] if c]
    if csproj_all:
        ok = sum(1 for c in csproj_all if "net8.0-windows" in c.lower())
        ratio = ok / len(csproj_all)
        results["csproj_frameworks_correct"] = (
            1.0 if ratio >= 1.0 else (0.5 if ratio >= 0.75 else ratio * 0.45)
        )

    props = ""
    for name in ["Directory.Build.props", "directory.build.props"]:
        props = read_file(out_dir / name)
        if props:
            break
    if props:
        base_count, has_al, props_comments = _props_strict_count(props)
        if base_count >= 4 and has_al and props_comments >= 3:
            results["directory_build_props"] = 1.0
        elif base_count >= 4 and has_al:
            results["directory_build_props"] = 0.5
        elif base_count >= 4:
            results["directory_build_props"] = 0.35
        elif base_count == 3:
            results["directory_build_props"] = 0.2
        elif base_count == 2:
            results["directory_build_props"] = 0.1
        elif base_count == 1:
            results["directory_build_props"] = 0.05
        else:
            results["directory_build_props"] = 0.0
        results["props_has_xml_comments"] = (
            1.0 if props_comments >= 3 else (0.5 if props_comments >= 1 else 0.0)
        )

    nc = ""
    for name in ["NuGet.config", "nuget.config", "NuGet.Config", "nuget.Config"]:
        nc = read_file(out_dir / name)
        if nc:
            break
    if nc:
        ncn = nc.replace(" ", "").replace("\n", "").replace("\t", "")
        ncl = ncn.lower()
        nh = 0
        if "https://api.nuget.org/v3/index.json" in ncn:
            nh += 1
        if "https://pkgs.contoso.com/nuget/v3/index.json" in ncn:
            nh += 1
        if re.search(r"packagesources", ncl):
            nh += 1
        if "<clear" in ncl or "/clear" in ncl:
            nh += 1
        has_internal_key = bool(
            re.search(
                r'key\s*=\s*["\'][^"\']*[Ii]nternal[^"\']*["\']', nc
            )
        )
        if has_internal_key:
            nh += 1
        has_clear_comment = bool(
            re.search(r"<!--[^>]*(?:clear|pollut|machine|global|implicit|inherit)", nc, re.IGNORECASE)
        )
        if nh >= 5 and has_clear_comment:
            results["nuget_config_correct"] = 1.0
        elif nh >= 5:
            results["nuget_config_correct"] = 0.5
        elif nh == 4:
            results["nuget_config_correct"] = 0.32
        elif nh == 3:
            results["nuget_config_correct"] = 0.2
        elif nh == 2:
            results["nuget_config_correct"] = 0.1
        elif nh == 1:
            results["nuget_config_correct"] = 0.05
        else:
            results["nuget_config_correct"] = 0.0

    if not any([app_csproj, core_csproj, vm_csproj, test_csproj]):
        pass
    else:
        gen = " ".join(
            filter(
                None,
                [
                    app_csproj,
                    core_csproj,
                    vm_csproj,
                    test_csproj,
                    app_cs,
                    csv_text,
                ],
            )
        ).lower()
        stale = [
            "5.8.4",
            "6.0.1",
            "2.4.2",
            "2.4.5",
            "17.4.1",
            "4.18.4",
            "net6.0-windows",
        ]
        draft = [
            "7.1.0",
            "8.3.0",
            "17.10.0",
            "4.20.72",
            "8.0.1",
            "2.8.0",
            "2.5.8",
            "6.0.2",
        ]
        bad = sum(1 for m in stale + draft if m in gen)
        results["no_wrong_versions"] = 1.0 if bad == 0 else 0.0

    # --- doc_source_provenance ---
    sp = 0
    if re.search(r"requirements\.md", dl):
        sp += 1
    if re.search(r"nuget_versions\.json", dl):
        sp += 1
    noise_markers = [
        r"draft.{0,20}(?:nuget|version|registr)",
        r"old.{0,20}(?:nuget|version|registr)",
        r"addendum",
        r"unrelated.{0,20}(?:deploy|plan|datasync)",
        r"sprint.?8.{0,20}(?:pin|csv|export|staging)",
    ]
    noise_hits = sum(1 for pat in noise_markers if re.search(pat, dl))
    excluded_file_pats = [
        r"old_nuget_versions\.json",
        r"draft_nuget_versions\.json",
        r"requirements_addendum",
        r"sprint.?8.{0,20}(?:package_pin|pin_export|csv)",
        r"unrelated_deployment",
        r"coding_standards\.md",
    ]
    ef_count = sum(1 for p in excluded_file_pats if re.search(p, dl))
    if noise_hits >= 3:
        sp += 1
    elif noise_hits >= 2:
        sp += 0.5
    elif noise_hits >= 1:
        sp += 0.25
    if sp >= 3 and ef_count >= 5:
        results["doc_source_provenance"] = 1.0
    elif sp >= 2.5 and ef_count >= 5:
        results["doc_source_provenance"] = 0.5
    elif sp >= 3:
        results["doc_source_provenance"] = 0.65
    elif sp >= 2.5:
        results["doc_source_provenance"] = 0.35
    elif sp >= 2:
        results["doc_source_provenance"] = 0.2
    elif sp >= 1:
        results["doc_source_provenance"] = 0.1

    # --- doc_per_file_exclusion ---
    if ef_count >= 5:
        results["doc_per_file_exclusion"] = 1.0
    elif ef_count >= 3:
        results["doc_per_file_exclusion"] = 0.5
    elif ef_count >= 1:
        results["doc_per_file_exclusion"] = 0.15
    else:
        results["doc_per_file_exclusion"] = 0.0

    # --- doc_quick_start_steps ---
    qs_kw = 0
    if re.search(r"(?:clone|git\s+clone)", dl):
        qs_kw += 1
    if re.search(r"(?:restore|nuget\s+restore|dotnet\s+restore)", dl):
        qs_kw += 1
    if re.search(r"(?:\bbuild\b|dotnet\s+build|msbuild)", dl):
        qs_kw += 1
    if re.search(r"(?:\brun\b|dotnet\s+run|start.*app|launch)", dl):
        qs_kw += 1
    if re.search(r"(?:vpn|credential|authenticat|feed\s*check|internal\s*feed)", dl):
        qs_kw += 1
    has_numbered_steps = bool(re.search(r"(?:^|\n)\s*(?:1[\.\)]\s|step\s*1)", dl))
    has_actual_cmd = bool(
        re.search(
            _fence + r"(?:bash|shell|powershell|cmd|sh)?\s*\n[^`]*dotnet\s+(?:restore|build|run)[^`]*\n",
            doc,
            re.IGNORECASE,
        )
    )
    if has_numbered_steps and qs_kw >= 5 and has_actual_cmd:
        results["doc_quick_start_steps"] = 1.0
    elif has_numbered_steps and qs_kw >= 5:
        results["doc_quick_start_steps"] = 0.65
    elif has_numbered_steps and qs_kw >= 3:
        results["doc_quick_start_steps"] = 0.42
    elif qs_kw >= 4:
        results["doc_quick_start_steps"] = 0.22
    else:
        results["doc_quick_start_steps"] = 0.0

    # --- doc_troubleshoot_faq ---
    has_ts_heading = bool(
        re.search(r"(?:^|\n)\s*#+\s*(?:troubleshoot|faq|common\s*(?:issue|problem|error|pitfall)|gotcha|known\s*issue)", dl)
    )
    ts_scenarios = 0
    if "licenseexception" in dl:
        ts_scenarios += 1
    if re.search(r"treatwarningsaserrors", dl):
        ts_scenarios += 1
    if re.search(r"contoso.{0,120}(?:fail|vpn|credential|unreach|denied|error|timeout|auth)", dl, re.DOTALL):
        ts_scenarios += 1
    if re.search(r"(?:windows.*sdk|wpf.*sdk|net8\.0.windows.*missing|sdk.*not.*found|workload)", dl):
        ts_scenarios += 1
    if has_ts_heading and ts_scenarios >= 4:
        results["doc_troubleshoot_faq"] = 1.0
    elif has_ts_heading and ts_scenarios >= 3:
        results["doc_troubleshoot_faq"] = 0.65
    elif has_ts_heading and ts_scenarios >= 2:
        results["doc_troubleshoot_faq"] = 0.42
    elif ts_scenarios >= 2:
        results["doc_troubleshoot_faq"] = 0.15
    else:
        results["doc_troubleshoot_faq"] = 0.0

    # --- doc_per_claim_annotation ---
    claim_pats = [
        r"(?:per|from|see|cf\.?|source:?)\s*(?:`|[\"'])?\s*requirements\.md",
        r"(?:per|from|see|cf\.?|source:?)\s*(?:`|[\"'])?\s*nuget_versions\.json",
        r"§\s*\d",
        r"section\s+\d+(?:\.\d+)?\s+(?:of|in)\s+requirements",
        r"status[\s:]*[\"'`]?current[\"'`]?",
    ]
    claim_count = sum(1 for p in claim_pats if re.search(p, dl))
    if claim_count >= 3:
        results["doc_per_claim_annotation"] = 1.0
    elif claim_count >= 2:
        results["doc_per_claim_annotation"] = 0.5
    else:
        results["doc_per_claim_annotation"] = 0.0

    # --- doc_csv_ci_narrative ---
    csv_maint = 0
    if re.search(r"package_baseline.{0,250}(?:update|maintain|edit|modify|add.*row|change)", dl, re.DOTALL):
        csv_maint += 1
    if re.search(r"(?:ci|pipeline|continuous|automated|build\s*server).{0,250}(?:csv|baseline|drift|diff|pin)", dl, re.DOTALL):
        csv_maint += 1
    csv_maint = min(csv_maint, 2)
    if csv_maint >= 2:
        results["doc_csv_ci_narrative"] = 1.0
    elif csv_maint >= 1:
        results["doc_csv_ci_narrative"] = 0.5
    else:
        results["doc_csv_ci_narrative"] = 0.0

    # --- doc_noncomm_vs_comm ---
    noncomm_m = re.search(r"non[-\s]*commercial", dl)
    comm_contrast = False
    comm_biz_context = False
    if noncomm_m:
        region = dl[max(0, noncomm_m.start() - 250) : min(len(dl), noncomm_m.end() + 250)]
        if re.search(r"\bcommercial\b", region) and re.search(
            r"(?:when|if|for|paid|revenue|proprietar|license\s*type|choose|option|mode)", region
        ):
            comm_contrast = True
        if re.search(r"\bcommercial\b", region) and re.search(
            r"(?:revenue|commercial[\s-]*use|paid|fee)", region
        ):
            comm_biz_context = True
    if comm_contrast and comm_biz_context:
        results["doc_noncomm_vs_comm"] = 1.0
    elif comm_contrast:
        results["doc_noncomm_vs_comm"] = 0.5
    else:
        results["doc_noncomm_vs_comm"] = 0.0

    # --- app_cs_startup_comment ---
    if app_cs:
        lc_idx = app_cs.find("LicenseContext")
        if lc_idx >= 0:
            region = app_cs[max(0, lc_idx - 350) : min(len(app_cs), lc_idx + 150)]
            has_cmt = bool(re.search(r"(?://|/\*|///)\s*\S", region))
            cmt_explains = bool(
                re.search(
                    r"(?:before|first|startup|early|prior|must|initiali|runtime|non\s*commercial)",
                    region.lower(),
                )
            )
            if has_cmt and cmt_explains:
                results["app_cs_startup_comment"] = 1.0
            elif has_cmt:
                results["app_cs_startup_comment"] = 0.5
            else:
                results["app_cs_startup_comment"] = 0.0

    # --- version_audit.csv ---
    audit_text = read_file(out_dir / "version_audit.csv")
    if audit_text:
        a_clean = audit_text.lstrip("\ufeff").strip()
        a_reader = csv.reader(StringIO(a_clean))
        a_rows = list(a_reader)
        if len(a_rows) >= 2 and len(a_rows[0]) >= 7:
            a_h = [c.strip().lower() for c in a_rows[0]]
            h_ok = "package" in a_h[0] and "selected" in a_h[-1]

            a_data = {}
            for r in a_rows[1:]:
                if not r or not any(c.strip() for c in r):
                    continue
                while len(r) < 7:
                    r.append("")
                pid = r[0].strip().lower()
                if pid:
                    a_data[pid] = tuple(c.strip() for c in r[1:7])

            pkg_found = sum(1 for k in _AUDIT_EXPECTED if k in a_data)
            if h_ok and pkg_found >= 9:
                results["version_audit_structure"] = 1.0
            elif h_ok and pkg_found >= 7:
                results["version_audit_structure"] = 0.5
            elif h_ok and pkg_found >= 5:
                results["version_audit_structure"] = 0.32
            elif h_ok:
                results["version_audit_structure"] = 0.15
            else:
                results["version_audit_structure"] = 0.08

            sel_ok = 0
            for pkg, exp in _AUDIT_EXPECTED.items():
                if pkg in a_data:
                    actual_sel = a_data[pkg][5] if len(a_data[pkg]) > 5 else ""
                    if actual_sel == exp[5]:
                        sel_ok += 1
            if sel_ok >= 10:
                results["version_audit_selected"] = 1.0
            elif sel_ok >= 8:
                results["version_audit_selected"] = 0.5
            elif sel_ok >= 6:
                results["version_audit_selected"] = 0.32
            elif sel_ok >= 4:
                results["version_audit_selected"] = 0.15

            cell_ok = 0
            cell_total = 0
            for pkg, exp in _AUDIT_EXPECTED.items():
                if pkg in a_data:
                    for i in range(min(5, len(a_data[pkg]))):
                        cell_total += 1
                        if a_data[pkg][i] == exp[i]:
                            cell_ok += 1
            if cell_total > 0:
                ratio = cell_ok / cell_total
                if ratio >= 0.96:
                    results["version_audit_cross_ref"] = 1.0
                elif ratio >= 0.88:
                    results["version_audit_cross_ref"] = 0.5
                elif ratio >= 0.75:
                    results["version_audit_cross_ref"] = 0.35
                elif ratio >= 0.55:
                    results["version_audit_cross_ref"] = 0.2
                elif ratio >= 0.35:
                    results["version_audit_cross_ref"] = 0.1

    # --- doc_windows_tfm_rationale ---
    win_why = 0
    if re.search(
        r"(?:net8\.0-windows|-windows).{0,300}(?:wpf|windows\s*(?:desktop|sdk|platform)|presentation\s*foundation)",
        dl, re.DOTALL,
    ):
        win_why += 1
    if re.search(
        r"(?:wpf|usewpf|windows\s*presentation).{0,300}(?:requir|need|mandat|depend|necessitat).{0,100}(?:-windows|windows\s*(?:suffix|tfm|sdk|target))",
        dl, re.DOTALL,
    ):
        win_why += 1
    if re.search(r"microsoft\.net\.sdk\.windowsdesktop|windowsdesktopapp", dl):
        win_why += 1
    results["doc_windows_tfm_rationale"] = (
        1.0 if win_why >= 2 else (0.5 if win_why >= 1 else 0.0)
    )

    # --- doc_private_assets_explain ---
    pa_exp = 0
    if re.search(
        r"privateassets.{0,250}(?:transitive|consum|leak|propagat|flow|downstream|depend|expos)",
        dl, re.DOTALL,
    ):
        pa_exp += 1
    if re.search(
        r"privateassets.{0,250}(?:design.time|build.time|development.only|runtime.*exclud|not.*(?:ship|redistribut|bundle))",
        dl, re.DOTALL,
    ):
        pa_exp += 1
    if re.search(
        r"(?:coverlet|xunit\.runner).{0,250}privateassets",
        dl, re.DOTALL,
    ):
        pa_exp += 1
    pa_transitive_explicit = bool(re.search(
        r"privateassets.{0,250}(?:transitive|consuming|leak|downstream)",
        dl, re.DOTALL,
    ))
    results["doc_private_assets_explain"] = (
        1.0 if pa_exp >= 2 and pa_transitive_explicit else (0.5 if pa_exp >= 1 else 0.0)
    )

    # --- doc_version_decision_process ---
    vdp = 0
    if re.search(
        r"(?:8\.0\.0).{0,250}(?:anchor|pin|confirm|match|verif|only\s+(?:appear|found|exist|match))",
        dl, re.DOTALL,
    ):
        vdp += 1
    if re.search(
        r"(?:decision|resolv|conflict|disagree).{0,300}(?:tree|flow|process|algorithm|procedure|step|rule|method)",
        dl, re.DOTALL,
    ):
        vdp += 1
    if re.search(
        r"(?:step|rule|when|if).*(?:conflict|disagree|mismatch).{0,200}(?:requirements\.md|formal\s*(?:doc|spec))",
        dl, re.DOTALL,
    ):
        vdp += 1
    results["doc_version_decision_process"] = (
        1.0 if vdp >= 3 else (0.5 if vdp >= 2 else 0.0)
    )

    return results
```

## LLM Judge Rubric

**Hybrid scoring weights:** Automated checks contribute **15%** of the task score; this rubric contributes **85%**. Score each criterion at **0.0**, **0.5**, or **1.0** unless noted. Use `LocTool/docs/onboarding_reference_gold_snippet.md` as the **structure and depth benchmark**: **1.0** only when the answer **meets or clearly exceeds** that reference; **0.5** when it is close but noticeably shallower or missing major elements from the reference; **0.0** when `LocTool/output/solution_structure.md` is missing or off-topic (then **0.0 on every criterion below**).

### Criterion 1: Gold snippet structural alignment (Weight: 5%)

**Score 1.0**: Covers **every** major bucket from the gold snippet — (1) purpose & audience, (2) solution layout table, (3) dependency graph as Mermaid/ASCII, (4) NuGet restore & feeds with `<clear />` narrative, (5) EPPlus licensing with C# snippet, (6) build defaults tied to `Directory.Build.props`, (7) quick start numbered steps, (8) "when sources disagree" explicit sentence — with comparable specificity; nothing essential from the snippet's checklist is missing.
**Score 0.5**: Most sections exist but two or more gold-snippet buckets are absent, thin, or merged into vague prose (e.g. no dependency graph visualization, no quick start steps, feeds covered in a single sentence, no conflict-resolution language).
**Score 0.0**: Ignores the benchmark entirely or the document is missing (see header rule).

### Criterion 2: Structured document architecture — table-driven, scannable format (Weight: 7%)

**Score 1.0 (tech-lead bar):** Markdown **tables** (not loose bullets) list **each project** with **TargetFramework `net8.0-windows`** and **every** `PackageReference` for that project with **exact versions** aligned to `requirements.md` + `nuget_versions.json`; all 8 package versions appear inside table rows (not scattered in prose); explicitly ties those rows to the on-disk **`package_baseline.csv`** and the **`LocTool.App/App.xaml.cs`** license stub; design-time-only packages annotated with **`PrivateAssets="all"`**; dependency direction shown via **Mermaid `graph TD` or ASCII art** (not just prose).
**Score 0.5 (basic bar):** All projects and packages are mentioned with roughly correct versions, but some versions live in loose bullets/prose rather than table rows, TFM is only stated once globally, omits the CSV/`App.xaml.cs` linkage, no `PrivateAssets` annotation, or dependency direction described in prose only without a visual diagram.
**Score 0.0**: Unstructured wall of text, wrong projects, or missing file (see header rule).

### Criterion 3: Version accuracy, complete registry reasoning chain, and conflict transparency (Weight: 8%)

**Score 1.0**: Every version/TFM matches the approved requirements + `nuget_versions.json`; explicit chain from **DI 8.0.0 in requirements.md** → **`nuget_versions.json` as canonical** → **draft/old registries AND addendum rejected**; calls out Sprint 7 / diagram traps (phantom `Logging.Abstractions`, inflated package versions) and **explicitly explains why the addendum's "corrections" were not adopted** (requirements.md v2.1 remains unchanged, addendum never merged). No `Microsoft.Extensions.Configuration.Json` or `Logging.Abstractions` appear as actual dependencies.
**Score 0.5**: Versions mostly right but reasoning is thin or implied — reader cannot see the full reasoning chain (DI anchor → registry selection → rejection of alternatives), or fails to explicitly address the addendum/draft/architecture_diagram contradictions.
**Score 0.0**: Wrong registry, wrong TFM, phantom package, follows the addendum's version bumps, or missing file (see header rule).

### Criterion 4: EPPlus license — implementation depth and C# snippet (Weight: 6%)

**Score 1.0**: Includes an actual **C# code snippet** in a fenced code block matching `requirements.md` / `epplus_license_notes.md` (`OfficeOpenXml.ExcelPackage.LicenseContext = OfficeOpenXml.LicenseContext.NonCommercial` in `OnStartup` **before** first EPPlus use), names **`LicenseException`**, explains **NonCommercial vs Commercial** (when each applies), and explains **temporal ordering** (must be set before any EPPlus API call, not just "in OnStartup" but "before first use"; placing it in a static constructor or helper risks out-of-order initialization). The automated `doc_epplus_license` key mirrors this: fenced snippet + **NonCommercial** in prose is not enough for 1.0 unless **Commercial** or **`LicenseException`** is also named.
**Score 0.5**: Right idea (LicenseContext, OnStartup, exception) but no actual C# code block, snippet drifts from the approved wording, omits license-type contrast, or omits timing nuance (matches automated 0.5 when a fence exists but Commercial / `LicenseException` is missing).
**Score 0.0**: Hand-wavy "set a license" only, or missing file (see header rule).

### Criterion 5: NuGet sources, feed isolation, and compliance narrative (Weight: 4%)

**Score 1.0**: States **both** public gallery + Contoso internal URLs, explains that **`NuGet.config` must use `<clear />` before `<add>`** to prevent machine-wide source pollution, and notes **credential/VPN/compliance** requirements for the internal feed without inventing secrets.
**Score 0.5**: Lists both URLs but no hygiene story (`<clear />` purpose) and no internal-feed access caveat.
**Score 0.0**: Single feed only, wrong URLs, or missing file (see header rule).

### Criterion 6: Explicit rejection reasoning for each excluded material (Weight: 10%)

**Score 1.0**: Individually identifies and explains why **each** of the following was **not** used as a version/dependency source: (a) **`draft_nuget_versions.json`** — unapproved Sprint 7 registry despite "production-baseline" label; (b) **`old_nuget_versions.json`** — legacy Sprint 4 baseline; (c) **`requirements_addendum_sprint8.md`** — never merged into requirements.md v2.1; (d) **`architecture_diagram.md`** — updated to match draft/addendum versions; (e) **`sprint8_package_pin_export.csv`** — staging CI export, not approved; (f) **`coding_standards.md`** — contains incorrect MVVM version 8.3.0. At least five of these six must be explicitly named with a one-line rationale.
**Score 0.5**: States requirements precedence in general but names only one or two specific excluded files, or explains some but not why the addendum specifically was rejected.
**Score 0.0**: Treats any excluded material as authoritative, or missing file (see header rule).

### Criterion 7: Onboarding quick start with troubleshooting (Weight: 7%)

**Score 1.0**: Numbered **clone → authenticate/VPN → restore → build → run** path for the App project with actual `dotnet` commands in a fenced code block (e.g., `dotnet restore`, `dotnet build`, `dotnet run --project ...`), plus troubleshooting guidance for **≥ three** of: EPPlus `LicenseException` (forgot license line), Contoso feed restore failure (VPN/credentials), missing Windows/WPF SDK (`net8.0-windows` TFM), **`TreatWarningsAsErrors`** breaking the build on new warnings, NuGet package version mismatch after using wrong registry.
**Score 0.5**: Accurate reference material but quick-start steps lack actual shell commands in code blocks, **or** troubleshooting covers only one scenario, **or** no dedicated troubleshooting/FAQ section.
**Score 0.0**: No actionable steps, or missing file (see header rule).

### Criterion 8: Per-file source provenance annotation (Weight: 4%)

**Score 1.0**: Names **`requirements.md`** + **`nuget_versions.json`** as authoritative **and** annotates key claims in the document with their source (e.g., "version numbers from `nuget_versions.json` (status: `current`)", "DI 8.0.0 per `requirements.md` §5.1"). Flags all five noise/draft/staging/addendum artifacts (`old_nuget_versions.json`, `draft_nuget_versions.json`, `requirements_addendum_sprint8.md`, `unrelated_deployment_plan.md`, `sprint8_package_pin_export.csv`) as out of scope.
**Score 0.5**: Mentions the formal doc as authoritative but does not annotate specific claims with source files, or does not call out all five excluded artifacts.
**Score 0.0**: No attribution, or missing file (see header rule).

### Criterion 9: Dependency graph visualization — Mermaid or ASCII art (Weight: 5%)

**Score 1.0**: Contains a **Mermaid `graph TD`** code block or a clear **ASCII art diagram** showing **all five** directed edges: App → ViewModel, App → Core, ViewModel → Core, Tests → Core, Tests → ViewModel; clearly labels Core as the leaf node with no outgoing project references; the diagram is self-contained and readable without surrounding prose. The automated `doc_reference_graph` key treats **Mermaid `flowchart`** without the `graph` keyword, or prose-only edge wording, as below full automated credit unless the doc also includes **`graph`**, **`-->`**, **`├──`**, or **`└──`** in a diagram block or ASCII tree as in the Grading Criteria checklist.
**Score 0.5**: Has some form of dependency notation (e.g., → arrows in prose or a partial list of references) but not a standalone visual diagram, or the diagram omits one or two edges, or uses ambiguous direction.
**Score 0.0**: No dependency visualization, only prose description, or missing file (see header rule).

### Criterion 10: Build configuration narrative, CSV maintainability, and code quality (Weight: 8%)

**Score 1.0**: (a) **Directory.Build.props** — explains each shared property's **effect** (e.g., `TreatWarningsAsErrors` breaks build on warnings, `AnalysisLevel=latest-recommended` enables recommended Roslyn analyzers, `LangVersion=latest` unlocks latest C# language features, `Nullable=enable` turns on NRT warnings) and ties them to the config template; (b) **CSV maintainability** — explains how `package_baseline.csv` is structured, how to update it when packages change, and how CI can consume it for drift detection (ideally with a concrete command or script snippet); (c) **App.xaml.cs code quality** — the documented snippet or the actual file includes comments explaining **why** the license line must be in `OnStartup` (before any EPPlus API use, not in a static constructor or helper).
**Score 0.5**: Mentions build properties and CSV but without explaining effects/maintenance workflow; or App.xaml.cs works but has no explanatory comments about placement rationale.
**Score 0.0**: No build property discussion, no CSV narrative, or missing file (see header rule).

### Criterion 11: Engineering file self-documentation — XML/code comments in generated files (Weight: 4%)

**Score 1.0**: (a) **`Directory.Build.props`** contains **≥ 3 XML comments** (`<!-- ... -->`) explaining the purpose/effect of each property (e.g., why `TreatWarningsAsErrors` is enabled, what `AnalysisLevel` controls); (b) **`NuGet.config`** has an XML comment near `<clear />` explaining why it prevents machine-wide feed pollution; (c) **`App.xaml.cs`** includes a C# comment near the EPPlus license line explaining that it must execute before first EPPlus API call. All three files demonstrate that the author intended them to be maintainable by a newcomer.
**Score 0.5**: One or two of the three files have explanatory comments, but at least one generated file is bare code/XML with no documentation.
**Score 0.0**: None of the generated engineering files contain explanatory comments, or missing files (see header rule).

### Criterion 12: EPPlus license type contrast and temporal ordering (Weight: 4%)

**Score 1.0**: The reference document (or App.xaml.cs comments) explicitly contrasts **NonCommercial** vs **Commercial** EPPlus license types — explains when each applies (e.g., NonCommercial for internal/non-revenue tools, Commercial for revenue-generating products), and emphasizes the **temporal constraint**: the `LicenseContext` assignment must occur **before any EPPlus API call** (not just "in OnStartup" but explicitly "before first use"; placing it in a static constructor or helper risks out-of-order initialization). Missing or late assignment causes `LicenseException` at the first `ExcelPackage` constructor call.
**Score 0.5**: Mentions NonCommercial and the location but does not contrast with Commercial, or does not explain the temporal constraint beyond "set it in OnStartup".
**Score 0.0**: No license-type distinction, no temporal explanation, or missing file (see header rule).

### Criterion 13: Version audit — cross-registry comparison accuracy (Weight: 10%)

**Score 1.0**: `version_audit.csv` exists at the correct path with exactly 7 columns matching the prompt specification; lists **all 10** unique packages across the five version sources (including phantom packages `Logging.Abstractions` and `Configuration.Json`); every cell that should contain a version contains the **exact** version from that source (verified against the actual file contents); `selected_version` matches the approved baseline for the 8 shipped packages and is **blank** for the 2 phantom packages; the `staging_csv` column for `coverlet.collector` correctly shows `6.0.1` (not `6.0.2`, capturing the staging CSV's own internal inconsistency with the addendum). The audit implicitly demonstrates the reasoning chain by making visible that `nuget_versions_json` = `selected_version` for all approved packages.
**Score 0.5**: File exists with roughly correct structure; most approved packages have correct `selected_version` entries; but cross-reference columns contain errors (e.g., wrong version from a source, missing entries for some sources), phantom packages are missing or have non-blank `selected_version`, or the file has fewer than 8 packages.
**Score 0.0**: File missing, wrong format (fewer than 7 columns), `selected_version` column reflects draft/addendum versions instead of approved baseline, or only the 8 approved packages appear without the phantom packages.

### Criterion 14: TFM rationale — why `net8.0-windows` instead of `net8.0` (Weight: 6%)

**Score 1.0**: The reference document explicitly explains **why** the `-windows` Target Framework Moniker suffix is required — WPF projects depend on the Windows Desktop SDK (`Microsoft.NET.Sdk.WindowsDesktop` or `Microsoft.WindowsDesktop.App` runtime pack), and the `<UseWPF>true</UseWPF>` property is only available when targeting a Windows-specific TFM. Ideally notes that build hosts without the Windows SDK workload (`dotnet workload install`) or non-Windows CI runners will fail to restore/build the solution. This explanation helps a new developer understand the TFM choice rather than treating it as a magic string.
**Score 0.5**: States `net8.0-windows` is the target and mentions "because it's a WPF project" or "WPF requires Windows," but does not explain the underlying SDK dependency or what specifically breaks if `net8.0` is used alone.
**Score 0.0**: No explanation of the TFM choice — just states the value without rationale, or missing file (see header rule).

### Criterion 15: PrivateAssets semantics — transitive dependency prevention (Weight: 6%)

**Score 1.0**: Explains that `PrivateAssets="all"` on `coverlet.collector` and `xunit.runner.visualstudio` means these packages are consumed only at build/design time and are **not** exposed as transitive dependencies to any project that references the test project. Explains the MSBuild/NuGet semantic: without this attribute, NuGet would propagate these packages to downstream consumers, polluting their dependency graph with test-only tooling. Connects this to the Prompt's explicit instruction to "tag them with `PrivateAssets="all"`" and explains *why* the instruction matters, not just *that* it was followed.
**Score 0.5**: Mentions `PrivateAssets="all"` is set on those packages and says "they are build-time only" or "design-time only," but does not explain the transitive dependency prevention mechanism or why it matters.
**Score 0.0**: No explanation of PrivateAssets semantics — just sets the attribute without discussion, or missing file (see header rule).

### Criterion 16: Version conflict resolution methodology — reproducible decision process (Weight: 6%)

**Score 1.0**: Presents an **explicit, reproducible methodology** for resolving version conflicts across the five workspace sources — not merely "requirements.md wins" but a step-by-step reasoning chain that a new developer could apply to future conflicts: (1) identify the anchor version explicitly stated in `requirements.md` (DI 8.0.0); (2) cross-reference that anchor across all registries to find the matching source (`nuget_versions.json` has DI 8.0.0, status `"current"`); (3) confirm all other packages from that registry; (4) systematically reject each alternative source (draft has `8.0.1` → mismatch → reject; old has `6.0.1` → mismatch → reject; addendum says `8.0.1` → contradicts requirements.md → reject). The methodology is transferable — a reader who encounters a new package version dispute in the future could follow the same steps.
**Score 0.5**: States that requirements.md is authoritative and gives the correct conclusion, but the reasoning reads as a one-time assertion rather than a reusable methodology — a reader sees *the answer* but could not replicate the decision process for a new conflict.
**Score 0.0**: No conflict resolution discussion, just picks versions without explanation, or missing file (see header rule).
